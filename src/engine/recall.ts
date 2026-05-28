import type { Atom, RecallQuery, RecallResult } from "./types.js";
import { atomTokens } from "./budget.js";

/**
 * Budget-bounded recall.
 *
 * Two query shapes back the two MCP tools:
 *   - why(file):   the decision *chain* for a file, oldest -> newest. The
 *                  evolution is the context, so we present it in order; when it
 *                  exceeds the budget we drop the OLDEST level-0 atoms first
 *                  (rollups, which compress old history, are kept).
 *   - recent(n):   the latest N decisions across the whole graph, newest first.
 *
 * Selection always respects `tokenBudget` and reports whether it truncated, so
 * a fresh agent gets a result that fits its attention budget rather than an
 * unbounded dump that grows with the repo.
 */

function touchesFile(atom: Atom, file: string): boolean {
  return atom.files.includes(file);
}

function byCreatedAsc(a: Atom, b: Atom): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export function recall(atoms: Atom[], query: RecallQuery): RecallResult {
  if (query.file !== undefined) {
    return recallChain(atoms, query.file, query.tokenBudget);
  }
  if (query.recent !== undefined) {
    return recallRecent(atoms, query.recent, query.tokenBudget);
  }
  return { atoms: [], tokensUsed: 0, truncated: false };
}

/** why(file): chain for a file, chronological, oldest dropped first under budget. */
function recallChain(
  atoms: Atom[],
  file: string,
  budget: number
): RecallResult {
  const chain = atoms.filter((a) => touchesFile(a, file)).sort(byCreatedAsc);

  // Walk newest -> oldest accumulating cost; keep whatever fits, then re-sort
  // chronologically for presentation. Rollups are cheap and cover old history,
  // so this naturally preserves the long arc while trimming old detail.
  const kept: Atom[] = [];
  let used = 0;
  let truncated = false;
  for (let i = chain.length - 1; i >= 0; i--) {
    const atom = chain[i];
    const cost = atomTokens(atom);
    if (used + cost > budget && kept.length > 0) {
      truncated = true;
      continue;
    }
    kept.push(atom);
    used += cost;
  }
  kept.sort(byCreatedAsc);
  return { atoms: kept, tokensUsed: used, truncated };
}

/** recent(n): latest N decisions across the graph, newest first, under budget. */
function recallRecent(
  atoms: Atom[],
  n: number,
  budget: number
): RecallResult {
  const newestFirst = [...atoms].sort((a, b) => -byCreatedAsc(a, b));
  const kept: Atom[] = [];
  let used = 0;
  let truncated = false;
  for (const atom of newestFirst) {
    if (kept.length >= n) {
      truncated = true;
      break;
    }
    const cost = atomTokens(atom);
    if (used + cost > budget && kept.length > 0) {
      truncated = true;
      break;
    }
    kept.push(atom);
    used += cost;
  }
  return { atoms: kept, tokensUsed: used, truncated };
}
