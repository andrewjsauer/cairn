#!/usr/bin/env node
/**
 * Cairn CLI — the entry point the plugin's hooks and the /decision skill call.
 *
 *   cairn open-decision "<intent>"      (from the /cairn:decision skill)
 *   cairn open-decision-stdin           (intent on stdin; the skill uses this, injection-safe)
 *   cairn open-from-plan                (PostToolUse ExitPlanMode; opens a decision from the plan)
 *   cairn journal-edit                  (PostToolUse Edit|Write|MultiEdit; reads hook JSON on stdin)
 *   cairn consolidate-if-commit         (PostToolUse Bash; consolidates iff the command was a git commit)
 *   cairn flush                         (PreCompact / SessionEnd / SessionStart; notes-only consolidation + dream if over budget)
 *   cairn dream                         (manual: global store compaction / memory consolidation)
 *   cairn consolidate                   (manual / testing: force commit-style consolidation)
 *   cairn why "<file>"                  (manual: print a file's decision chain — the human read surface)
 *   cairn recent [n]                    (manual: print the n most recent decisions)
 *
 * Hooks must never break the session, so every command exits 0 and writes
 * diagnostics to stderr. Durability is already guaranteed by the synchronous
 * journal write; consolidation is best-effort promotion.
 */
import { pathToFileURL } from "node:url";
import {
  openDecision,
  openDecisionFromPlan,
  recordEdit,
  consolidate,
  consolidateGraph,
  lastAssistantText,
} from "./capture/index.js";
import { makeComplete } from "./complete.js";
import {
  repoRoot,
  repoRelativePath,
  renamesInHistory,
  headSha,
  committerDate,
  readLastConsolidatedHead,
} from "./store/index.js";
import { recall } from "./engine/index.js";
import { allAtoms, atomsForFile } from "./read/graph.js";
import { formatChain, formatRecent } from "./mcp/format.js";
import { RECALL_TOKEN_BUDGET, DEFAULT_RECENT } from "./config.js";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** How fresh HEAD's committer timestamp must be for the recency fallback. */
const COMMIT_RECENCY_WINDOW_MS = 120_000;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "open-decision":
      return cmdOpenDecision(rest.join(" "));
    case "open-decision-stdin":
      return cmdOpenDecision(await readStdin());
    case "open-from-plan":
      return cmdOpenFromPlan();
    case "journal-edit":
      return cmdJournalEdit();
    case "consolidate-if-commit":
      return cmdConsolidateIfCommit();
    case "flush":
      return cmdFlush();
    case "dream":
      return cmdDream();
    case "consolidate":
      return cmdConsolidate();
    case "why":
      return cmdWhy(rest.join(" "));
    case "recent":
      return cmdRecent(rest[0]);
    default:
      process.stderr.write(`cairn: unknown command "${command ?? ""}"\n`);
  }
}

