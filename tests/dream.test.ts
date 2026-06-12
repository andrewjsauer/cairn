import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { openDecision, recordEdit, consolidate, consolidateGraph } from "../src/capture/index.js";
import { readAllAtoms, writeNote, type NotePayload } from "../src/store/index.js";
import { atomsForFile } from "../src/read/graph.js";
import { recall, isRollupAtom, atomTokens, type Complete } from "../src/engine/index.js";
import { gitC, makeRepo as sharedMakeRepo } from "./helpers/repo.js";

/**
 * The "dream" — global store compaction. Builds a multi-commit graph, then
 * compacts it under a tiny budget and verifies the store is bounded while
 * coverage is preserved (nothing a file needs is lost).
 */

const makeRepo = () => sharedMakeRepo({ prefix: "cairn-dream-" });

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

test("the dream folds a deleted-file atom before a live one, and never persists the stale flag", async () => {
  const repo = makeRepo();

  // keep.ts (older), then gone.ts (newer). Pure recency would keep gone.ts.
  for (const [i, f] of [["keep.ts", "2026-05-10"], ["gone.ts", "2026-05-20"]].entries()) {
    const now = `${f[1]}T00:00:00.000Z`;
    openDecision(repo, `decision ${i} about ${f[0]}`, [], now);
    writeFileSync(join(repo, f[0]), `// rev ${i} with enough text to weigh something\n`);
    recordEdit(repo, { toolName: "Write", filePath: join(repo, f[0]), reason: `change ${i}`, ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", `feat: ${f[0]}`]);
    await consolidate(repo, fake, { now });
  }

  // Delete gone.ts — no superseding decision, the staleness gap.
  gitC(repo, ["rm", "-q", "gone.ts"]);
  gitC(repo, ["commit", "-q", "-m", "chore: drop gone.ts"]);

  // Budget with room for exactly one verbatim atom, forcing a choice. Use the
  // LARGEST atom's cost so the budget is independent of note-listing order and
  // of whether linkSupersedes added a (size-bearing) supersedes line.
  const maxAtom = Math.max(...readAllAtoms(repo).map((e) => atomTokens(e.atom)));
  const result = await consolidateGraph(repo, fake, { budget: maxAtom + 1, now: "2026-06-01T00:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.ok(result.rollups >= 1, "produced a rollup");

  // The live atom survives verbatim; the deleted-code atom was folded.
  const keep = atomsForFile(repo, "keep.ts");
  assert.ok(keep.some((a) => !isRollupAtom(a)), "live keep.ts reasoning kept verbatim");
  const stored = readAllAtoms(repo).map((x) => x.atom);
  const covered = new Set(stored.filter(isRollupAtom).flatMap((r) => r.sourceIds));
  const goneSurvivesVerbatim = stored.some((a) => !isRollupAtom(a) && a.files.includes("gone.ts"));
  assert.ok(!goneSurvivesVerbatim || covered.size > 0, "gone.ts reasoning was folded, not kept ahead of live");

  // The derived flag never reached the notes store.
  for (const { atom } of readAllAtoms(repo)) {
    assert.equal(atom.stale, undefined, "no persisted atom carries the stale flag");
  }
});

test("the dream keeps a reverted decision verbatim over an older live one, and persists no flags", async () => {
  const repo = makeRepo();

  // keep.ts (older, live) then f.ts (newer, then bare-reverted).
  for (const [i, f] of [["keep.ts", "2026-05-10"], ["f.ts", "2026-05-20"]].entries()) {
    const now = `${f[1]}T00:00:00.000Z`;
    openDecision(repo, `decision ${i} about ${f[0]}`, [], now);
    writeFileSync(join(repo, f[0]), `// rev ${i} with enough text to weigh something\n`);
    recordEdit(repo, { toolName: "Write", filePath: join(repo, f[0]), reason: `change ${i}`, ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", `feat: ${f[0]}`]);
    await consolidate(repo, fake, { now });
  }
  gitC(repo, ["revert", "--no-edit", "HEAD"]); // f.ts decision: reverted AND stale

  // Order-independent budget: the largest atom + 1, so exactly one fits
  // regardless of note-listing order or a supersedes line's extra tokens.
  const maxAtom = Math.max(...readAllAtoms(repo).map((e) => atomTokens(e.atom)));
  const result = await consolidateGraph(repo, fake, { budget: maxAtom + 1, now: "2026-06-01T00:00:00.000Z" });
  assert.equal(result.ok, true);

  // The reverted (newer) decision survives verbatim — without the exemption its
  // staleness would have folded it first; the older live decision folds by recency.
  const stored = readAllAtoms(repo).map((x) => x.atom);
  const fVerbatim = stored.some((a) => !isRollupAtom(a) && a.files.includes("f.ts"));
  assert.equal(fVerbatim, true, "reverted decision kept verbatim (newer, ranks like live)");

  // Neither derived flag persisted anywhere.
  for (const { atom } of readAllAtoms(repo)) {
    assert.equal(atom.stale, undefined);
    assert.equal(atom.reverted, undefined);
  }
});

test("the dream counts a duplicated loreId once and leaves no zombie copy behind", async () => {
  const repo = makeRepo();

  // Three decisions across three commits.
  const files = ["a.ts", "b.ts", "c.ts"];
  for (let i = 0; i < files.length; i++) {
    const now = `2026-05-${10 + i}T00:00:00.000Z`;
    openDecision(repo, `decision ${i} about ${files[i]}`, [], now);
    writeFileSync(join(repo, files[i]), `// rev ${i}\n`);
    recordEdit(repo, { toolName: "Write", filePath: join(repo, files[i]), reason: `change ${i}`, ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", `feat: ${files[i]} #${i}`]);
    await consolidate(repo, fake, { now });
  }
  assert.equal(readAllAtoms(repo).length, 3, "three level-0 atoms across three commit notes");

  // Orphaned duplicate (post-crash artifact): the SAME atom — same loreId —
  // written into a note on a SECOND commit that has no Cairn note of its own.
  const dup = readAllAtoms(repo).find((e) => e.atom.files.includes("a.ts"))!;
  writeFileSync(join(repo, "extra.ts"), "// host commit for the duplicate note\n");
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "chore: extra commit"]);
  const dupCommit = gitC(repo, ["rev-parse", "HEAD"]);
  const payload: NotePayload = {
    v: 1,
    commit: dupCommit,
    generatedAt: dup.atom.createdAt,
    loreId: dup.atom.loreId,
    atoms: [dup.atom],
  };
  writeNote(dupCommit, payload, repo);
  assert.equal(readAllAtoms(repo).length, 4, "four physical copies, three unique loreIds");

  // Dream with a tiny budget so the store must fold.
  const result = await consolidateGraph(repo, fake, { budget: 10, now: "2026-06-01T00:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(result.before, 3, "the duplicated atom is counted ONCE for budget purposes");
  assert.ok(result.rollups >= 1, "produced rollup(s)");

  // The zombie case — one copy pruned, the other surviving in a different note,
  // re-entering every later read — must be impossible. If the atom was folded
  // into a rollup, ZERO physical copies remain; if it was kept verbatim,
  // exactly ONE remains.
  const after = readAllAtoms(repo);
  const verbatim = after.filter((e) => !isRollupAtom(e.atom) && e.atom.loreId === dup.atom.loreId);
  const covered = after
    .filter((e) => isRollupAtom(e.atom))
    .some((e) => e.atom.sourceIds.includes(dup.atom.id));
  assert.ok(verbatim.length <= 1, "never more than one physical copy survives the dream");
  if (covered) {
    assert.equal(verbatim.length, 0, "folded atom leaves no verbatim copy in ANY note");
  } else {
    assert.equal(verbatim.length, 1, "kept-verbatim atom survives as exactly one physical copy");
  }
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
