import type { Atom, Complete, Confidence, DecisionAtom, Rejected } from "../engine/index.js";
import {
  ingest,
  compact,
  isDecisionAtom,
  fiveDimensionOverlap,
  SAME_DECISION_THRESHOLD,
  idFrom,
} from "../engine/index.js";
import {
  repoRoot,
  headSha,
  readEntries,
  readDecisions,
  clearJournal,
  readAllAtoms,
  readNote,
  writeNote,
  removeNote,
  appendTrailersToCommit,
  emitTrailers,
  type JournalEntry,
  type LoreRecord,
  type NotePayload,
} from "../store/index.js";
import { COMPACT_TOKEN_BUDGET } from "../config.js";

export interface ConsolidateResult {
  ok: boolean;
  reason?: string;
  written: number;
  amended: boolean;
  loreId?: string;
  commit?: string;
}

/**
 * Fold the journal into durable records (Section 7).
 *
 *   journal entries -> engine.ingest -> level-0 atoms (grouped by decision)
 *                   -> overlap-based supersedes links vs the existing graph
 *                   -> engine.compact (one rollup level, under budget)
 *   then: Lore trailers amended onto the commit + atoms written to refs/notes/cairn
 *   then: the journal is cleared.
 *
 * A missed trigger loses nothing: the journal survives and the next consolidation
 * picks it up. Re-running on the same journal is idempotent — atom ids are
 * content hashes, so the same input yields the same records.
 *
 * `writeTrailers` distinguishes the two kinds of inflection point:
 *   - commit (writeTrailers: true, default): the new commit is the right home
 *     for the reasoning, so we amend Lore trailers onto it AND note the graph.
 *   - pre-compaction / session end / session start (writeTrailers: false): there
 *     is no commit these edits belong to, so we promote them to the notes graph
 *     (keyed on HEAD) only — never amending an unrelated commit's message. This
 *     makes in-flight reasoning queryable across sessions before it is committed.
 */
export async function consolidate(
  cwd: string,
  complete: Complete,
  opts: { now?: string; writeTrailers?: boolean } = {}
): Promise<ConsolidateResult> {
  const writeTrailers = opts.writeTrailers ?? true;
  const root = repoRoot(cwd);
  if (!root) return { ok: false, reason: "not-a-git-repo", written: 0, amended: false };

  const entries = readEntries(root);
  if (entries.length === 0) {
    return { ok: true, reason: "empty-journal", written: 0, amended: false };
  }

  const now = opts.now ?? new Date().toISOString();
  const decisions = readDecisions(root);

  const observations = entries.map((e: JournalEntry) => {
    const decision = e.decisionId ? decisions[e.decisionId] : undefined;
    return {
      id: e.id,
      ts: e.ts,
      decisionId: e.decisionId,
      decisionIntent: decision?.intent ?? null,
      decisionAlternatives: decision?.alternatives ?? [],
      file: e.file,
      change: e.change,
      reason: e.reason,
    };
  });

  // 1. Synthesize level-0 atoms (grouped by shared reasoning, never by folder).
  const newAtoms = await ingest(observations, complete, { now });

  // 2. Link evolution: if a new atom strongly overlaps an existing decision,
  //    record a supersedes link rather than letting the chain look unrelated.
  const existing = readAllAtoms(root).map((x) => x.atom).filter(isDecisionAtom);
  for (const atom of newAtoms) linkSupersedes(atom, existing);

  // 3. Keep the set under budget with one rollup level (no-op for small commits).
  const compactedNew = await compact(newAtoms, complete, {
    tokenBudget: COMPACT_TOKEN_BUDGET,
  });

  // 4. Build a single commit-level Lore record (exactly one Lore-id per commit).
  const record = buildLoreRecord(newAtoms);

  // 5. At a commit, amend Lore trailers onto it (guarded). At a non-commit
  //    inflection point, leave the message alone and only update the notes graph.
  const sha = headSha(root);
  const { amended, sha: noteSha } = writeTrailers
    ? appendTrailersToCommit(sha, emitTrailers(record), root)
    : { amended: false, sha };

  // A commit's note is the UNION of all decisions consolidated against it,
  // deduped by Lore-id. Merge with any existing note so a later notes-only flush
  // (or re-consolidation) adds to the commit's record instead of clobbering it.
  const existingNote = noteSha === sha ? readNote(noteSha, root) : null;
  const payload: NotePayload = {
    v: 1,
    commit: noteSha,
    generatedAt: now,
    loreId: record.loreId,
    atoms: mergeAtomsByLoreId(existingNote?.atoms ?? [], compactedNew),
  };
  writeNote(noteSha, payload, root);
  // The amend rewrote the commit; any note on the pre-amend sha is now orphaned.
  if (amended && noteSha !== sha) removeNote(sha, root);

  // 6. The journal has been promoted to durable records; clear it.
  clearJournal(root);

  return {
    ok: true,
    written: newAtoms.length,
    amended,
    loreId: record.loreId,
    commit: noteSha,
  };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function buildLoreRecord(atoms: DecisionAtom[]): LoreRecord {
  const constraints = [...new Set(atoms.flatMap((a) => a.constraints))];
  const rejected = uniqueRejected(atoms.flatMap((a) => a.rejected));
  // Conservative: the commit is only as settled as its least-settled decision.
  const confidence = atoms.reduce<Confidence>(
    (lowest, a) => (CONFIDENCE_RANK[a.confidence] < CONFIDENCE_RANK[lowest] ? a.confidence : lowest),
    "high"
  );
  // Stable, content-derived id — embeddable in the trailer before the amend.
  const loreId = hashLoreId(atoms.map((a) => a.loreId).sort().join(","));
  // Never emit a self-referential Supersedes (semantically invalid in Lore).
  const supersedes = [...new Set(atoms.flatMap((a) => a.supersedes))].filter((s) => s !== loreId);
  return { loreId, constraints, rejected, confidence, supersedes };
}

function linkSupersedes(atom: DecisionAtom, existing: DecisionAtom[]): void {
  for (const prior of existing) {
    if (prior.loreId === atom.loreId) continue;
    const { score } = fiveDimensionOverlap(atom, prior);
    if (score >= SAME_DECISION_THRESHOLD && !atom.supersedes.includes(prior.loreId)) {
      atom.supersedes.push(prior.loreId);
    }
  }
}

function hashLoreId(seed: string): string {
  return idFrom("lore", seed);
}

/** Union two atom sets by Lore-id, keeping the most recent of any duplicate. */
function mergeAtomsByLoreId(existing: Atom[], incoming: Atom[]): Atom[] {
  const byId = new Map<string, Atom>();
  for (const atom of [...existing, ...incoming]) {
    const prior = byId.get(atom.loreId);
    if (!prior || atom.createdAt >= prior.createdAt) byId.set(atom.loreId, atom);
  }
  return [...byId.values()];
}

function uniqueRejected(rs: Rejected[]): Rejected[] {
  const seen = new Set<string>();
  const out: Rejected[] = [];
  for (const r of rs) {
    const key = r.alternative.toLowerCase();
    if (!r.alternative || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
