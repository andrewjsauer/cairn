import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingest,
  compact,
  compactGraph,
  recall,
  fiveDimensionOverlap,
  atomTokens,
  type Complete,
  type RawObservation,
  type DecisionAtom,
  isRollupAtom,
} from "../src/engine/index.js";

/**
 * A deterministic fake `complete()`. The engine is decoupled precisely so it can
 * be tested with no model, no git, no SDK — this fake is the whole world.
 */
function fakeComplete(scripted: Partial<{
  synthesis: object;
  clusters: string[][];
  rollup: string;
}> = {}): Complete {
  return async (prompt: string) => {
    if (prompt.includes("Cluster them into distinct decisions")) {
      return JSON.stringify({ clusters: scripted.clusters ?? [] });
    }
    if (prompt.startsWith("Summarize these related decisions")) {
      return JSON.stringify({ summary: scripted.rollup ?? "rolled up summary" });
    }
    // synthesis
    return JSON.stringify(
      scripted.synthesis ?? {
        intent: "synth intent",
        summary: "synth summary",
        constraints: ["c1"],
        rejected: [{ alternative: "alt", reason: "why-not" }],
        confidence: "high",
      }
    );
  };
}

function obs(over: Partial<RawObservation>): RawObservation {
  return {
    id: "o1",
    ts: "2026-05-01T00:00:00.000Z",
    decisionId: "dec-1",
    decisionIntent: "make retries safe",
    decisionAlternatives: ["no retry"],
    file: "src/a.ts",
    change: "Edit",
    reason: "added backoff",
    ...over,
  };
}

test("ingest groups attached observations by decision into one level-0 atom", async () => {
  const observations = [
    obs({ id: "o1", file: "src/a.ts" }),
    obs({ id: "o2", file: "src/b.ts" }),
  ];
  const atoms = await ingest(observations, fakeComplete(), { now: "2026-05-02T00:00:00.000Z" });
  assert.equal(atoms.length, 1);
  const a = atoms[0];
  assert.equal(a.level, 0);
  assert.equal(a.decisionId, "dec-1");
  assert.deepEqual(a.files.sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal(a.intent, "synth intent");
  assert.deepEqual(a.sourceIds, ["o1", "o2"]);
  assert.equal(a.loreId.length, 8); // Lore-id shape
});

test("ingest is idempotent: same input -> same atom id", async () => {
  const observations = [obs({ id: "o1" }), obs({ id: "o2" })];
  const a = await ingest(observations, fakeComplete(), { now: "2026-05-02T00:00:00.000Z" });
  const b = await ingest(observations, fakeComplete(), { now: "2026-09-09T00:00:00.000Z" });
  assert.equal(a[0].id, b[0].id, "content-hashed id must not depend on wall clock");
});

test("ingest clusters unattached observations into inferred decisions", async () => {
  const observations = [
    obs({ id: "u1", decisionId: null, decisionIntent: null, decisionAlternatives: [], file: "src/x.ts" }),
    obs({ id: "u2", decisionId: null, decisionIntent: null, decisionAlternatives: [], file: "src/y.ts" }),
    obs({ id: "u3", decisionId: null, decisionIntent: null, decisionAlternatives: [], file: "src/z.ts" }),
  ];
  const atoms = await ingest(observations, fakeComplete({ clusters: [["u1", "u2"], ["u3"]] }), {
    now: "2026-05-02T00:00:00.000Z",
  });
  assert.equal(atoms.length, 2, "two inferred decisions from two clusters");
  assert.ok(atoms.every((a) => a.decisionId.startsWith("inferred-")));
});

test("ingest survives garbage model output with a deterministic fallback", async () => {
  const garbage: Complete = async () => "not json at all, sorry";
  const atoms = await ingest([obs({})], garbage, { now: "2026-05-02T00:00:00.000Z" });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].intent, "make retries safe", "falls back to recorded intent");
  // recorded alternative is preserved even when the model returns nothing
  assert.deepEqual(atoms[0].rejected, [{ alternative: "no retry", reason: "" }]);
});

