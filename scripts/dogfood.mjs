/**
 * Guided dogfood: fire EVERY Cairn trigger the way Claude Code would, against a
 * throwaway git repo, so you can watch each hook work before trusting it in a
 * live session. Each step pipes a realistic hook payload to the compiled CLI
 * (exactly what hooks/hooks.json runs) and then shows the durable effect.
 *
 *   node scripts/dogfood.mjs
 *
 * Uses real Haiku if ANTHROPIC_API_KEY is set (you'll see real synthesis);
 * otherwise it falls back to deterministic records (recorded intent + raw
 * reasons) and says so. Never touches your real repos — it builds a temp one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { consolidateGraph } from "../dist/capture/index.js";
import { makeComplete } from "../dist/complete.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "dist", "cli.js");
const SERVER = join(ROOT, "dist", "mcp", "server.js");
const HASKEY = Boolean(process.env.ANTHROPIC_API_KEY);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function git(repo, args, input) {
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8" }).trim();
}

/** Run a hook exactly as hooks/hooks.json would: `node dist/cli.js <sub>` with JSON on stdin. */
function fireHook(repo, label, event, sub, payload) {
  console.log(`\n${c.bold("▶ " + label)}`);
  console.log(c.dim(`  Claude Code event: ${event}`));
  console.log(c.dim(`  runs: node dist/cli.js ${sub}   (payload on stdin)`));
  const r = spawnSync("node", [CLI, sub], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  if (r.stdout?.trim()) console.log("  " + c.green(r.stdout.trim().replace(/\n/g, "\n  ")));
  if (r.stderr?.trim()) console.log("  " + c.cyan("cairn: " + r.stderr.trim().replace(/^cairn:\s*/, "")));
}

function show(label, value) {
  console.log(c.dim(`    ${label}: `) + value);
}

function cairnDir(repo) {
  // `git rev-parse --git-dir` returns a path relative to the repo; resolve it.
  return resolve(repo, git(repo, ["rev-parse", "--git-dir"]), "cairn");
}

async function readViaMcp(repo, file) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  const client = new Client({ name: "cairn-dogfood", version: "0.1.0" });
  await client.connect(transport);
  const why = await client.callTool({ name: "why", arguments: { file } });
  const recent = await client.callTool({ name: "recent", arguments: { n: 5 } });
  await client.close();
  return { why: why.content[0].text, recent: recent.content[0].text };
}

