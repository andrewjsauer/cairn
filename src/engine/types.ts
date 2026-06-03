/**
 * Engine domain types.
 *
 * This module — and everything under src/engine/ — is deliberately decoupled:
 * it has ZERO imports from git, Claude Code, the store, or the Anthropic SDK.
 * The only capability it depends on is the injected `Complete` function.
 * That decoupling is a hard requirement (see DESIGN.md) and is enforced by
 * tests/decoupling.test.ts.
 */

export type Confidence = "low" | "medium" | "high";

/** A rejected alternative and why it was rejected. Mirrors Lore's `Rejected:` trailer. */
export interface Rejected {
  alternative: string;
  reason: string;
}

/**
 * A raw observation handed to the engine. Domain-agnostic on purpose: the engine
 * does not know these came from file edits or a git journal. Capture maps journal
 * entries onto this shape.
 */
export interface RawObservation {
  /** Stable id of the source record (used for provenance). */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** The decision this observation was attached to, or null if unattached. */
  decisionId: string | null;
  /** Intent of the attached decision, if known. */
  decisionIntent?: string | null;
  /** Alternatives weighed in the attached decision, if known. */
  decisionAlternatives?: string[];
  /** A path/identifier this observation touched (repo-relative file path, in practice). */
  file: string;
  /** Short description of what changed (e.g. tool name or "edited"). */
  change: string;
  /** A cheap, raw reason snapshot. The engine refines this via `complete()`. */
  reason: string;
}

/** Level-0 atom: one decision, bound to the specific code it touched. */
export interface DecisionAtom {
  id: string;
  /** 8-char hex id, Lore-compatible. Equals `id` for level-0 atoms. */
  loreId: string;
  level: 0;
  decisionId: string;
  intent: string;
  summary: string;
  /** Repo-relative paths this decision touched. The code index. */
  files: string[];
  constraints: string[];
  rejected: Rejected[];
  confidence: Confidence;
  /** loreIds of decisions this one supersedes (evolution links). */
  supersedes: string[];
  createdAt: string;
  /** RawObservation ids that produced this atom. Provenance. */
  sourceIds: string[];
  /**
   * Derived, NOT persisted. Set at read-assembly time when all of this atom's
   * `files` are absent from HEAD (the code it describes is gone). The engine
   * only reads this flag; the git-aware layers compute it. `writeNote` strips it
   * before serialization, so it never lands in the notes graph. See DESIGN.md.
   */
  stale?: boolean;
}

/** Level-1 atom: a rollup of several level-0 atoms, for budget compaction. */
export interface RollupAtom {
  id: string;
  loreId: string;
  level: 1;
  summary: string;
  files: string[];
  createdAt: string;
  /** loreIds of the level-0 atoms this rollup covers. Provenance so deeper levels
   *  can be reconstructed later without migration. */
  sourceIds: string[];
  /** Derived, NOT persisted — see {@link DecisionAtom.stale}. */
  stale?: boolean;
}

export type Atom = DecisionAtom | RollupAtom;

export function isDecisionAtom(a: Atom): a is DecisionAtom {
  return a.level === 0;
}

export function isRollupAtom(a: Atom): a is RollupAtom {
  return a.level === 1;
}

/**
 * The single injected capability. A thin async text-completion call.
 * The engine passes a prompt (and optional system) and gets text back.
 * No model name, no SDK, no transport — those live outside the engine.
 */
export type Complete = (
  prompt: string,
  opts?: { system?: string; maxTokens?: number }
) => Promise<string>;

export interface RecallQuery {
  /** Return the decision chain for this file (repo-relative). */
  file?: string;
  /** Return the most recent N decisions. */
  recent?: number;
  /** Hard token ceiling for the result. */
  tokenBudget: number;
}

export interface RecallResult {
  atoms: Atom[];
  tokensUsed: number;
  /** True if atoms were dropped to fit the budget. */
  truncated: boolean;
}
