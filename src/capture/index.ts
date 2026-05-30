/**
 * Capture: decision open/close, edit-time journaling, consolidation, and the
 * overlap-based dedup that links a decision's evolution. Orchestrates the engine
 * and the store; the engine itself stays unaware of both.
 */
export { openDecision, openDecisionFromPlan } from "./decision.js";
export { recordEdit } from "./journalEntry.js";
export { consolidate, type ConsolidateResult } from "./consolidate.js";
export { consolidateGraph, type DreamResult } from "./dream.js";
export { lastAssistantText } from "./transcript.js";