async function main() {
  console.log(c.bold("\nCairn dogfood — firing every trigger against a throwaway repo\n"));
  console.log(HASKEY ? c.green("ANTHROPIC_API_KEY detected → real Haiku synthesis.") : c.yellow("No ANTHROPIC_API_KEY → deterministic fallback records (set the key to see real synthesis)."));

  if (!existsSync(CLI)) {
    console.log(c.yellow("\ndist/ not built. Run `npm run build` first."));
    process.exit(1);
  }

  // Throwaway repo.
  const repo = mkdtempSync(join(tmpdir(), "cairn-dogfood-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "you@example.com"]);
  git(repo, ["config", "user.name", "You"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "chore: init"]);
  console.log(c.dim(`\nScratch repo: ${repo}`));

  // 1. Plan approved → PostToolUse(ExitPlanMode) → open-from-plan
  fireHook(repo, "1. You approve a plan", "PostToolUse(ExitPlanMode)", "open-from-plan", {
    cwd: repo,
    tool_name: "ExitPlanMode",
    tool_input: {
      plan: "# Retry the upstream client twice before failing\n\nThe upstream cold-starts slowly; a single attempt produces spurious 503s.",
    },
  });
  show("active decision", readFileSync(join(cairnDir(repo), "active-decision"), "utf8"));

  // 2. Agent edits a file → PostToolUse(Write) → journal-edit
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "client.ts"), "export function call() { /* retry x2 */ }\n");
  fireHook(repo, "2. Agent edits src/client.ts", "PostToolUse(Write)", "journal-edit", {
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: join(repo, "src", "client.ts") },
    transcript_path: "",
  });
  const journal = join(cairnDir(repo), "journal.jsonl");
  show("journal entry on disk (survives /clear)", existsSync(journal) ? c.green("yes") : "no");

  // 3. You commit → PostToolUse(Bash, git commit) → consolidate-if-commit
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: add retry to client"]);
  fireHook(repo, "3. You commit", "PostToolUse(Bash: git commit)", "consolidate-if-commit", {
    cwd: repo,
    tool_name: "Bash",
    tool_input: { command: "git commit -m 'feat: add retry to client'" },
  });
  console.log(c.dim("    → Lore trailers written onto the commit:"));
  const trailers = git(repo, ["interpret-trailers", "--parse"], git(repo, ["show", "-s", "--format=%B", "HEAD"]));
  console.log(trailers.split("\n").map((l) => "      " + l).join("\n") || "      (none)");
  show("git note on HEAD", git(repo, ["notes", "--ref=cairn", "list"]) ? c.green("present") : "none");
  show("journal cleared after commit", existsSync(journal) ? "still present" : c.green("yes"));

  // 4. An uncommitted edit, then compaction/session-end → flush (notes-only).
  // The /cairn:decision skill runs `open-decision-stdin` with the intent on stdin.
  console.log(`\n${c.bold("▶ 4a. Manual /cairn:decision (the other open path)")}`);
  console.log(c.dim("  the skill runs: node dist/cli.js open-decision-stdin   (intent on stdin, injection-safe)"));
  {
    const r = spawnSync("node", [CLI, "open-decision-stdin"], {
      cwd: repo,
      input: "cache results in-memory to cut latency",
      encoding: "utf8",
    });
    if (r.stdout?.trim()) console.log("  " + c.green(r.stdout.trim()));
  }
  writeFileSync(join(repo, "src", "cache.ts"), "export const cache = new Map();\n");
  fireHook(repo, "4b. Agent edits src/cache.ts (not committed yet)", "PostToolUse(Write)", "journal-edit", {
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: join(repo, "src", "cache.ts") },
    transcript_path: "",
  });
  const headBefore = git(repo, ["rev-parse", "HEAD"]);
  fireHook(repo, "4c. Context about to compact (or session ends)", "PreCompact / SessionEnd", "flush", {
    cwd: repo,
    trigger: "auto",
  });
  show("HEAD rewritten by flush?", git(repo, ["rev-parse", "HEAD"]) === headBefore ? c.green("no (notes-only, as designed)") : "YES (unexpected)");
  show("cache.ts decision now in the notes graph", git(repo, ["notes", "--ref=cairn", "list"]).split("\n").length + " note(s)");

  // 5. Fresh session reads it back over the REAL MCP server
  console.log(`\n${c.bold("▶ 5. A fresh session asks Cairn (real MCP server over stdio)")}`);
  const { why, recent } = await readViaMcp(repo, "src/client.ts");
  console.log(c.dim("\n  why('src/client.ts'):\n"));
  console.log(why.split("\n").map((l) => "    " + l).join("\n"));
  console.log(c.dim("\n  recent(5):\n"));
  console.log(recent.split("\n").map((l) => "    " + l).join("\n"));

  // 6. The dream (memory consolidation). Forced here with a tiny budget so it
  //    fires on this small store; in real use it runs at session end/start (or
  //    `cairn dream`) only once the store has grown past STORE_TOKEN_BUDGET.
  console.log(`\n${c.bold("▶ 6. Sleep-time: the dream (global store compaction)")}`);
  console.log(c.dim("  runs at SessionEnd/Start when the store exceeds budget — forced here with a tiny budget"));
  const beforeAtoms = git(repo, ["notes", "--ref=cairn", "list"]).split("\n").filter(Boolean).length;
  const dreamt = await consolidateGraph(repo, makeComplete(), { budget: 10 });
  console.log("  " + c.green(`dreamt — ${dreamt.before} → ${dreamt.after} records, ${dreamt.rollups} rollup(s), pruned ${dreamt.prunedCommits} commit note(s)`));
  show("rollup ledger on the empty-tree anchor", git(repo, ["notes", "--ref=cairn", "list"]).split("\n").filter(Boolean).length + " note(s) (was " + beforeAtoms + ")");
  const stillThere = await readViaMcp(repo, "src/client.ts");
  show("why('src/client.ts') after the dream", /No recorded/.test(stillThere.why) ? "LOST (bug!)" : c.green("still answers (coverage preserved)"));

  // Before/after
  console.log(`\n${c.bold("— Before / after —")}`);
  console.log(c.dim("  BARE session has only: ") + git(repo, ["log", "-1", "--format=%s", "--", "src/client.ts"]));
  console.log(c.dim("  CAIRN session also knows the constraint and the rejected alternatives (above)."));

  console.log(`\n${c.green("✓ Every trigger fired.")} Scratch repo left at:\n  ${repo}`);
  console.log(c.dim("  Inspect: git -C <repo> log --format=%B -1 | cat   /   git -C <repo> notes --ref=cairn show HEAD\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
