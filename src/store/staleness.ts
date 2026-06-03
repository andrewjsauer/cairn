import type { Atom } from "../engine/types.js";
import { isStale } from "../engine/staleness.js";
import { filesAtHead } from "./git.js";

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
export function annotateStale(atoms: Atom[], cwd: string): Atom[] {
  const live = filesAtHead(cwd);
  if (live.size === 0) return atoms;
  for (const atom of atoms) atom.stale = isStale(atom, live);
  return atoms;
}
