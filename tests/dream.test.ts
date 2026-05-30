import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDecision, recordEdit, consolidate, consolidateGraph } from "../src/capture/index.js";
import { readAllAtoms } from "../src/store/index.js";
import { atomsForFile } from "../src/mcp/graph.js";
import { recall, isRollupAtom, type Complete } from "../src/engine/index.js";

/**
 * The "dream" — global store compaction. Builds a multi-commit graph, then
 * compacts it under a tiny budget and verifies the store is bounded while
 * coverage is preserved (nothing a file needs is lost).
 */

function gitC(repo: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cairn-dream-"));
  gitC(repo, ["init", "-q"]);
  gitC(repo, ["config", "user.email", "t@cairn.dev"]);
  gitC(repo, ["config", "user.name", "T"]);
  gitC(repo, ["commit", "-q", "--allow-empty", "-m", "root"]);
  return repo;
}

const fake: Complete = async (prompt) => {
  if (prompt.includes("Cluster them")) return JSON.stringify({ clusters: [] });
  if (prompt.startsWith("Summarize these related decisions")) {
    return JSON.stringify({ summary: "compacted arc of several related decisions" });
  }
  return JSON.stringify({
    intent: "a decision",
    summary: "some reasoning here that is reasonably long so atoms have real token weight",
    constraints: ["a constraint"],
    rejected: [{ alternative: "an alternative", reason: "a reason" }],
    confidence: "medium",
  });
};

test("the dream compacts the store under budget while preserving per-file coverage", async () => {
  const repo = makeRepo();

  // Five decisions across five commits: three touch core.ts, two touch util.ts.
  const files = ["core.ts", "core.ts", "core.ts", "util.ts", "util.ts"];
  for (let i = 0; i < files.length; i++) {
    const now = `2026-05-${10 + i}T00:00:00.000Z`;
    openDecision(repo, `decision ${i} about ${files[i]}`, [], now);
    writeFileSync(join(repo, files[i]), `// rev ${i}\n`);
    recordEdit(repo, { toolName: "Write", filePath: join(repo, files[i]), reason: `change ${i}`, ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", `feat: ${files[i]} #${i}`]);
    await consolidate(repo, fake, { now });
  }

  assert.equal(readAllAtoms(repo).length, 5, "five level-0 atoms across five commit notes");

  // Dream with a tiny budget to force compaction.
  const result = await consolidateGraph(repo, fake, { budget: 10, now: "2026-06-01T00:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.before, 5);
  assert.ok(result.after < result.before, "the store shrank");
  assert.ok(result.rollups >= 1, "produced rollup(s)");

  // The notes store is now bounded (rollups in the ledger, old level-0 pruned).
  const stored = readAllAtoms(repo).map((x) => x.atom);
  assert.equal(stored.length, result.after, "stored atom count matches the result");
  assert.ok(stored.some(isRollupAtom), "the compacted graph is in the store");

  // Coverage preserved: both files still resolve to a recorded decision, and a
  // rollup carries the compacted arc.
  const core = atomsForFile(repo, "core.ts");
  const util = atomsForFile(repo, "util.ts");
  assert.ok(core.length >= 1, "core.ts still has recorded reasoning after the dream");
  assert.ok(util.length >= 1, "util.ts still has recorded reasoning after the dream");
  assert.ok(core.some(isRollupAtom), "core.ts decisions were compacted into a rollup");

  // why() still returns something readable and budget-bounded.
  const why = recall(core, { file: "core.ts", tokenBudget: 2000 });
  assert.ok(why.atoms.length >= 1);
});

test("the dream is a no-op when the store is already under budget", async () => {
  const repo = makeRepo();
  openDecision(repo, "one small decision", [], "2026-05-10T00:00:00.000Z");
  writeFileSync(join(repo, "a.ts"), "x\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r", ts: "2026-05-10T00:00:00.000Z" });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: a"]);
  await consolidate(repo, fake, { now: "2026-05-10T00:00:00.000Z" });

  const before = readAllAtoms(repo).length;
  const result = await consolidateGraph(repo, fake, {}); // default large budget
  assert.equal(result.reason, "within-budget");
  assert.equal(readAllAtoms(repo).length, before, "nothing changed");
});
