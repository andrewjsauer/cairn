/**
 * One place for the knobs. The model is behind a single constant so it can be
 * swapped without touching capture or the engine.
 */

/** Model used for capture + consolidation (the injected complete()). */
export const MODEL = "claude-haiku-4-5-20251001";

/** Token ceiling for a single recall result handed to an agent (why / recent). */
export const RECALL_TOKEN_BUDGET = 2000;

/** Token ceiling the graph is compacted to at consolidation time. */
export const COMPACT_TOKEN_BUDGET = 4000;

/** Default count for recent(n). */
export const DEFAULT_RECENT = 10;

/** git-notes namespace. Resolves to refs/notes/cairn. */
export const NOTES_REF = "cairn";
