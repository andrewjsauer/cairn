import type { Atom } from "../engine/types.js";
import { isDecisionAtom } from "../engine/types.js";
import { netRevertedShas } from "../engine/reverts.js";
import { revertEdgesInHistory } from "./git.js";

/** An atom paired with the commit it was read from. Revert status is keyed by
 *  commit, so annotation needs the pair — unlike staleness, which keys on files
 *  and takes bare atoms. */
export interface AtomEntry {
  atom: Atom;
  commit: string;
}

/**
 * Mark each level-0 atom reverted when the commit it was consolidated at was
 * undone by a `git revert` that is still in effect (net status — a
 * revert-of-the-revert re-lands the approach and clears the flag). One git call
 * for the edges, then the pure engine resolver. Derived, NOT persisted:
 * writeNote strips the flag before serialization.
 *
 * Rollups are never flagged — they live on the anchor object, not a real
 * commit, and their summaries already carry the arc.
 */
export function annotateReverted(entries: AtomEntry[], cwd: string): AtomEntry[] {
  const edges = revertEdgesInHistory(cwd);
  if (edges.length === 0) return entries;
  const net = netRevertedShas(edges);
  for (const { atom, commit } of entries) {
    if (isDecisionAtom(atom) && net.has(commit)) atom.reverted = true;
  }
  return entries;
}
