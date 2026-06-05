import type { Atom, DecisionAtom } from "../engine/index.js";
import { resolveRename } from "../engine/index.js";
import {
  readAllAtoms,
  commitsTouchingFile,
  readCommitTrailers,
  commitSubject,
  commitDate,
  filesChanged,
  renamesInHistory,
  annotateStale,
  annotateReverted,
  type LoreRecord,
  type AtomEntry,
} from "../store/index.js";

/**
 * Read-side graph assembly for the MCP tools.
 *
 * Two sources, merged and de-duplicated by Lore-id:
 *   1. The compacted graph in refs/notes/cairn (Cairn's own atoms).
 *   2. Lore trailers parsed straight out of commit messages.
 *
 * Source (2) is the interop proof: `why(file)` surfaces Lore decision records
 * even when they were written by another Lore-style tool and never passed
 * through Cairn's notes. Reading the standard is real, not just claimed.
 */

export function allAtoms(cwd: string): Atom[] {
  const entries = dedupe(readAllAtoms(cwd));
  annotateReverted(entries, cwd);
  return annotateStale(entries.map((e) => e.atom), cwd);
}

export function atomsForFile(
  cwd: string,
  file: string,
  renames: Map<string, string> = renamesInHistory(cwd)
): Atom[] {
  // Match by canonical CURRENT name, so a chain recorded under a file's old
  // path is still found when queried by its renamed path (and vice versa).
  // With no renames in history this degrades to exact path equality. The caller
  // may pass a precomputed map to share the git call with its own recall query.
  const canonical = (p: string) => resolveRename(p, renames);
  const target = canonical(file);
  const noteEntries = readAllAtoms(cwd);
  const fromNotes = noteEntries.filter(({ atom }) =>
    atom.files.some((f) => canonical(f) === target)
  );

  // Commits Cairn already noted carry their reasoning in the (richer) note; only
  // read trailers for commits WITHOUT a Cairn note — i.e. Lore records written
  // by another tool. That keeps interop real without double-counting our own work.
  // (Derived from the entries already in hand — no second `git notes list`.)
  const noted = new Set(noteEntries.map((e) => e.commit));
  const fromTrailers: AtomEntry[] = [];
  for (const sha of commitsTouchingFile(file, cwd)) {
    if (noted.has(sha)) continue;
    const record = readCommitTrailers(sha, cwd);
    if (record) fromTrailers.push({ atom: trailerToAtom(record, sha, cwd), commit: sha });
  }

  const entries = dedupe([...fromNotes, ...fromTrailers]);
  annotateReverted(entries, cwd);
  return annotateStale(entries.map((e) => e.atom), cwd, renames);
}

/** Keep one entry per Lore-id (the newest atom wins, and its commit is the one
 *  later annotated), so a note atom and its own commit trailer don't show up
 *  twice. */
function dedupe(entries: AtomEntry[]): AtomEntry[] {
  const byId = new Map<string, AtomEntry>();
  for (const entry of entries) {
    const prior = byId.get(entry.atom.loreId);
    if (!prior || entry.atom.createdAt > prior.atom.createdAt) {
      byId.set(entry.atom.loreId, entry);
    }
  }
  return [...byId.values()];
}

function trailerToAtom(record: LoreRecord, sha: string, cwd: string): DecisionAtom {
  return {
    id: record.loreId,
    loreId: record.loreId,
    level: 0,
    decisionId: `commit-${sha}`,
    intent: commitSubject(sha, cwd) || `Commit ${sha.slice(0, 8)}`,
    summary: "",
    files: filesChanged(sha, cwd),
    constraints: record.constraints,
    rejected: record.rejected,
    confidence: record.confidence,
    supersedes: record.supersedes,
    createdAt: commitDate(sha, cwd) || new Date(0).toISOString(),
    sourceIds: [],
  };
}
