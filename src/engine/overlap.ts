import type { DecisionAtom } from "./types.js";

/**
 * Five-dimension overlap scoring, borrowed from Every's compound-engineering
 * plugin and adapted to decision atoms. The question it answers: "is this new
 * decision really the same decision as one we already have?" — which drives
 * dedup and the supersedes/evolution links rather than blindly appending.
 *
 * Pure and dependency-free: just set/text math. Capture (src/capture/) is the
 * consumer that turns a score into a dedup/supersede decision.
 */

const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "with", "is",
  "it", "this", "that", "be", "as", "at", "by", "we", "use", "using", "so",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** A dimension with no signal on either side carries no information, so it is
 *  excluded from the mean rather than counted as a zero — otherwise two
 *  identical decisions with empty constraints would score artificially low. */
function dim<T>(a: Set<T>, b: Set<T>): { value: number; active: boolean } {
  const active = a.size > 0 || b.size > 0;
  return { value: active ? jaccard(a, b) : 0, active };
}

export interface OverlapBreakdown {
  files: number;
  intent: number;
  constraints: number;
  rejected: number;
  summary: number;
  /** Mean of the five dimensions. */
  score: number;
}

export function fiveDimensionOverlap(
  a: DecisionAtom,
  b: DecisionAtom
): OverlapBreakdown {
  const files = dim(new Set(a.files), new Set(b.files));
  const intent = dim(tokenize(a.intent), tokenize(b.intent));
  const constraints = dim(
    tokenize(a.constraints.join(" ")),
    tokenize(b.constraints.join(" "))
  );
  const rejected = dim(
    tokenize(a.rejected.map((r) => r.alternative).join(" ")),
    tokenize(b.rejected.map((r) => r.alternative).join(" "))
  );
  const summary = dim(tokenize(a.summary), tokenize(b.summary));

  const dims = [files, intent, constraints, rejected, summary];
  const active = dims.filter((d) => d.active);
  const score = active.length
    ? active.reduce((sum, d) => sum + d.value, 0) / active.length
    : 0;

  return {
    files: files.value,
    intent: intent.value,
    constraints: constraints.value,
    rejected: rejected.value,
    summary: summary.value,
    score,
  };
}

/** Default threshold above which two atoms are treated as the same decision. */
export const SAME_DECISION_THRESHOLD = 0.5;
