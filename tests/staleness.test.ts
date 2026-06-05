import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isStale, resolveRename, type DecisionAtom, type RollupAtom } from "../src/engine/index.js";
import { filesAtHead, renamesInHistory, annotateStale, writeNote, readNote } from "../src/store/index.js";

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

// --- rename resolution -------------------------------------------------------

test("resolveRename: follows a chain to the current name", () => {
  const renames = new Map([["a.ts", "b.ts"], ["b.ts", "c.ts"]]);
  assert.equal(resolveRename("a.ts", renames), "c.ts");
  assert.equal(resolveRename("b.ts", renames), "c.ts");
  assert.equal(resolveRename("untouched.ts", renames), "untouched.ts");
  assert.equal(resolveRename("a.ts", undefined), "a.ts");
});

test("resolveRename: a rename cycle terminates instead of looping", () => {
  const renames = new Map([["a.ts", "b.ts"], ["b.ts", "a.ts"]]);
  assert.equal(resolveRename("a.ts", renames), "b.ts");
});

test("isStale: a renamed-but-live file rescues the atom", () => {
  const live = new Set(["c.ts"]);
  const renames = new Map([["a.ts", "b.ts"], ["b.ts", "c.ts"]]);
  assert.equal(isStale(decisionAtom(["a.ts"]), live, renames), false, "renamed, not deleted");
  assert.equal(isStale(decisionAtom(["gone.ts"]), live, renames), true, "truly deleted stays stale");
});

test("renamesInHistory: parses git mv history, newest rename wins per old path", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "content\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  execFileSync("git", ["mv", "a.ts", "b.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "a -> b"], { cwd: repo });
  execFileSync("git", ["mv", "b.ts", "c.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "b -> c"], { cwd: repo });

  const renames = renamesInHistory(repo);
  assert.equal(renames.get("a.ts"), "b.ts");
  assert.equal(renames.get("b.ts"), "c.ts");
  // the chain resolves to the live current name
  assert.equal(resolveRename("a.ts", renames), "c.ts");
  assert.equal(filesAtHead(repo).has("c.ts"), true);
  rmSync(repo, { recursive: true, force: true });
});

test("renamesInHistory: a renamed-away path that was RECREATED is its own canonical name", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "original\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  execFileSync("git", ["mv", "a.ts", "b.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "a -> b"], { cwd: repo });
  // Recreate a.ts as a brand-new, unrelated file.
  writeFileSync(join(repo, "a.ts"), "totally new content\n");
  execFileSync("git", ["add", "a.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "new a.ts"], { cwd: repo });

  const renames = renamesInHistory(repo);
  // a.ts is live at HEAD, so it must NOT resolve to b.ts — otherwise the new
  // file's chain would leak into why(b.ts) and vice versa.
  assert.equal(renames.has("a.ts"), false);
  assert.equal(resolveRename("a.ts", renames), "a.ts");
  rmSync(repo, { recursive: true, force: true });
});

test("renamesInHistory: empty for a repo with no renames (and no HEAD)", () => {
  const repo = makeRepo();
  assert.equal(renamesInHistory(repo).size, 0); // no HEAD
  writeFileSync(join(repo, "a.ts"), "1\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  assert.equal(renamesInHistory(repo).size, 0); // history, no renames
  rmSync(repo, { recursive: true, force: true });
});

test("annotateStale: rename rescue — renamed file not stale, deleted file stays stale", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "moved.ts"), "will move\n");
  writeFileSync(join(repo, "dead.ts"), "will die\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  execFileSync("git", ["mv", "moved.ts", "renamed.ts"], { cwd: repo });
  execFileSync("git", ["rm", "-q", "dead.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "move + delete"], { cwd: repo });

  const movedAtom = decisionAtom(["moved.ts"]);
  const deadAtom = decisionAtom(["dead.ts"]);
  deadAtom.loreId = deadAtom.id = "a2";
  annotateStale([movedAtom, deadAtom], repo);

  assert.equal(movedAtom.stale, false, "renamed-but-live file is rescued");
  assert.equal(deadAtom.stale, true, "deleted file is still stale");
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

test("writeNote strips the derived `stale` and `reverted` flags before serializing", () => {
  const repo = makeRepo();
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: repo });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const live = decisionAtom(["live.ts"]);
  live.stale = false;
  const dead = decisionAtom(["gone.ts"]);
  dead.loreId = dead.id = "a2";
  dead.stale = true;
  dead.reverted = true;

  writeNote(sha, { v: 1, commit: sha, generatedAt: "2026-06-01T00:00:00.000Z", loreId: "x", atoms: [live, dead] }, repo);

  // raw JSON carries neither derived key, and parsed atoms have them undefined
  const raw = execFileSync("git", ["notes", "--ref=cairn", "show", sha], { cwd: repo, encoding: "utf8" });
  assert.equal(raw.includes("\"stale\""), false);
  assert.equal(raw.includes("\"reverted\""), false);
  const payload = readNote(sha, repo);
  assert.ok(payload);
  for (const a of payload!.atoms) {
    assert.equal(a.stale, undefined);
    assert.equal(a.reverted, undefined);
  }
  // the rest of the atom survived intact (only derived flags were dropped)
  assert.deepEqual(payload!.atoms.map((a) => a.loreId).sort(), ["a1", "a2"]);
  rmSync(repo, { recursive: true, force: true });
});
