/**
 * Deterministic local verification gate — proves Cairn does what it claims,
 * with no agents and no API key. Runs the build, the test suite, the real
 * MCP-server smoke run, and a set of structural assertions tied to the brief's
 * acceptance criteria and non-goals. Exits non-zero on any failure.
 *
 *   npm run verify
 *
 * The multi-agent, adversarial version is the `verify-cairn` workflow
 * (scripts/verify-cairn.workflow.js) — run that for a deeper, narrated audit.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;

function pass(label, detail = "") {
  console.log(`\x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
function fail(label, detail = "") {
  console.log(`\x1b[31m✗\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  failures++;
}

function run(label, cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status === 0) pass(label);
  else fail(label, (out.trim().split("\n").pop() || `exit ${r.status}`).slice(0, 120));
  return out;
}

function assert(label, cond, detail = "") {
  cond ? pass(label, detail) : fail(label, detail);
}

function tsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : n.endsWith(".ts") ? [p] : [];
  });
}

console.log("\n\x1b[1mCairn — local verification\x1b[0m\n");

// --- 1. Build + test + smoke (the behavioral gates) ---
run("build (tsc)", ["npm", "run", "build"]);

const testOut = run("test suite", ["npm", "test"]);
const m = testOut.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
if (m) assert("  all tests pass", m[2] === "0", `${m[1]} pass, ${m[2]} fail`);

run("smoke: real MCP server over stdio (why/recent)", ["node", "scripts/smoke.mjs"]);

// --- 2. Engine decoupling (allowlist: engine may import ONLY its own ./ modules) ---
const specOf = (l) =>
  (l.match(/\bfrom\s*["']([^"']+)["']/) || l.match(/\bimport\s*\(\s*["']([^"']+)["']/) ||
   l.match(/\brequire\(\s*["']([^"']+)["']/) || l.match(/^\s*import\s+["']([^"']+)["']/) || [])[1] ?? null;
const engineViolations = tsFiles(join(ROOT, "src", "engine")).flatMap((f) =>
  readFileSync(f, "utf8").split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /^\s*export\b[^;]*\bfrom\b/.test(l) || /\bimport\s*\(/.test(l) || /\brequire\(/.test(l))
    .map(specOf).filter((s) => s && !s.startsWith("./"))
    .map((s) => `${f}: imports "${s}"`)
);
assert("engine imports only its own ./ modules (no git/CC/store/SDK)", engineViolations.length === 0, engineViolations[0] || "");

// --- 3. Read surface = exactly why + recent (non-goal: no search/summary) ---
const server = readFileSync(join(ROOT, "src", "mcp", "server.ts"), "utf8");
const tools = [...server.matchAll(/registerTool\(\s*["'](\w+)["']/g)].map((x) => x[1]).sort();
assert("MCP exposes exactly [recent, why]", JSON.stringify(tools) === '["recent","why"]', tools.join(", "));

// --- 4. Non-goals: no timer/daemon, no backend/db/web deps ---
const allSrc = tsFiles(join(ROOT, "src")).map((f) => readFileSync(f, "utf8")).join("\n");
assert("no background timer/daemon (setInterval/cron)", !/\bsetInterval\b|\bcron\b/.test(allSrc));
const deps = Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies || {});
const banned = deps.filter((d) => /express|fastify|hono|cors|pg|mysql|mongo|sqlite|prisma|passport|jsonwebtoken/i.test(d));
assert("no backend/db/web/auth direct dependencies", banned.length === 0, banned.join(", ") || "deps: " + deps.join(", "));

// --- 5. Lore interop: git's own parser reads a Cairn-produced trailer block ---
// No shell: arg arrays + stdin pipe, so nothing is interpolated into a command string.
{
  let tmp;
  try {
    tmp = mkdtempSync(join(tmpdir(), "cairn-verify-"));
    const git = (args, input) =>
      execFileSync("git", ["-C", tmp, ...args], { input, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "v@v.v"]);
    git(["config", "user.name", "v"]);
    git(["commit", "-q", "--allow-empty", "-F", "-"],
      "feat: x\n\nLore-id: deadbeef\nConstraint: c\nRejected: A | B\nConfidence: high\n");
    const message = git(["show", "-s", "--format=%B", "HEAD"]);
    const parsed = execFileSync("git", ["interpret-trailers", "--parse"], { input: message, encoding: "utf8" });
    assert("Lore trailers parse via git interpret-trailers",
      /^Lore-id: deadbeef$/m.test(parsed) && /^Rejected: A \| B$/m.test(parsed));
  } catch (e) {
    fail("Lore interop check", String(e).slice(0, 100));
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Summary ---
console.log("");
if (failures === 0) {
  console.log("\x1b[32m\x1b[1mVERIFIED\x1b[0m — all behavioral and structural checks passed.\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m${failures} check(s) FAILED.\x1b[0m\n`);
  process.exit(1);
}
