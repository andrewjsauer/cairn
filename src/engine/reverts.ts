/**
 * Net-revert resolution. Pure: takes revert edges extracted from git history
 * by the store layer and decides which commits are net-reverted — no git, no I/O.
 *
 * A commit is NET-reverted when some revert of it is itself still in effect:
 * a revert-of-the-revert re-lands the approach, so the original is not
 * net-reverted. Formally: S is net-reverted iff there exists an edge
 * (R reverts S) where R is not itself net-reverted.
 *
 * Edges always point backward in time (a revert is authored after the commit
 * it references), so the recursion is a DAG walk and terminates; the memo
 * pre-set is a belt-and-suspenders cycle guard, not a correctness requirement.
 *
 * Like staleness, this is deliberately interpretation-free: it records that the
 * commit was undone, not WHY (bad approach, wrong timing, release rollback).
 * The reading agent judges; Cairn reports the event.
 */

/** One revert relationship: `reverter` undid `reverted`. Full 40-char SHAs. */
export interface RevertEdge {
  reverter: string;
  reverted: string;
}

export function netRevertedShas(edges: RevertEdge[]): Set<string> {
  const revertersOf = new Map<string, string[]>();
  for (const e of edges) {
    const g = revertersOf.get(e.reverted) ?? [];
    g.push(e.reverter);
    revertersOf.set(e.reverted, g);
  }

  const memo = new Map<string, boolean>();
  const isNetReverted = (sha: string): boolean => {
    const known = memo.get(sha);
    if (known !== undefined) return known;
    memo.set(sha, false); // cycle guard: treat in-flight as not-reverted
    const result = (revertersOf.get(sha) ?? []).some((r) => !isNetReverted(r));
    memo.set(sha, result);
    return result;
  };

  const out = new Set<string>();
  for (const sha of revertersOf.keys()) {
    if (isNetReverted(sha)) out.add(sha);
  }
  return out;
}