function projectDir(hookCwd?: string): string {
  return hookCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function cmdOpenDecision(intent: string): void {
  const trimmed = intent.trim();
  if (!trimmed) {
    process.stdout.write("cairn: no intent given; usage: /cairn:decision \"<intent>\"\n");
    return;
  }
  const record = openDecision(projectDir(), trimmed);
  process.stdout.write(
    `Cairn: opened decision ${record.id} — "${record.intent}". ` +
      `Edits from here on attach to it until the next decision opens.\n`
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface ToolOutcome {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

interface HookPayload {
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string; plan?: string };
  // Claude Code delivers the tool's result under `tool_output` (current docs)
  // — `tool_response` kept as a tolerated older spelling. Every field is
  // optional; the gate fails toward notes-only when anything is missing.
  tool_output?: ToolOutcome;
  tool_response?: ToolOutcome;
}

async function parseHookInput(): Promise<HookPayload> {
  try {
    const raw = await readStdin();
    return raw ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    return {};
  }
}

async function cmdOpenFromPlan(): Promise<void> {
  const payload = await parseHookInput();
  if (payload.tool_name !== "ExitPlanMode") return;
  const plan = payload.tool_input?.plan ?? "";
  try {
    openDecisionFromPlan(projectDir(payload.cwd), plan);
  } catch (err) {
    process.stderr.write(`cairn open-from-plan: ${(err as Error).message}\n`);
  }
}

async function cmdJournalEdit(): Promise<void> {
  const payload = await parseHookInput();
  const toolName = payload.tool_name ?? "";
  const filePath = payload.tool_input?.file_path;
  if (!EDIT_TOOLS.has(toolName) || !filePath) return; // not a file edit

  const reason = lastAssistantText(payload.transcript_path);
  try {
    recordEdit(projectDir(payload.cwd), { toolName, filePath, reason });
  } catch (err) {
    process.stderr.write(`cairn journal-edit: ${(err as Error).message}\n`);
  }
}

async function cmdConsolidateIfCommit(): Promise<void> {
  const payload = await parseHookInput();
  const command = payload.tool_input?.command ?? "";
  if (payload.tool_name !== "Bash" || !isGitCommit(command)) return;
  // Trailers are only amended when the command REALLY created the commit now
  // at HEAD; otherwise demote to a notes-only flush (journal still promoted,
  // no commit message touched, the next real commit picks everything up).
  await runConsolidate(projectDir(payload.cwd), commitLandedOnHead(payload));
}

/**
 * Gate for the commit trigger (Review C3): the command text alone is not
 * proof a commit was created. PostToolUse fires after the WHOLE compound
 * command — which can exit 0 without committing (`git commit || true`), fail
 * mid-chain, or commit in a different repo (`cd sub && git commit`). Amending
 * on a false positive rewrites the PREVIOUS, unrelated commit.
 *
 * Checks, all against the repo that would be consolidated:
 *   1. the payload's exit code, when present, must be 0;
 *   2. the summary line git prints ("[branch abc1234] …", first non-empty
 *      stdout line) must name the current HEAD; failing that (quiet commits,
 *      thin payloads), HEAD's committer timestamp must be fresh AND HEAD must
 *      differ from the last sha Cairn consolidated — recency alone is not
 *      proof, because Cairn's own amend keeps the timestamp fresh.
 * Any error fails toward notes-only: never amend on uncertainty.
 * Exported for testing.
 */
export function commitLandedOnHead(payload: HookPayload): boolean {
  try {
    const outcome = payload.tool_output ?? payload.tool_response;
    if (typeof outcome?.exit_code === "number" && outcome.exit_code !== 0) return false;
    const root = repoRoot(projectDir(payload.cwd));
    if (!root) return false;
    const head = headSha(root);
    const summary = (outcome?.stdout ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
    // Covers "[main abc1234]", "[main (root-commit) abc1234]", "[detached HEAD abc1234]".
    // Anchored to the line start so a sha-like string inside a commit MESSAGE
    // echoed later in stdout can't be mistaken for git's summary line.
    const short = summary.match(/^\[.+?([0-9a-f]{7,40})\]/)?.[1];
    if (short) return head.startsWith(short);
    const committed = Date.parse(committerDate(head, root));
    const fresh =
      Number.isFinite(committed) && Math.abs(Date.now() - committed) <= COMMIT_RECENCY_WINDOW_MS;
    return fresh && head !== readLastConsolidatedHead(root);
  } catch {
    return false;
  }
}

async function cmdFlush(): Promise<void> {
  // PreCompact / SessionEnd / SessionStart: promote the journal to the notes
  // graph (no commit to amend), so in-flight reasoning is queryable next session,
  // then "dream" — compact the whole store if it has grown past budget.
  const payload = await parseHookInput();
  const cwd = projectDir(payload.cwd);
  await runConsolidate(cwd, false);
  await runDream(cwd);
}

async function cmdDream(): Promise<void> {
  await runDream(projectDir());
}

async function runDream(cwd: string): Promise<void> {
  try {
    const result = await consolidateGraph(cwd, makeComplete());
    if (result.ok && result.rollups >= 0 && result.reason !== "within-budget" && result.before !== result.after) {
      process.stderr.write(
        `cairn: dreamt — compacted ${result.before} → ${result.after} records ` +
          `(${result.rollups} rollup(s), pruned ${result.prunedCommits} commit note(s)).\n`
      );
    }
  } catch (err) {
    process.stderr.write(`cairn dream: ${(err as Error).message}\n`);
  }
}

async function cmdConsolidate(): Promise<void> {
  await runConsolidate(projectDir());
}

/**
 * The human read surface. `why`/`recent` are agent-facing MCP tools, so the
 * developer who pays for Cairn never sees the asset accumulating. These two
 * commands print the exact same recall a fresh agent gets, so a human can read
 * (and screenshot) the reasoning trail of their own code from the terminal.
 */
function cmdWhy(file: string): void {
  const trimmed = file.trim();
  if (!trimmed) {
    process.stdout.write('cairn: no file given; usage: cairn why "<file>"\n');
    return;
  }
  const root = repoRoot(projectDir());
  if (!root) {
    process.stderr.write("cairn: not inside a git repository.\n");
    return;
  }
  const rel = repoRelativePath(root, trimmed);
  const renames = renamesInHistory(root);
  const atoms = atomsForFile(root, rel, renames);
  const result = recall(atoms, { file: rel, tokenBudget: RECALL_TOKEN_BUDGET, renames });
  process.stdout.write(formatChain(rel, result) + "\n");
}

function cmdRecent(arg?: string): void {
  const root = repoRoot(projectDir());
  if (!root) {
    process.stderr.write("cairn: not inside a git repository.\n");
    return;
  }
  const parsed = arg ? Number.parseInt(arg, 10) : NaN;
  const count = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RECENT;
  const atoms = allAtoms(root);
  const result = recall(atoms, { recent: count, tokenBudget: RECALL_TOKEN_BUDGET });
  process.stdout.write(formatRecent(count, result) + "\n");
}

/**
 * Match a real `git commit` that CREATES a commit. Anchored per command segment
 * so it does not fire on `git commit-graph`, `git log | grep commit`, or a
 * trailing `# commit` comment. The `--amend` (rewrites, doesn't create) and
 * `--dry-run` exclusions apply only to the MATCHED segment with quoted spans
 * removed — a commit whose message merely mentions "--amend", or a sibling
 * segment that amends, must not mask a real commit. (`git -C dir commit` and
 * `git -c k=v commit` are accepted misses: the journal survives to the next
 * trigger.) Exported for testing.
 */
export function isGitCommit(command: string): boolean {
  return command.split(/&&|\|\||[;|&\n]/).some((seg) => {
    if (!/^\s*git\s+commit(\s|$)/.test(seg)) return false;
    const unquoted = seg.replace(/"[^"]*"|'[^']*'/g, "");
    return !/\s--amend\b/.test(unquoted) && !/\s--dry-run\b/.test(unquoted);
  });
}

async function runConsolidate(cwd: string, writeTrailers = true): Promise<void> {
  try {
    const result = await consolidate(cwd, makeComplete(), { writeTrailers });
    if (result.ok && result.written > 0) {
      process.stderr.write(
        `cairn: consolidated ${result.written} decision(s) at ${result.commit?.slice(0, 8)} ` +
          `(lore-id ${result.loreId}${result.amended ? ", trailers amended" : ", note only"}).\n`
      );
    }
  } catch (err) {
    process.stderr.write(`cairn consolidate: ${(err as Error).message}\n`);
  }
}

// Only run when invoked directly (not when imported by a test).
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`cairn: ${(err as Error).message}\n`);
      process.exit(0); // never break the session
    }
  );
}
