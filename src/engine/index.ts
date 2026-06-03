/**
 * The Cairn engine: ingest -> compact -> recall.
 *
 * Hard rule (enforced by tests/decoupling.test.ts): nothing under src/engine/
 * imports git, Claude Code, the store, or the Anthropic SDK. The engine takes an
 * injected `Complete` function and nothing else. See DESIGN.md for why this
 * decoupling is the load-bearing portfolio signal.
 */
export * from "./types.js";
export { ingest } from "./ingest.js";
export { compact, compactGraph } from "./compact.js";
export { recall } from "./recall.js";
export { isStale, resolveRename } from "./staleness.js";
export { fiveDimensionOverlap, SAME_DECISION_THRESHOLD } from "./overlap.js";
export type { OverlapBreakdown } from "./overlap.js";
export { estimateTokens, atomTokens, renderAtom } from "./budget.js";
export { idFrom } from "./hash.js";
