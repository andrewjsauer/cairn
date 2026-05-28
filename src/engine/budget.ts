import type { Atom } from "./types.js";
import { isDecisionAtom } from "./types.js";

/**
 * Token estimation, deliberately crude. We never need exact token counts — only
 * a stable, monotonic proxy to keep recall and compaction under a ceiling. The
 * widely-used ~4-chars-per-token heuristic is good enough and has no dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The rendered, agent-facing form of an atom, and its token cost. Recall budgets
 *  against what the agent will actually read, not the raw JSON. */
export function renderAtom(atom: Atom): string {
  if (isDecisionAtom(atom)) {
    const lines: string[] = [];
    lines.push(`[${atom.loreId}] ${atom.intent}`);
    lines.push(atom.summary);
    if (atom.constraints.length) {
      lines.push(`Constraints: ${atom.constraints.join("; ")}`);
    }
    if (atom.rejected.length) {
      lines.push(
        `Rejected: ${atom.rejected
          .map((r) => `${r.alternative} (${r.reason})`)
          .join("; ")}`
      );
    }
    lines.push(`Confidence: ${atom.confidence}`);
    if (atom.supersedes.length) {
      lines.push(`Supersedes: ${atom.supersedes.join(", ")}`);
    }
    lines.push(`Files: ${atom.files.join(", ")}`);
    return lines.join("\n");
  }
  return `[${atom.loreId}] (rollup of ${atom.sourceIds.length}) ${atom.summary}\nFiles: ${atom.files.join(", ")}`;
}

export function atomTokens(atom: Atom): number {
  return estimateTokens(renderAtom(atom));
}
