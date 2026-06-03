import type { Atom } from "../engine/types.js";
import { isStale } from "../engine/staleness.js";
import { filesAtHead, renamesInHistory } from "./git.js";

/**
 * Mark each atom stale when the code it describes is gone from HEAD — one git
 * snapshot, then the pure engine rule per atom. Derived, NOT persisted: writeNote
 * strips the flag before serialization. Shared by the read path (why/recent) and
 * the dream so both agree on what "stale" means.
 *
 * When HEAD yields no live paths — an empty/HEAD-less repo, or a transient git
 * failure (lock contention, timeout) that `filesAtHead` swallows to an empty set
 * — we annotate NOTHING stale and leave the atoms untouched. Absence of a live
 * snapshot is not evidence of deletion, and flagging the entire store stale on a
 * transient error is worse than a missed flag. (A real repo emptied to zero
 * tracked files is the only false negative, and it has no live code to reason
 * about anyway.)
 */
export function annotateStale(
  atoms: Atom[],
  cwd: string,
  renames?: Map<string, string>
): Atom[] {
  const live = filesAtHead(cwd);
  if (live.size === 0) return atoms;

  // A caller that already paid for the rename map (atomsForFile uses it for
  // canonical-name matching) passes it in; one pass with rescue built in.
  if (renames) {
    for (const atom of atoms) atom.stale = isStale(atom, live, renames);
    return atoms;
  }

  for (const atom of atoms) atom.stale = isStale(atom, live);

  // Rename rescue, fetched lazily: a renamed file is not deleted — its content
  // lives on at the new path, so the reasoning about it is still current. The
  // rename map costs a full-history git call, so only pay for it when the cheap
  // pass actually flagged something (the all-live common case never does).
  if (atoms.some((a) => a.stale)) {
    const lazyRenames = renamesInHistory(cwd);
    if (lazyRenames.size > 0) {
      for (const atom of atoms) {
        if (atom.stale) atom.stale = isStale(atom, live, lazyRenames);
      }
    }
  }
  return atoms;
}