test("recall why(file) returns the chain oldest-first, under budget", async () => {
  const atoms = await buildChain();
  const result = recall(atoms, { file: "src/a.ts", tokenBudget: 100000 });
  assert.equal(result.atoms.length, 3);
  assert.ok(result.atoms[0].createdAt < result.atoms[2].createdAt, "chronological");
  assert.equal(result.truncated, false);
});

test("recall enforces the token budget and reports truncation", async () => {
  const atoms = await buildChain();
  const tight = atomTokens(atoms[0]) + 1; // room for ~one atom
  const result = recall(atoms, { file: "src/a.ts", tokenBudget: tight });
  assert.ok(result.atoms.length < 3, "dropped atoms to fit");
  assert.equal(result.truncated, true);
  assert.ok(result.tokensUsed <= tight);
});

test("recall reports truncated=true when the single kept atom exceeds the budget", async () => {
  const big = mkAtom({
    files: ["src/a.ts"],
    summary: "x ".repeat(500), // ~250 tokens, well over a tiny budget
  });
  const result = recall([big], { file: "src/a.ts", tokenBudget: 10 });
  assert.equal(result.atoms.length, 1, "always returns at least one atom");
  assert.ok(result.tokensUsed > 10, "the kept atom exceeds the budget");
  assert.equal(result.truncated, true, "and that is reported honestly as truncated");
});

test("recall recent(n) returns newest-first, capped at n", async () => {
  const atoms = await buildChain();
  const result = recall(atoms, { recent: 2, tokenBudget: 100000 });
  assert.equal(result.atoms.length, 2);
  assert.ok(result.atoms[0].createdAt > result.atoms[1].createdAt, "newest first");
});

test("compact rolls overflow into one rollup level, preserving provenance", async () => {
  const atoms = await buildChain();
  const tiny = 30; // force compaction
  const out = await compact(atoms, fakeComplete({ rollup: "the arc" }), { tokenBudget: tiny });
  const rollups = out.filter(isRollupAtom);
  assert.ok(rollups.length >= 1, "produced at least one rollup");
  // every rolled-up source is accounted for (provenance present for deeper levels)
  const covered = new Set(rollups.flatMap((r) => r.sourceIds));
  assert.ok(covered.size > 0);
  assert.ok(out.every((a) => a.level === 0 || a.level === 1), "only level-0 and level-1");
});

test("compactGraph bounds the whole store at one rollup level with flattened provenance", async () => {
  // Six decisions on the same file, oldest -> newest.
  const atoms = Array.from({ length: 6 }, (_, i) =>
    mkAtom({
      id: `a${i}`,
      loreId: `a${i}`,
      files: ["src/x.ts"],
      intent: `decision ${i}`,
      summary: `reasoning number ${i} `.repeat(20),
      createdAt: `2026-05-${10 + i}T00:00:00.000Z`,
    })
  );
  const budget = atomTokens(atoms[0]) * 2; // room for ~2 newest verbatim
  const out = await compactGraph(atoms, fakeComplete({ rollup: "the merged arc" }), { tokenBudget: budget });

  assert.ok(out.every((a) => a.level === 0 || a.level === 1), "only level-0 and level-1");
  const rollups = out.filter(isRollupAtom);
  assert.ok(rollups.length >= 1, "old atoms folded into a rollup");
  assert.ok(out.some((a) => a.level === 0 && a.id === "a5"), "newest kept verbatim");
  const covered = new Set(rollups.flatMap((r) => r.sourceIds));
  assert.ok(covered.has("a0"), "oldest atom is covered by a rollup (nothing lost)");

  // Re-dream over the output: still one level, provenance still points at originals.
  const out2 = await compactGraph(out, fakeComplete({ rollup: "merged again" }), { tokenBudget: budget });
  assert.ok(out2.every((a) => a.level === 0 || a.level === 1), "still one rollup level after re-dream");
  const covered2 = new Set(out2.filter(isRollupAtom).flatMap((r) => r.sourceIds));
  assert.ok(covered2.has("a0"), "provenance still references original ids, not the intermediate rollup");
});

