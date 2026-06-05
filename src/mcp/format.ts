import type { Atom, RecallResult } from "../engine/index.js";
import { isDecisionAtom } from "../engine/index.js";

/**
 * Render a recall result as the text an agent reads. why() presents the chain
 * oldest -> newest so the *evolution* of the thinking is visible, which is the
 * context a newcomer actually needs (Section 7).
 */
export function formatChain(file: string, result: RecallResult): string {
  if (result.atoms.length === 0) {
    return `No recorded decisions touch ${file}. Cairn has nothing on this file yet.`;
  }
  const head = `Decision chain for ${file} (${result.atoms.length} record(s), oldest first):`;
  const body = result.atoms.map((a, i) => `${i + 1}. ${renderForRead(a)}`).join("\n\n");
  return [head, "", body, budgetNote(result)].filter(Boolean).join("\n");
}

export function formatRecent(n: number, result: RecallResult): string {
  if (result.atoms.length === 0) {
    return "Cairn has no recorded decisions yet.";
  }
  const head = `${result.atoms.length} most recent decision(s) (newest first, up to ${n}):`;
  const body = result.atoms.map((a, i) => `${i + 1}. ${renderForRead(a)}`).join("\n\n");
  return [head, "", body, budgetNote(result)].filter(Boolean).join("\n");
}

/** Terse, honest marker: the code this record describes is gone from HEAD. */
const STALE_TAG = "  ⚠ STALE — code no longer present at HEAD";
/** The approach was undone — but the constraints it recorded may still bite.
 *  Deliberately NOT "ignore this": the don't-retry signal is the value. */
const REVERTED_TAG = "  ↩ REVERTED — this approach was undone; its constraints may still apply";

function renderForRead(atom: Atom): string {
  const date = atom.createdAt.slice(0, 10);
  const flags = `${atom.reverted ? REVERTED_TAG : ""}${atom.stale ? STALE_TAG : ""}`;
  if (isDecisionAtom(atom)) {
    const lines: string[] = [`(${date}) ${atom.intent}  [lore-id ${atom.loreId}]${flags}`];
    if (atom.summary) lines.push(`   ${atom.summary}`);
    for (const c of atom.constraints) lines.push(`   • constraint: ${c}`);
    for (const r of atom.rejected) {
      lines.push(`   • rejected: ${r.alternative}${r.reason ? ` — ${r.reason}` : ""}`);
    }
    lines.push(`   confidence: ${atom.confidence}`);
    if (atom.supersedes.length) lines.push(`   supersedes: ${atom.supersedes.join(", ")}`);
    return lines.join("\n");
  }
  return `(${date}) [rollup of ${atom.sourceIds.length}] ${atom.summary}  [lore-id ${atom.loreId}]${flags}`;
}

function budgetNote(result: RecallResult): string {
  const base = `\n(~${result.tokensUsed} tokens`;
  return result.truncated
    ? `${base}; older records were rolled up or trimmed to stay under budget.)`
    : `${base}.)`;
}
