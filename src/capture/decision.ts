import { idFrom } from "../engine/index.js";
import { openDecision as storeOpenDecision } from "../store/index.js";
import type { DecisionRecord } from "../store/index.js";

/**
 * Open a decision (the manual `/cairn:decision "<intent>"` path; see
 * `openDecisionFromPlan` for the plan-mode auto-open path). Records intent +
 * alternatives so that edit-time journal entries can attach to it, and so
 * consolidation can recover the rich "why" before a diff compresses it away.
 */
export function openDecision(
  cwd: string,
  intent: string,
  alternatives: string[] = [],
  now: string = new Date().toISOString()
): DecisionRecord {
  const id = `dec-${idFrom(intent, now)}`;
  return storeOpenDecision(cwd, { id, intent, alternatives, openedAt: now });
}

/**
 * Auto-open a decision from an approved plan (PostToolUse on ExitPlanMode).
 * The plan is the richest statement of intent there is — captured before a diff
 * compresses it away. We derive a concise intent line from the plan; subsequent
 * edits attach to it and consolidation refines the record from the diff.
 */
export function openDecisionFromPlan(
  cwd: string,
  plan: string,
  now: string = new Date().toISOString()
): DecisionRecord {
  return openDecision(cwd, planIntent(plan), [], now);
}

function planIntent(plan: string): string {
  const firstMeaningful = plan
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, "").trim()) // strip markdown heading/list markers
    .find((l) => l.length > 0);
  const line = firstMeaningful || "Plan-mode decision";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