test("compactGraph folds STALE atoms before live ones of similar age", async () => {
  // Two atoms on different files, same size; budget fits exactly one verbatim.
  // The STALE one is NEWER — under pure recency it would be kept; the bias must
  // fold it instead and keep the live (older) one verbatim.
  const liveOld = mkAtom({
    id: "live", loreId: "live", files: ["live.ts"],
    summary: "reasoning ".repeat(20), createdAt: "2026-05-10T00:00:00.000Z",
  });
  const staleNew = mkAtom({
    id: "stale", loreId: "stale", files: ["gone.ts"], stale: true,
    summary: "reasoning ".repeat(20), createdAt: "2026-05-20T00:00:00.000Z",
  });
  const budget = atomTokens(liveOld) + 1; // room for ~one verbatim

  const out = await compactGraph([liveOld, staleNew], fakeComplete({ rollup: "folded" }), { tokenBudget: budget });

  assert.ok(out.some((a) => a.level === 0 && a.id === "live"), "live atom kept verbatim");
  assert.ok(!out.some((a) => a.level === 0 && a.id === "stale"), "stale atom not kept verbatim");
  const covered = new Set(out.filter(isRollupAtom).flatMap((r) => r.sourceIds));
  assert.ok(covered.has("stale"), "stale atom folded into a rollup (provenance preserved)");
});

test("compactGraph: a REVERTED stale atom ranks like live (recency), not fold-first", async () => {
  // The reverted atom's code is gone (stale) BECAUSE it was reverted. Without
  // the exemption it would fold before the older live atom; with it, recency
  // decides and the newer reverted atom is kept verbatim.
  const liveOld = mkAtom({
    id: "live", loreId: "live", files: ["live.ts"],
    summary: "reasoning ".repeat(20), createdAt: "2026-05-10T00:00:00.000Z",
  });
  const revertedNew = mkAtom({
    id: "rev", loreId: "rev", files: ["gone.ts"], stale: true, reverted: true,
    summary: "reasoning ".repeat(20), createdAt: "2026-05-20T00:00:00.000Z",
  });
  const budget = atomTokens(liveOld) + 1;

  const out = await compactGraph([liveOld, revertedNew], fakeComplete({ rollup: "folded" }), { tokenBudget: budget });
  assert.ok(out.some((a) => a.level === 0 && a.id === "rev"), "reverted atom kept verbatim (newer)");
  assert.ok(!out.some((a) => a.level === 0 && a.id === "live"), "older live atom folded by recency");
});

test("compactGraph: an OLD reverted atom still folds — no immortality", async () => {
  const revertedOld = mkAtom({
    id: "rev", loreId: "rev", files: ["gone.ts"], stale: true, reverted: true,
    summary: "reasoning ".repeat(20), createdAt: "2026-05-10T00:00:00.000Z",
  });
  const liveNew = mkAtom({
    id: "live", loreId: "live", files: ["live.ts"],
    summary: "reasoning ".repeat(20), createdAt: "2026-05-20T00:00:00.000Z",
  });
  const budget = atomTokens(liveNew) + 1;

  const out = await compactGraph([revertedOld, liveNew], fakeComplete({ rollup: "folded" }), { tokenBudget: budget });
  assert.ok(out.some((a) => a.level === 0 && a.id === "live"), "newer live kept");
  const covered = new Set(out.filter(isRollupAtom).flatMap((r) => r.sourceIds));
  assert.ok(covered.has("rev"), "old reverted atom folded into a rollup by recency");
});

