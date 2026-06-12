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
  headShaIfAny,
  readEntries,
  readDecisions,
  consumeEntries,
  readAllAtoms,
  readNote,
  writeNote,
  removeNote,
  appendTrailersToCommit,
  emitTrailers,
  oneLine,
  readCommitTrailers,
  writeLastConsolidatedHead,
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

  // A repo with zero commits has no HEAD to consolidate against. Bail BEFORE
  // any model call is spent; the journal is untouched (nothing was consumed),
  // so the first real commit's trigger picks everything up.
  const sha = headShaIfAny(root);
  if (!sha) return { ok: false, reason: "no-head", written: 0, amended: false };

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
  //    The record is the UNION of everything consolidated against this commit:
  //    the new atoms, any decision atoms already noted on it (a prior
  //    consolidation or notes-only flush at the same HEAD), and any trailer
  //    block already on the message (the only survivor of a dream-pruned note).
  //    It is built from PRE-compaction atoms so a within-run rollup can never
  //    drop a decision's constraints from the permanent record.
  const existingNote = readNote(sha, root);
  const notedDecisions = (existingNote?.atoms ?? []).filter(isDecisionAtom);
  const recordAtoms = mergeAtomsByLoreId(notedDecisions, newAtoms).filter(isDecisionAtom);
  const record = unionLoreRecords(buildLoreRecord(recordAtoms), readCommitTrailers(sha, root));

  // 5. At a commit, amend Lore trailers onto it (guarded). At a non-commit
  //    inflection point, leave the message alone and only update the notes graph.
  const { amended, sha: noteSha } = writeTrailers
    ? appendTrailersToCommit(sha, emitTrailers(record), root)
    : { amended: false, sha };

  // A commit's note is the UNION of all decisions consolidated against it,
  // deduped by Lore-id. The existing note was read from the PRE-amend sha
  // (amending rewrites the commit; its note does not move with it) and merged
  // here, so a re-consolidation ADDS to the commit's record — it never clobbers
  // atoms a prior consolidation or flush already recorded.
  const payload: NotePayload = {
    v: 1,
    commit: noteSha,
    generatedAt: now,
    loreId: record.loreId,
    atoms: mergeAtomsByLoreId(existingNote?.atoms ?? [], compactedNew),
  };
  writeNote(noteSha, payload, root);
  // The pre-amend note is merged into the payload above; the orphan can go.
  if (amended && noteSha !== sha) removeNote(sha, root);

  // 6. Promote-then-consume: remove exactly the entries read at step 0 —
  //    anything appended while the model ran survives for the next trigger.
  consumeEntries(root, new Set(entries.map((e) => e.id)));

  // Remember where HEAD ended up so the commit-trigger gate can tell a real
  // new commit from a fresh-looking HEAD that never moved. Consolidation has
  // already fully succeeded by here, so a failed pointer write must not
  // propagate — worst case the next trigger re-runs a redundant amend that
  // short-circuits as already-current (a no-op).
  try {
    writeLastConsolidatedHead(root, noteSha);
  } catch (err) {
    process.stderr.write(`cairn: failed to record last consolidated head: ${String(err)}\n`);
  }

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
  // Constraints round-trip through the trailer block via oneLine() (whitespace
  // collapsed), so dedupe in that same normalized space — otherwise a
  // multi-line constraint ("a\nb") and its trailer form ("a b") read as
  // distinct and accumulate duplicate Constraint lines across amends. Atom
  // content in notes stays raw.
  const constraints = [...new Set(atoms.flatMap((a) => a.constraints).map(oneLine))];
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

/**
 * Union a freshly built record with the trailer record already on the commit.
 * The amend REPLACES the old block, so anything not carried forward here is
 * gone from the permanent record. The trailer is the only place a decision
 * survives once a dream prunes its atom from the note — this union is what
 * makes the block monotone under re-consolidation and crash-retry.
 */
function unionLoreRecords(record: LoreRecord, prior: LoreRecord | null): LoreRecord {
  if (!prior) return record;
  return {
    loreId: record.loreId,
    // Same oneLine() normalization as buildLoreRecord: the prior side was read
    // back from trailers (already collapsed), the new side may not be.
    constraints: [...new Set([...prior.constraints, ...record.constraints].map(oneLine))],
    rejected: uniqueRejected([...prior.rejected, ...record.rejected]),
    // Conservative both ways: the commit is only as settled as its
    // least-settled record, old or new.
    confidence:
      CONFIDENCE_RANK[prior.confidence] < CONFIDENCE_RANK[record.confidence]
        ? prior.confidence
        : record.confidence,
    // Commit-level record ids are replacements, not decision lineage — keep
    // them out of Supersedes.
    supersedes: [...new Set([...prior.supersedes, ...record.supersedes])].filter(
      (s) => s !== record.loreId && s !== prior.loreId
    ),
  };
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
    // oneLine for the same reason as constraints: the trailer round-trip
    // collapses whitespace, so compare alternatives in that normalized space.
    const key = oneLine(r.alternative).toLowerCase();
    if (!r.alternative || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
