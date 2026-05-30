import type { Atom, Complete, RollupAtom } from "./types.js";
import { isDecisionAtom, isRollupAtom } from "./types.js";
import { atomTokens, renderAtom } from "./budget.js";
import { idFrom } from "./hash.js";
import { extractJson } from "./json.js";

/**
 * compact(): keep the graph under a token budget with one rollup level.
 *
 * Strategy (level-0 + one rollup level, per the non-goals — no deeper recursion):
 *   1. Keep the newest level-0 atoms that fit the budget verbatim — recent
 *      reasoning is the most useful and should stay lossless.
 *   2. Fold the overflow (oldest level-0 atoms) into level-1 rollups, grouped by
 *      shared files so a rollup still answers "why this file" coherently.
 *   3. Existing rollups are preserved.
 *
 * Provenance (`sourceIds`) is recorded on every rollup, so a deeper level could
 * be added later without migrating stored data.
 */
export async function compact(
  atoms: Atom[],
  complete: Complete,
  opts: { tokenBudget: number }
): Promise<Atom[]> {
  const rollups = atoms.filter(isRollupAtom);
  const level0 = atoms.filter(isDecisionAtom).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) // oldest first
  );

  const total = atoms.reduce((sum, a) => sum + atomTokens(a), 0);
  if (total <= opts.tokenBudget) {
    return atoms; // already within budget; nothing to do
  }

  // Reserve room for existing rollups, then keep newest level-0 atoms that fit.
  let used = rollups.reduce((sum, r) => sum + atomTokens(r), 0);
  const keep: typeof level0 = [];
  const overflow: typeof level0 = [];
  for (let i = level0.length - 1; i >= 0; i--) {
    const atom = level0[i];
    const cost = atomTokens(atom);
    if (used + cost <= opts.tokenBudget) {
      keep.push(atom);
      used += cost;
    } else {
      overflow.push(atom);
    }
  }

  if (overflow.length === 0) {
    return [...rollups, ...keep];
  }

  // Group overflow by shared files (connected components over file overlap).
  const groups = groupByFileOverlap(overflow);
  const newRollups: RollupAtom[] = [];
  for (const group of groups) {
    newRollups.push(await rollup(group, complete));
  }

  return [...rollups, ...newRollups, ...keep];
}

/**
 * compactGraph(): the GLOBAL, "dream" variant of compact, run over the entire
 * accumulated store (not a single commit's batch). Keeps the newest level-0
 * atoms verbatim within the budget and folds EVERYTHING older — old level-0
 * atoms AND any existing rollups — into one updated rollup per file-cluster.
 *
 * Still one rollup level (no level-2): existing rollups are re-summarized and
 * merged, not stacked. The number of rollups is bounded by the number of
 * file-clusters, so the store stays bounded as history grows. Provenance
 * (sourceIds) always points at original level-0 ids.
 */
export async function compactGraph(
  atoms: Atom[],
  complete: Complete,
  opts: { tokenBudget: number }
): Promise<Atom[]> {
  const total = atoms.reduce((sum, a) => sum + atomTokens(a), 0);
  if (total <= opts.tokenBudget) return atoms; // already bounded

  const level0 = atoms.filter(isDecisionAtom).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const existingRollups = atoms.filter(isRollupAtom);

  // Keep newest level-0 atoms that fit; the rest overflow into the compress set.
  const keep: Atom[] = [];
  const overflow: Atom[] = [];
  let used = 0;
  for (let i = level0.length - 1; i >= 0; i--) {
    const cost = atomTokens(level0[i]);
    if (used + cost <= opts.tokenBudget) {
      keep.push(level0[i]);
      used += cost;
    } else {
      overflow.push(level0[i]);
    }
  }

  // Re-summarize old level-0 + all existing rollups, merged by shared files.
  const toCompress = [...overflow, ...existingRollups];
  if (toCompress.length === 0) return atoms;

  const newRollups: RollupAtom[] = [];
  for (const grp of groupByFileOverlap(toCompress)) {
    newRollups.push(await rollup(grp, complete));
  }
  return [...newRollups, ...keep];
}

function groupByFileOverlap(atoms: Atom[]): Atom[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));

  atoms.forEach((_, i) => parent.set(i, i));
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      if (atoms[i].files.some((f) => atoms[j].files.includes(f))) union(i, j);
    }
  }
  const byRoot = new Map<number, Atom[]>();
  atoms.forEach((atom, i) => {
    const root = find(i);
    const g = byRoot.get(root) ?? [];
    g.push(atom);
    byRoot.set(root, g);
  });
  return [...byRoot.values()];
}

async function rollup(group: Atom[], complete: Complete): Promise<RollupAtom> {
  const files = [...new Set(group.flatMap((a) => a.files))];
  // Provenance chains to ORIGINAL level-0 ids: when a group member is itself a
  // rollup (re-summarized during a global dream), flatten to its sources rather
  // than pointing at the intermediate rollup. Keeps us at one rollup level.
  const sourceIds = [
    ...new Set(group.flatMap((a) => (isRollupAtom(a) ? a.sourceIds : [a.loreId]))),
  ].sort();
  const createdAt = group.reduce(
    (max, a) => (a.createdAt > max ? a.createdAt : max),
    group[0].createdAt
  );

  let summary = "";
  try {
    const raw = await complete(rollupPrompt(group), {
      system: ROLLUP_SYSTEM,
      maxTokens: 400,
    });
    const parsed = extractJson<{ summary?: string }>(raw);
    summary = (parsed?.summary ?? "").trim();
  } catch {
    summary = "";
  }
  if (!summary) {
    summary = group.map((a) => (isDecisionAtom(a) ? a.intent : a.summary)).join(" → ");
  }

  const id = idFrom("rollup", ...sourceIds);
  return {
    id,
    loreId: id,
    level: 1,
    summary,
    files,
    createdAt,
    sourceIds,
  };
}

const ROLLUP_SYSTEM =
  "You compress several older decision records about related code into one short summary that preserves the arc of how the thinking evolved. Output ONLY JSON.";

function rollupPrompt(group: Atom[]): string {
  const body = group.map(renderAtom).join("\n---\n");
  return [
    "Summarize these related decisions into one paragraph that keeps the evolution (what changed and why, in order):",
    "",
    body,
    "",
    'Return JSON: {"summary": string}. 2-4 sentences.',
  ].join("\n");
}
