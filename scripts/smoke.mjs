/**
 * End-to-end smoke test of the COMPILED artifacts (dist/), with a fake complete()
 * so it runs without an API key:
 *   - the CLI hook contract (open-decision, journal-edit via stdin)
 *   - compiled consolidation -> Lore trailers + refs/notes/cairn
 *   - the real MCP server binary driven over stdio via the MCP SDK client
 *
 * Run: node scripts/smoke.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { consolidate } from "../dist/capture/index.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(ROOT, "dist", "cli.js");
const SERVER = join(ROOT, "dist", "mcp", "server.js");

const fakeComplete = async (prompt) => {
  if (prompt.includes("Cluster them")) return JSON.stringify({ clusters: [] });
  if (prompt.startsWith("Summarize these related decisions")) return JSON.stringify({ summary: "rollup" });
  return JSON.stringify({
    intent: "retry transient upstream failures twice before failing",
    summary:
      "The client retries the upstream call up to two times with backoff, because the upstream cold-starts slowly and a single attempt produced spurious user-facing 503s.",
    constraints: ["upstream cold-start can exceed 500ms", "no idempotency key available"],
    rejected: [
      { alternative: "fail fast with no retry", reason: "caused spurious user-facing errors on cold start" },
      { alternative: "retry 5 times", reason: "amplified load during incidents" },
    ],
    confidence: "high",
  });
};

function git(repo, args, input) {
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8" }).trim();
}

function run(args, { cwd, input }) {
  const r = spawnSync("node", [CLI, ...args], { cwd, input, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr };
}

function ok(label, cond) {
  console.log(`${cond ? "✔" : "✖"} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const repo = mkdtempSync(join(tmpdir(), "cairn-smoke-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "smoke@cairn.dev"]);
  git(repo, ["config", "user.name", "Smoke"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "root"]);

  // 1. /cairn:decision -> open-decision (no model).
  const opened = run(["open-decision", "retry transient upstream failures twice before failing"], { cwd: repo });
  ok("open-decision prints confirmation", /opened decision/.test(opened.out));

  // 2. PostToolUse edit hook contract: feed a real payload on stdin.
  mkdirSync(join(repo, "src"), { recursive: true });
  const file = join(repo, "src", "client.ts");
  writeFileSync(file, "export function call() { /* retry x2 with backoff */ }\n");
  const hookPayload = JSON.stringify({
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: file },
    transcript_path: "",
  });
  run(["journal-edit"], { cwd: repo, input: hookPayload });
  const journal = git(repo, ["rev-parse", "--git-dir"]);
  const journalEntries = spawnSync("cat", [join(repo, journal, "cairn", "journal.jsonl")], { encoding: "utf8" }).stdout || "";
  ok("edit hook wrote a durable journal entry to .git/cairn/", journalEntries.includes("src/client.ts"));

  // 3. Commit + consolidate (compiled, fake model).
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: add retry to client"]);
  const result = await consolidate(repo, fakeComplete, { now: "2026-05-25T12:00:00.000Z" });
  ok("consolidate wrote 1 decision", result.written === 1);

  // 4. Interop: git's own parser reads our trailers.
  const message = git(repo, ["show", "-s", "--format=%B", "HEAD"]);
  const parsed = git(repo, ["interpret-trailers", "--parse"], message);
  ok("git interpret-trailers sees Lore-id", /^Lore-id: [0-9a-f]{8}$/m.test(parsed));
  ok("trailers carry Rejected with pipe separator", /^Rejected: .+ \| .+$/m.test(parsed));

  // 5. Drive the REAL MCP server over stdio with the SDK client.
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  const client = new Client({ name: "cairn-smoke", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  ok("MCP server exposes exactly why + recent", JSON.stringify(names) === JSON.stringify(["recent", "why"]));

  const why = await client.callTool({ name: "why", arguments: { file: "src/client.ts" } });
  const whyText = why.content[0].text;
  ok("why(file) returns the decision chain", /retry transient upstream failures/.test(whyText));
  ok("why(file) surfaces a rejected alternative", /rejected: fail fast/.test(whyText));

  const recent = await client.callTool({ name: "recent", arguments: { n: 5 } });
  ok("recent(n) returns decisions", /retry transient upstream failures/.test(recent.content[0].text));

  await client.close();

  console.log("\n--- BEFORE/AFTER illustration (mechanism) ---\n");
  console.log("BARE session, asked 'why does src/client.ts retry twice?' — only has git:");
  console.log("  $ git log -1 --format='%s' -- src/client.ts");
  console.log("  " + git(repo, ["log", "-1", "--format=%s", "--", "src/client.ts"]));
  console.log("  (the diff shows the retry exists; nothing says WHY 2 and not 0 or 5)\n");
  console.log("CAIRN session, same question via why('src/client.ts'):\n");
  console.log(whyText.split("\n").map((l) => "  " + l).join("\n"));

  console.log(`\nsmoke repo: ${repo}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
