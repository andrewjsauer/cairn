import type { Atom, DecisionAtom } from "../engine/index.js";
import {
  readAllAtoms,
  listNotes,
  commitsTouchingFile,
  readCommitTrailers,
  commitSubject,
  commitDate,
  filesChanged,
  annotateStale,
  type LoreRecord,
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
  return annotateStale(dedupe(readAllAtoms(cwd).map((x) => x.atom)), cwd);
}

export function atomsForFile(cwd: string, file: string): Atom[] {
  const fromNotes = readAllAtoms(cwd)
    .map((x) => x.atom)
    .filter((a) => a.files.includes(file));

  // Commits Cairn already noted carry their reasoning in the (richer) note; only
  // read trailers for commits WITHOUT a Cairn note — i.e. Lore records written
  // by another tool. That keeps interop real without double-counting our own work.
  const noted = new Set(listNotes(cwd).map((n) => n.commit));
  const fromTrailers: Atom[] = [];
  for (const sha of commitsTouchingFile(file, cwd)) {
    if (noted.has(sha)) continue;
    const record = readCommitTrailers(sha, cwd);
    if (record) fromTrailers.push(trailerToAtom(record, sha, cwd));
  }

  return annotateStale(dedupe([...fromNotes, ...fromTrailers]), cwd);
}

/** Keep one atom per Lore-id (the newest), so a note atom and its own commit
 *  trailer don't show up twice. */
function dedupe(atoms: Atom[]): Atom[] {
  const byId = new Map<string, Atom>();
  for (const atom of atoms) {
    const prior = byId.get(atom.loreId);
    if (!prior || atom.createdAt > prior.createdAt) byId.set(atom.loreId, atom);
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
