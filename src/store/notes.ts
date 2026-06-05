import type { Atom } from "../engine/types.js";
import { git } from "./git.js";
import { NOTES_REF } from "../config.js";

/** An atom paired with the commit whose note it was read from. The shape every
 *  note read produces and the commit-keyed annotators (reverts) consume. */
export interface AtomEntry {
  atom: Atom;
  commit: string;
}

/**
 * The compacted graph lives in the refs/notes/cairn namespace.
 *
 * Why notes (Section 5): they travel with the repo, update without rewriting
 * history, and produce no working-tree or pull-request noise. Each consolidated
 * commit gets one note holding that commit's atoms (level-0 + any rollups) as
 * JSON, keyed by the commit SHA. Reading the graph = listing notes and parsing.
 *
 * Notes are NOT fetched/pushed by default; sharing needs an explicit
 * `refs/notes/*` refspec. Cairn is single-player/local in this build, so we do
 * not push — but the data is standard git-notes and would push with one config
 * line (documented in the README).
 */

export interface NotePayload {
  /** Schema version, so the on-disk format can evolve. */
  v: 1;
  commit: string;
  generatedAt: string;
  loreId: string;
  atoms: Atom[];
}

export function writeNote(sha: string, payload: NotePayload, cwd: string): void {
  // Strip derived fields before serializing. `stale` and `reverted` are
  // computed at read/dream time from HEAD/history and must never persist (they
  // would be wrong the moment HEAD moves or a revert is itself reverted). This
  // is the single serialization chokepoint, so every caller — the dream,
  // consolidation, any future writer — is protected here, once.
  const persisted: NotePayload = {
    ...payload,
    atoms: payload.atoms.map(({ stale, reverted, ...rest }) => rest),
  };
  git(["notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", sha], {
    cwd,
    input: JSON.stringify(persisted, null, 2),
  });
}

export function readNote(sha: string, cwd: string): NotePayload | null {
  const raw = git(["notes", `--ref=${NOTES_REF}`, "show", sha], {
    cwd,
    allowFail: true,
  });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NotePayload;
    // Forward-compat: a note written by a newer Cairn (v>1) is skipped rather
    // than mis-read as v:1. The `v` field exists precisely for this gate.
    if (parsed?.v !== 1 || !Array.isArray(parsed.atoms)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remove the note on a commit, if any. Used to drop a note orphaned by an amend. */
export function removeNote(sha: string, cwd: string): void {
  git(["notes", `--ref=${NOTES_REF}`, "remove", sha], { cwd, allowFail: true });
}

/** All note->commit pairs in the namespace. */
export function listNotes(cwd: string): { note: string; commit: string }[] {
  const out = git(["notes", `--ref=${NOTES_REF}`, "list"], { cwd, allowFail: true });
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [note, commit] = line.split(/\s+/);
      return { note, commit };
    });
}

/** Every atom in the graph, with the commit it was consolidated at. */
export function readAllAtoms(cwd: string): AtomEntry[] {
  const result: AtomEntry[] = [];
  for (const { commit } of listNotes(cwd)) {
    const payload = readNote(commit, cwd);
    if (!payload) continue;
    for (const atom of payload.atoms) result.push({ atom, commit });
  }
  return result;
}
