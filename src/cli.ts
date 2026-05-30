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

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

interface HookPayload {
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; command?: string; plan?: string };
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
  await runConsolidate(projectDir(payload.cwd));
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
 * Match a real `git commit` that CREATES a commit. Anchored per command segment
 * so it does not fire on `git commit-graph`, `git log | grep commit`, or a
 * trailing `# commit` comment, and excludes `--amend` (rewrites, doesn't create)
 * and `--dry-run`. Exported for testing.
 */
export function isGitCommit(command: string): boolean {
  if (/--amend\b/.test(command) || /--dry-run\b/.test(command)) return false;
  // Split on shell segment separators and require a segment that starts with
  // `git commit` followed by end-or-whitespace (so `commit-graph` won't match).
  return command
    .split(/&&|\|\||[;|&\n]/)
    .some((seg) => /^\s*git\s+commit(\s|$)/.test(seg));
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