test("compactGraph with no stale atoms is unchanged recency behavior", async () => {
  // All live: newest survives, oldest folds — exactly as before the bias existed.
  const atoms = Array.from({ length: 4 }, (_, i) =>
    mkAtom({
      id: `a${i}`, loreId: `a${i}`, files: ["src/x.ts"],
      summary: `reasoning ${i} `.repeat(20), createdAt: `2026-05-${10 + i}T00:00:00.000Z`,
    })
  );
  const budget = atomTokens(atoms[0]) * 2;
  const out = await compactGraph(atoms, fakeComplete({ rollup: "arc" }), { tokenBudget: budget });
  assert.ok(out.some((a) => a.level === 0 && a.id === "a3"), "newest kept verbatim");
  const covered = new Set(out.filter(isRollupAtom).flatMap((r) => r.sourceIds));
  assert.ok(covered.has("a0"), "oldest folded");
});

test("fiveDimensionOverlap scores identical decisions high, unrelated low", () => {
  const a = mkAtom({ files: ["src/a.ts"], intent: "make retries safe with backoff" });
  const same = mkAtom({ files: ["src/a.ts"], intent: "make retries safe with backoff" });
  const diff = mkAtom({ files: ["src/zzz.ts"], intent: "rename the widget colour palette" });
  assert.ok(fiveDimensionOverlap(a, same).score > 0.8);
  assert.ok(fiveDimensionOverlap(a, diff).score < 0.2);
});

// ---- helpers ----

async function buildChain(): Promise<DecisionAtom[]> {
  const make = (id: string, ts: string) =>
    ingest([obs({ id, decisionId: `dec-${id}`, ts })], fakeComplete(), { now: ts });
  const a = (await make("o1", "2026-05-01T00:00:00.000Z"))[0];
  const b = (await make("o2", "2026-05-02T00:00:00.000Z"))[0];
  const c = (await make("o3", "2026-05-03T00:00:00.000Z"))[0];
  return [a, b, c];
}

function mkAtom(over: Partial<DecisionAtom>): DecisionAtom {
  return {
    id: "x",
    loreId: "x",
    level: 0,
    decisionId: "d",
    intent: "intent",
    summary: "",
    files: ["src/a.ts"],
    constraints: [],
    rejected: [],
    confidence: "medium",
    supersedes: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    sourceIds: [],
    ...over,
  };
}

// --- recall contract: no mid-chain gaps; n-cap vs budget reported separately ---

test("recall drops ALL older level-0 atoms once one does not fit (no mid-chain gap)", async () => {
  const t = (d: string) => `2026-05-0${d}T00:00:00.000Z`;
  const aOld = mkAtom({ id: "old1", loreId: "old1", createdAt: t("1"), summary: "s ".repeat(20) });
  const aMid = mkAtom({ id: "mid1", loreId: "mid1", createdAt: t("2"), summary: "m ".repeat(300) });
  const aNew = mkAtom({ id: "new1", loreId: "new1", createdAt: t("3"), summary: "n ".repeat(600) });
  const budget = atomTokens(aNew) + atomTokens(aOld) + 1;
  // Sanity: the cheap OLD atom would fit by cost alone — the contract, not the
  // arithmetic, is what must exclude it.
  assert.ok(atomTokens(aNew) + atomTokens(aOld) <= budget, "old would fit by cost");
  assert.ok(atomTokens(aNew) + atomTokens(aMid) > budget, "mid genuinely overflows");

  const result = recall([aOld, aMid, aNew], { file: "src/a.ts", tokenBudget: budget });
  assert.deepEqual(
    result.atoms.map((a) => a.loreId),
    ["new1"],
    "once mid is dropped, older level-0 atoms drop too — no silent hole in the chain"
  );
  assert.equal(result.truncated, true);
});

