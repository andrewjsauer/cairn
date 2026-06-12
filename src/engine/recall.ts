import type { Atom, RecallQuery, RecallResult } from "./types.js";
import { atomTokens } from "./budget.js";
import { resolveRename } from "./staleness.js";

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

/** Match by canonical current name when a rename map is supplied, so a chain
 *  recorded under a file's old path still answers a query by its new path. */
function touchesFile(atom: Atom, file: string, renames?: Map<string, string>): boolean {
  if (!renames) return atom.files.includes(file);
  const target = resolveRename(file, renames);
  return atom.files.some((f) => resolveRename(f, renames) === target);
}

function byCreatedAsc(a: Atom, b: Atom): number {
  return a.createdAt.localeCompare(b.createdAt);
}

export function recall(atoms: Atom[], query: RecallQuery): RecallResult {
  if (query.file !== undefined) {
    return recallChain(atoms, query.file, query.tokenBudget, query.renames);
  }
  if (query.recent !== undefined) {
    return recallRecent(atoms, query.recent, query.tokenBudget);
  }
  return { atoms: [], tokensUsed: 0, truncated: false, limited: false };
}

/** why(file): chain for a file, chronological, oldest dropped first under budget. */
function recallChain(
  atoms: Atom[],
  file: string,
  budget: number,
  renames?: Map<string, string>
): RecallResult {
  const chain = atoms.filter((a) => touchesFile(a, file, renames)).sort(byCreatedAsc);

  // Walk newest -> oldest accumulating cost; keep whatever fits, then re-sort
  // chronologically for presentation. Once a level-0 atom does not fit, all
  // OLDER level-0 atoms are dropped too — a cheaper old atom slipping past a
  // dropped newer one would leave a silent hole in the middle of the chain
  // (and supersedes links pointing at records the reader can't see). Level-1
  // rollups stay exempt: they are cheap and compress old history, which is
  // what preserves the long arc while trimming old detail.
  const kept: Atom[] = [];
  let used = 0;
  let truncated = false;
  let level0Closed = false;
  for (let i = chain.length - 1; i >= 0; i--) {
    const atom = chain[i];
    if (atom.level === 0 && level0Closed) {
      truncated = true;
      continue;
    }
    const cost = atomTokens(atom);
    if (used + cost > budget && kept.length > 0) {
      truncated = true;
      if (atom.level === 0) level0Closed = true;
      continue;
    }
    kept.push(atom);
    used += cost;
  }
  kept.sort(byCreatedAsc);
  // We always keep at least one atom even if it alone exceeds the budget
  // ("always return something"); report that honestly as truncated.
  if (used > budget) truncated = true;
  return { atoms: kept, tokensUsed: used, truncated, limited: false };
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
  let limited = false;
  for (const atom of newestFirst) {
    if (kept.length >= n) {
      // Stopping at the requested n is NOT budget pressure — report it as
      // `limited` so the rendered message never claims trimming that didn't
      // happen.
      limited = true;
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
  if (used > budget) truncated = true; // first atom alone may exceed the budget
  return { atoms: kept, tokensUsed: used, truncated, limited };
}
