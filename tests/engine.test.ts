import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingest,
  compact,
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