test("recall keeps a cheap level-1 rollup even after level-0 selection closes", async () => {
  const t = (d: string) => `2026-05-0${d}T00:00:00.000Z`;
  const rollup = {
    id: "r1",
    loreId: "r1",
    level: 1 as const,
    summary: "old history, compressed",
    files: ["src/a.ts"],
    sourceIds: ["x", "y"],
    createdAt: t("1"),
  };
  const aMid = mkAtom({ id: "mid1", loreId: "mid1", createdAt: t("2"), summary: "m ".repeat(300) });
  const aNew = mkAtom({ id: "new1", loreId: "new1", createdAt: t("3"), summary: "n ".repeat(600) });
  const budget = atomTokens(aNew) + atomTokens(rollup) + 1;
  assert.ok(atomTokens(aNew) + atomTokens(aMid) > budget, "mid genuinely overflows");

  const result = recall([rollup, aMid, aNew], { file: "src/a.ts", tokenBudget: budget });
  assert.deepEqual(
    result.atoms.map((a) => a.loreId),
    ["r1", "new1"],
    "the rollup covers the old arc and is kept; only level-0 selection closed"
  );
});

test("recall keeps an atom whose cost lands exactly on the budget boundary", async () => {
  const a = mkAtom({ id: "a", loreId: "aaaa1111", createdAt: "2026-05-01T00:00:00.000Z" });
  const b = mkAtom({ id: "b", loreId: "bbbb2222", createdAt: "2026-05-02T00:00:00.000Z" });
  const exact = atomTokens(a) + atomTokens(b);
  const result = recall([a, b], { file: "src/a.ts", tokenBudget: exact });
  assert.equal(result.atoms.length, 2, "== budget is within budget");
  assert.equal(result.truncated, false);
});

test("recent(n) reports the n-cap as limited, never as budget truncation", async () => {
  const atoms = await buildChain();
  const result = recall(atoms, { recent: 2, tokenBudget: 100000 });
  assert.equal(result.limited, true, "stopped at the requested n");
  assert.equal(result.truncated, false, "the budget was never under pressure");
});

test("recent(n) under a tight budget reports truncated, not limited", async () => {
  const atoms = await buildChain();
  const tight = atomTokens(atoms[0]) + 1;
  const result = recall(atoms, { recent: 3, tokenBudget: tight });
  assert.equal(result.truncated, true);
  assert.equal(result.limited, false);
});

// --- M6/M11: no-key path — every model call THROWS, fallbacks carry the load ---

const throwing: Complete = async () => {
  throw new Error("no key");
};

test("ingest with a throwing complete falls back to per-file clusters with raw-reason content", async () => {
  const unattached = (id: string, file: string, reason: string) =>
    obs({ id, decisionId: null, decisionIntent: null, decisionAlternatives: [], file, reason });
  const observations = [
    unattached("u1", "src/x.ts", "tightened the parser"),
    unattached("u2", "src/x.ts", "handled the empty case"),
    unattached("u3", "src/y.ts", "renamed the helper"),
  ];
  const atoms = await ingest(observations, throwing, { now: "2026-05-02T00:00:00.000Z" });

  assert.equal(atoms.length, 2, "clustering fell back to one inferred decision per file");
  const x = atoms.find((a) => a.files.includes("src/x.ts"))!;
  const y = atoms.find((a) => a.files.includes("src/y.ts"))!;
  assert.equal(x.intent, "Changes to src/x.ts", "deterministic fallback intent");
  assert.equal(x.summary, "tightened the parser handled the empty case", "raw reasons survive as the summary");
  assert.equal(y.intent, "Changes to src/y.ts");
  assert.equal(y.summary, "renamed the helper");
});

test("ingest with a throwing complete keeps the RECORDED intent and alternatives", async () => {
  const atoms = await ingest([obs({})], throwing, { now: "2026-05-02T00:00:00.000Z" });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].intent, "make retries safe", "recorded intent wins over the file fallback");
  assert.deepEqual(atoms[0].rejected, [{ alternative: "no retry", reason: "" }]);
});

