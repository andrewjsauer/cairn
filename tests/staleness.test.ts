import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isStale, type DecisionAtom, type RollupAtom } from "../src/engine/index.js";
import { filesAtHead } from "../src/store/index.js";

/**
 * Structural staleness: the pure rule (engine, no git) plus the HEAD snapshot
 * (store, the only git surface staleness adds).
 */

function decisionAtom(files: string[]): DecisionAtom {
  return {
    id: "a1",
    loreId: "a1",
    level: 0,
    decisionId: "d1",
    intent: "intent",
    summary: "summary",
    files,
    constraints: [],
    rejected: [],
    confidence: "high",
    supersedes: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    sourceIds: [],
  };
}

function rollupAtom(files: string[]): RollupAtom {
  return {
    id: "r1",
    loreId: "r1",
    level: 1,
    summary: "rolled up",
    files,
    createdAt: "2026-06-01T00:00:00.000Z",
    sourceIds: ["a1", "a2"],
  };
}

// --- the pure rule ---------------------------------------------------------

test("isStale: all files absent from HEAD -> stale", () => {
  const live = new Set(["other.ts"]);
  assert.equal(isStale(decisionAtom(["gone.ts", "also-gone.ts"]), live), true);
});

test("isStale: at least one file still live -> not stale", () => {
  const live = new Set(["kept.ts"]);
  assert.equal(isStale(decisionAtom(["gone.ts", "kept.ts"]), live), false);
});

test("isStale: empty files list -> never stale", () => {
  assert.equal(isStale(decisionAtom([]), new Set()), false);
});

test("isStale: rollup with all union files gone -> stale", () => {
  const live = new Set(["live.ts"]);
  assert.equal(isStale(rollupAtom(["gone-a.ts", "gone-b.ts"]), live), true);
});

test("isStale: rollup with one live file -> not stale", () => {
  const live = new Set(["gone-b.ts is not here", "live.ts"]);
  assert.equal(isStale(rollupAtom(["gone-a.ts", "live.ts"]), live), false);
});

// --- the HEAD snapshot -----------------------------------------------------

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cairn-stale-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@cairn.dev"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
  return repo;
}

test("filesAtHead: returns exactly the tracked paths", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "1\n");
  writeFileSync(join(repo, "b.ts"), "2\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const live = filesAtHead(repo);
  assert.deepEqual([...live].sort(), ["a.ts", "b.ts"]);
  rmSync(repo, { recursive: true, force: true });
});

test("filesAtHead: a deleted-and-committed path is absent", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "1\n");
  writeFileSync(join(repo, "b.ts"), "2\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  execFileSync("git", ["rm", "-q", "a.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "drop a"], { cwd: repo });

  const live = filesAtHead(repo);
  assert.equal(live.has("a.ts"), false);
  assert.equal(live.has("b.ts"), true);
  // and the rule built on top sees the deleted file's atom as stale
  assert.equal(isStale(decisionAtom(["a.ts"]), live), true);
  assert.equal(isStale(decisionAtom(["b.ts"]), live), false);
  rmSync(repo, { recursive: true, force: true });
});

test("filesAtHead: empty repo with no HEAD -> empty set, no throw", () => {
  const repo = makeRepo();
  const live = filesAtHead(repo);
  assert.equal(live.size, 0);
  rmSync(repo, { recursive: true, force: true });
});
