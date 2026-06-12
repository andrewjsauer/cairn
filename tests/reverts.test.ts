import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { netRevertedShas, type RevertEdge } from "../src/engine/index.js";
import { revertEdgesInHistory } from "../src/store/index.js";
import { gitC, makeRepo as sharedMakeRepo } from "./helpers/repo.js";

/**
 * Revert detection: the pure net-status resolver (engine, no git) and the
 * one-call edge extraction (store, the only git surface this feature adds).
 */

// --- the pure resolver -------------------------------------------------------

test("netRevertedShas: a single revert marks the commit net-reverted", () => {
  const edges: RevertEdge[] = [{ reverter: "r".repeat(40), reverted: "s".repeat(40) }];
  const net = netRevertedShas(edges);
  assert.equal(net.has("s".repeat(40)), true);
});

test("netRevertedShas: revert-of-revert re-lands the original", () => {
  const S = "1".repeat(40), R1 = "2".repeat(40), R2 = "3".repeat(40);
  const net = netRevertedShas([
    { reverter: R1, reverted: S },
    { reverter: R2, reverted: R1 },
  ]);
  assert.equal(net.has(S), false, "original re-landed");
  assert.equal(net.has(R1), true, "the first revert is itself undone");
});

test("netRevertedShas: two reverters, one itself reverted -> still net-reverted", () => {
  const S = "1".repeat(40), R1 = "2".repeat(40), R2 = "3".repeat(40), R3 = "4".repeat(40);
  const net = netRevertedShas([
    { reverter: R1, reverted: S },
    { reverter: R2, reverted: S },
    { reverter: R3, reverted: R1 }, // kills R1; R2 still stands
  ]);
  assert.equal(net.has(S), true, "S stays reverted via the surviving reverter");
});

test("netRevertedShas: empty edges -> empty set", () => {
  assert.equal(netRevertedShas([]).size, 0);
});

// --- edge extraction from real git -------------------------------------------

const makeRepo = () => sharedMakeRepo({ prefix: "cairn-revert-", rootCommit: false });

test("revertEdgesInHistory: standard revert yields a full-SHA edge", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.ts"), "v1\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", "feat: approach A"]);
  const original = gitC(repo, ["rev-parse", "HEAD"]);
  gitC(repo, ["revert", "--no-edit", "HEAD"]);
  const reverter = gitC(repo, ["rev-parse", "HEAD"]);

  const edges = revertEdgesInHistory(repo);
  assert.deepEqual(edges, [{ reverter, reverted: original }]);
  rmSync(repo, { recursive: true, force: true });
});

test("revertEdgesInHistory: --reference abbreviated SHA resolves via prefix", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.ts"), "v1\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", "feat: approach A"]);
  const original = gitC(repo, ["rev-parse", "HEAD"]);
  // --reference writes "This reverts commit <abbrev> (subject, date)."
  execFileSync("git", ["revert", "--no-edit", "--reference", "HEAD"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

  const edges = revertEdgesInHistory(repo);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].reverted, original, "abbreviated prefix resolved to the full SHA");
  rmSync(repo, { recursive: true, force: true });
});

test("revertEdgesInHistory: revert-of-revert yields both edges; resolver clears the original", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.ts"), "v1\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", "feat: approach A"]);
  const original = gitC(repo, ["rev-parse", "HEAD"]);
  gitC(repo, ["revert", "--no-edit", "HEAD"]);
  const firstRevert = gitC(repo, ["rev-parse", "HEAD"]);
  gitC(repo, ["revert", "--no-edit", "HEAD"]);

  const edges = revertEdgesInHistory(repo);
  assert.equal(edges.length, 2);
  const net = netRevertedShas(edges);
  assert.equal(net.has(original), false, "re-landed");
  assert.equal(net.has(firstRevert), true);
  rmSync(repo, { recursive: true, force: true });
});

test("revertEdgesInHistory: body mentioning the phrase with an unknown sha -> no edge", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "f.ts"), "v1\n");
  gitC(repo, ["add", "."]);
  gitC(repo, [
    "commit", "-q", "-m",
    "docs: note\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.",
  ]);
  // A full-length sha is trusted as an edge even if not in this repo's history
  // (rebases can orphan the target); it simply won't match any atom's commit.
  // An ABBREVIATED unknown prefix, however, must be dropped.
  gitC(repo, ["commit", "-q", "--allow-empty", "-m", "chore: x\n\nThis reverts commit deadbee."]);

  const edges = revertEdgesInHistory(repo);
  assert.equal(edges.length, 1, "only the full-sha mention survives");
  assert.equal(edges[0].reverted, "0123456789abcdef0123456789abcdef01234567");
  rmSync(repo, { recursive: true, force: true });
});

test("revertEdgesInHistory: multiple reverts in one body -> multiple edges", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.ts"), "1\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", "feat: a"]);
  const shaA = gitC(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "b.ts"), "2\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", "feat: b"]);
  const shaB = gitC(repo, ["rev-parse", "HEAD"]);
  gitC(repo, [
    "commit", "-q", "--allow-empty", "-m",
    `revert: both\n\nThis reverts commit ${shaA}.\nThis reverts commit ${shaB}.`,
  ]);

  const edges = revertEdgesInHistory(repo);
  assert.deepEqual(edges.map((e) => e.reverted).sort(), [shaA, shaB].sort());
  rmSync(repo, { recursive: true, force: true });
});

test("revertEdgesInHistory: a >40-char hex run is rejected, not truncated to a fake SHA", () => {
  const repo = makeRepo();
  // A pasted sha256 (64 hex chars) after the phrase must NOT yield an edge made
  // of its first 40 chars — that would bypass the universe check ("never a
  // wrong one").
  const sha256 = "ab".repeat(32); // 64 hex chars
  writeFileSync(join(repo, "f.ts"), "v\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", `chore: x\n\nThis reverts commit ${sha256}.`]);

  assert.equal(revertEdgesInHistory(repo).length, 0);
  rmSync(repo, { recursive: true, force: true });
});

test("revertEdgesInHistory: no reverts / no HEAD -> empty, no throw", () => {
  const repo = makeRepo();
  assert.equal(revertEdgesInHistory(repo).length, 0); // no HEAD
  writeFileSync(join(repo, "f.ts"), "v\n");
  gitC(repo, ["add", "."]);
  gitC(repo, ["commit", "-q", "-m", "init"]);
  assert.equal(revertEdgesInHistory(repo).length, 0); // history, no reverts
  rmSync(repo, { recursive: true, force: true });
});