test("compact and compactGraph over budget with a throwing complete join member intents with ' → '", async () => {
  const a = mkAtom({
    id: "old", loreId: "old", files: ["src/x.ts"], intent: "first decision",
    summary: "reasoning ".repeat(20), createdAt: "2026-05-10T00:00:00.000Z",
  });
  const b = mkAtom({
    id: "new", loreId: "new", files: ["src/x.ts"], intent: "second decision",
    summary: "reasoning ".repeat(20), createdAt: "2026-05-20T00:00:00.000Z",
  });

  // Budget of 1: everything overflows into a single same-file rollup.
  const out = await compact([a, b], throwing, { tokenBudget: 1 });
  const rollups = out.filter(isRollupAtom);
  assert.equal(rollups.length, 1);
  // compact folds the (oldest-first) overflow in collection order: newest first.
  assert.equal(rollups[0].summary, "second decision → first decision");

  const out2 = await compactGraph([a, b], throwing, { tokenBudget: 1 });
  const rollups2 = out2.filter(isRollupAtom);
  assert.equal(rollups2.length, 1);
  assert.equal(rollups2[0].summary, "second decision → first decision");
});

// --- F7: a model-repeated id inside one cluster maps each observation once ---

test("a duplicated id within a cluster yields one observation per id, no duplicate sourceIds", async () => {
  const unattached = (id: string, file: string) =>
    obs({ id, decisionId: null, decisionIntent: null, decisionAlternatives: [], file });
  const atoms = await ingest(
    [unattached("u1", "src/x.ts"), unattached("u2", "src/y.ts")],
    fakeComplete({ clusters: [["u1", "u1", "u2"]] }),
    { now: "2026-05-02T00:00:00.000Z" }
  );
  assert.equal(atoms.length, 1, "one cluster -> one atom");
  assert.deepEqual(atoms[0].sourceIds, ["u1", "u2"], "sourceIds carry each id exactly once");
  assert.equal(new Set(atoms[0].sourceIds).size, atoms[0].sourceIds.length);
});

// --- SAME_DECISION_THRESHOLD straddle: deterministic pairs just above / just below ---

import { SAME_DECISION_THRESHOLD } from "../src/engine/index.js";

test("fiveDimensionOverlap pairs straddling SAME_DECISION_THRESHOLD link / don't link", () => {
  assert.equal(SAME_DECISION_THRESHOLD, 0.5, "the fractions below are built for a 0.5 threshold");
  // Only the files + intent dimensions are active (constraints/rejected/summary
  // empty on both sides -> excluded from the mean). Token sets are chosen so the
  // jaccard values are exact fractions:
  //   linking pair:  files {x,y}∩{x}=1/2, intent {alpha,beta,gamma}∩{alpha,beta,delta}=2/4
  //                  -> mean (0.5 + 0.5)/2 = 0.5  == threshold -> links (>=)
  //   non-linking:   files 1/2, intent {alpha,beta}∩{alpha,gamma}=1/3
  //                  -> mean (0.5 + 1/3)/2 ≈ 0.417 < threshold -> doesn't link
  const linkA = mkAtom({ files: ["x.ts", "y.ts"], intent: "alpha beta gamma", summary: "" });
  const linkB = mkAtom({ files: ["x.ts"], intent: "alpha beta delta", summary: "" });
  const above = fiveDimensionOverlap(linkA, linkB).score;
  assert.ok(above >= SAME_DECISION_THRESHOLD, `score ${above} meets the threshold -> supersedes link`);

  const farA = mkAtom({ files: ["x.ts", "y.ts"], intent: "alpha beta", summary: "" });
  const farB = mkAtom({ files: ["x.ts"], intent: "alpha gamma", summary: "" });
  const below = fiveDimensionOverlap(farA, farB).score;
  assert.ok(below < SAME_DECISION_THRESHOLD, `score ${below} stays under the threshold -> no link`);
  assert.ok(above - below < 0.1, "the two pairs genuinely straddle the threshold, not a trivial gap");
});
