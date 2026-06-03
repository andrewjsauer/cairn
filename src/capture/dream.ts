import type { Atom, Complete } from "../engine/index.js";
import { compactGraph, atomTokens, isRollupAtom } from "../engine/index.js";
import {
  repoRoot,
  graphAnchor,
  readAllAtoms,
  readNote,
  writeNote,
  removeNote,
  annotateStale,
  type NotePayload,
} from "../store/index.js";
import { STORE_TOKEN_BUDGET } from "../config.js";

/**
 * The "dream": global store compaction (memory consolidation).
 *
 * Inspired by hierarchical, self-compacting agent memory (MemGPT/Letta, mem0,
 * Zep) but implemented natively in git — Cairn stays narrow and takes no
 * dependency on a memory platform. Per the non-goals it holds at ONE rollup
 * level governed by a single budget knob (STORE_TOKEN_BUDGET).
 *
 * When the whole stored graph exceeds the budget, fold the oldest decision atoms
 * into rollups so the store stays bounded as history grows:
 *   - the compacted rollups live in one ledger note on the git empty-tree anchor
 *     (stable, never a real commit, so it never collides with a per-commit note);
 *   - the newest level-0 atoms stay verbatim in their per-commit notes;
 *   - the rolled-up level-0 atoms are pruned from their per-commit notes.
 *
 * The commit-message Lore trailers are NEVER touched — they are the permanent,
 * human-visible record. Only the graph (the notes) is compactable. Provenance
 * (sourceIds) always points at original atom ids, so a deeper level could be
 * added later without migration.
 *
 * Best place to run it is at session end/start ("sleep-time" consolidation) or
 * on demand via `cairn dream`. It is event-driven, never a daemon.
 */
export interface DreamResult {
  ok: boolean;
  reason?: string;
  before: number;
  after: number;
  rollups: number;
  prunedCommits: number;
}

export async function consolidateGraph(
  cwd: string,
  complete: Complete,
  opts: { budget?: number; now?: string } = {}
): Promise<DreamResult> {
  const root = repoRoot(cwd);
  if (!root) return { ok: false, reason: "not-a-git-repo", before: 0, after: 0, rollups: 0, prunedCommits: 0 };

  const budget = opts.budget ?? STORE_TOKEN_BUDGET;
  const now = opts.now ?? new Date().toISOString();
  const anchor = graphAnchor(root);

  const entries = readAllAtoms(root); // { atom, commit }[]
  const allAtoms = entries.map((e) => e.atom);
  const before = allAtoms.length;
  const totalTokens = allAtoms.reduce((sum, a) => sum + atomTokens(a), 0);
  if (totalTokens <= budget) {
    return { ok: true, reason: "within-budget", before, after: before, rollups: 0, prunedCommits: 0 };
  }

  // Mark atoms whose code is gone from HEAD so compactGraph folds them into
  // rollups before live reasoning. Done only when we're actually compacting, and
  // stripped again by writeNote so it never persists (it would be wrong the
  // moment HEAD moves).
  annotateStale(allAtoms, root);

  const compacted = await compactGraph(allAtoms, complete, { tokenBudget: budget });
  const keptIds = new Set(compacted.map((a) => a.loreId));
  const rollups = compacted.filter(isRollupAtom);

  // 1. Write the rollup ledger FIRST, so coverage exists before anything is pruned.
  if (rollups.length) {
    const payload: NotePayload = { v: 1, commit: anchor, generatedAt: now, loreId: "graph-rollups", atoms: rollups };
    writeNote(anchor, payload, root);
  } else {
    removeNote(anchor, root);
  }

  // 2. Prune each per-commit note down to the level-0 atoms that survived.
  const byCommit = new Map<string, Atom[]>();
  for (const { atom, commit } of entries) {
    if (commit === anchor) continue; // the ledger, handled above
    const g = byCommit.get(commit) ?? [];
    g.push(atom);
    byCommit.set(commit, g);
  }

  let prunedCommits = 0;
  for (const [commit, atoms] of byCommit) {
    const kept = atoms.filter((a) => keptIds.has(a.loreId));
    if (kept.length === atoms.length) continue; // unchanged
    prunedCommits++;
    if (kept.length === 0) {
      removeNote(commit, root);
    } else {
      const existing = readNote(commit, root);
      const payload: NotePayload = {
        v: 1,
        commit,
        generatedAt: existing?.generatedAt ?? now,
        loreId: existing?.loreId ?? "",
        atoms: kept,
      };
      writeNote(commit, payload, root);
    }
  }

  return { ok: true, before, after: compacted.length, rollups: rollups.length, prunedCommits };
}
