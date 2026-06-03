import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isStale, type DecisionAtom, type RollupAtom } from "../src/engine/index.js";
import { filesAtHead, annotateStale, writeNote, readNote } from "../src/store/index.js";

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

test("filesAtHead: non-ASCII path matches verbatim (no core.quotepath C-quoting)", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "café.ts"), "1\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  const live = filesAtHead(repo);
  assert.equal(live.has("café.ts"), true, "raw UTF-8 name present, not C-quoted");
  // and an atom about that still-present file is NOT stale
  assert.equal(isStale(decisionAtom(["café.ts"]), live), false);
  rmSync(repo, { recursive: true, force: true });
});

test("annotateStale: empty live set (no HEAD / git failure) annotates nothing", () => {
  const repo = makeRepo(); // no commits -> no HEAD -> filesAtHead is empty
  const atom = decisionAtom(["anything.ts"]);
  annotateStale([atom], repo);
  // Conservative: with no live snapshot we do NOT flag — absence of evidence is
  // not evidence of deletion (guards against transient git failure flagging all).
  assert.equal(atom.stale, undefined);
  rmSync(repo, { recursive: true, force: true });
});

// --- U4: the derived flag never persists -----------------------------------

test("writeNote strips the derived `stale` flag before serializing", () => {
  const repo = makeRepo();
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const live = decisionAtom(["live.ts"]);
  live.stale = false;
  const dead = decisionAtom(["gone.ts"]);
  dead.loreId = dead.id = "a2";
  dead.stale = true;

  writeNote(sha, { v: 1, commit: sha, generatedAt: "2026-06-01T00:00:00.000Z", loreId: "x", atoms: [live, dead] }, repo);

  // raw JSON carries no `stale` key at all, and parsed atoms are undefined-stale
  const raw = execFileSync("git", ["notes", "--ref=cairn", "show", sha], { cwd: repo, encoding: "utf8" });
  assert.equal(raw.includes("\"stale\""), false);
  const payload = readNote(sha, repo);
  assert.ok(payload);
  for (const a of payload!.atoms) assert.equal(a.stale, undefined);
  // the rest of the atom survived intact (only `stale` was dropped)
  assert.deepEqual(payload!.atoms.map((a) => a.loreId).sort(), ["a1", "a2"]);
  rmSync(repo, { recursive: true, force: true });
});
