import type { Atom } from "./types.js";

/**
 * The single definition of structural staleness, shared by the read path
 * (why/recent) and the write path (the dream). Pure: it takes the set of paths
 * that currently exist at HEAD — and optionally a rename map (old path -> new
 * path, from git history) — and decides per atom. No git, no I/O.
 *
 * An atom is stale when ALL of its files are gone from HEAD: the code it
 * describes no longer exists anywhere, so the reasoning is about something that
 * was deleted. A file that was *renamed* is not gone — if its chain-resolved
 * current path is live, the file counts as live. An atom that still touches at
 * least one live file is current, and an atom with no files (nothing to anchor
 * to) is never stale.
 *
 * This is deliberately structural only. "The file is still here but the
 * constraint no longer describes it" is NOT staleness — that is a *superseding*
 * decision's job, and re-evaluating reasoning against code would need a model
 * call (forbidden on the read path) and drift Cairn toward a memory platform.
 */
export function isStale(
  atom: Atom,
  livePaths: Set<string>,
  renames?: Map<string, string>
): boolean {
  if (atom.files.length === 0) return false;
  return atom.files.every(
    (f) => !livePaths.has(f) && !livePaths.has(resolveRename(f, renames))
  );
}

/**
 * Follow a path through the rename map to its current name (a -> b -> c gives
 * c for a). Cycle-guarded: a rename loop (a -> b, b -> a) terminates at the
 * first revisit and returns the last new name reached.
 */
export function resolveRename(path: string, renames?: Map<string, string>): string {
  if (!renames) return path;
  let current = path;
  const seen = new Set<string>([current]);
  while (renames.has(current)) {
    const next = renames.get(current)!;
    if (seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}
