import type {
  Complete,
  Confidence,
  DecisionAtom,
  RawObservation,
  Rejected,
} from "./types.js";
import { idFrom } from "./hash.js";
import { extractJson } from "./json.js";

/**
 * ingest(): fold raw observations into level-0 decision atoms.
 *
 * Grouping is by *decision*, never by folder (Section 7 of the brief):
 *   - Observations attached to a decision (decisionId set) are grouped by that
 *     id and synthesized into one atom each, using the decision's recorded
 *     intent + alternatives.
 *   - Unattached observations are clustered into *inferred* decisions by the
 *     model from the changes and reasons, then synthesized the same way.
 *
 * `complete()` is the only injected capability. If it fails or returns garbage,
 * we fall back to a deterministic atom so consolidation never loses a record.
 */
export async function ingest(
  observations: RawObservation[],
  complete: Complete,
  opts: { now?: string } = {}
): Promise<DecisionAtom[]> {
  if (observations.length === 0) return [];
  const now = opts.now ?? new Date().toISOString();

  const attached = new Map<string, RawObservation[]>();
  const unattached: RawObservation[] = [];
  for (const obs of observations) {
    if (obs.decisionId) {
      const group = attached.get(obs.decisionId) ?? [];
      group.push(obs);
      attached.set(obs.decisionId, group);
    } else {
      unattached.push(obs);
    }
  }

  const atoms: DecisionAtom[] = [];

  for (const [decisionId, group] of attached) {
    atoms.push(await synthesizeAtom(decisionId, group, complete, now));
  }

  if (unattached.length > 0) {
    const clusters = await inferClusters(unattached, complete);
    for (const cluster of clusters) {
      const decisionId = `inferred-${idFrom(...cluster.map((o) => o.id).sort())}`;
      atoms.push(await synthesizeAtom(decisionId, cluster, complete, now));
    }
  }

  return atoms;
}

interface SynthResult {
  intent?: string;
  summary?: string;
  constraints?: string[];
  rejected?: Rejected[];
  confidence?: Confidence;
}

async function synthesizeAtom(
  decisionId: string,
  group: RawObservation[],
  complete: Complete,
  now: string
): Promise<DecisionAtom> {
  const files = unique(group.map((o) => o.file));
  const recordedIntent = group.find((o) => o.decisionIntent)?.decisionIntent ?? null;
  const recordedAlternatives = unique(
    group.flatMap((o) => o.decisionAlternatives ?? [])
  );

  const prompt = synthesisPrompt(group, recordedIntent, recordedAlternatives);
  let result: SynthResult = {};
  try {
    const raw = await complete(prompt, {
      system: SYNTHESIS_SYSTEM,
      maxTokens: 700,
    });
    result = extractJson<SynthResult>(raw) ?? {};
  } catch {
    result = {};
  }

  const intent = clean(result.intent) || recordedIntent || fallbackIntent(group);
  const summary = clean(result.summary) || fallbackSummary(group);
  const constraints = (result.constraints ?? []).map(clean).filter(Boolean);
  const rejected = normalizeRejected(result.rejected, recordedAlternatives);
  const confidence = normalizeConfidence(result.confidence);
  const createdAt = latestTs(group, now);
  const sourceIds = group.map((o) => o.id).sort();

  // Deterministic id from stable content -> idempotent re-consolidation.
  const id = idFrom(decisionId, intent, ...sourceIds);

  return {
    id,
    loreId: id,
    level: 0,
    decisionId,
    intent,
    summary,
    files,
    constraints,
    rejected,
    confidence,
    supersedes: [],
    createdAt,
    sourceIds,
  };
}

async function inferClusters(
  observations: RawObservation[],
  complete: Complete
): Promise<RawObservation[][]> {
  // Single observation can't be meaningfully clustered.
  if (observations.length === 1) return [observations];

  const byId = new Map(observations.map((o) => [o.id, o]));
  const prompt = clusterPrompt(observations);
  try {
    const raw = await complete(prompt, { system: CLUSTER_SYSTEM, maxTokens: 600 });
    const parsed = extractJson<{ clusters: string[][] }>(raw);
    if (parsed?.clusters?.length) {
      const clusters: RawObservation[][] = [];
      const seen = new Set<string>();
      for (const ids of parsed.clusters) {
        // Mark each id as seen AT ACCEPTANCE so a model that repeats an id —
        // within one cluster or across clusters — never maps it twice.
        const members = ids
          .map((id) => byId.get(id))
          .filter((o): o is RawObservation => {
            if (!o || seen.has(o.id)) return false;
            seen.add(o.id);
            return true;
          });
        if (members.length) clusters.push(members);
      }
      // Any observation the model dropped becomes its own cluster.
      const leftovers = observations.filter((o) => !seen.has(o.id));
      for (const o of leftovers) clusters.push([o]);
      if (clusters.length) return clusters;
    }
  } catch {
    // fall through
  }
  // Fallback: one inferred decision per file (still decision-ish, never by folder).
  return clusterByFile(observations);
}

function clusterByFile(observations: RawObservation[]): RawObservation[][] {
  const byFile = new Map<string, RawObservation[]>();
  for (const o of observations) {
    const g = byFile.get(o.file) ?? [];
    g.push(o);
    byFile.set(o.file, g);
  }
  return [...byFile.values()];
}

// ---- prompts ----

const SYNTHESIS_SYSTEM =
  "You distill raw coding-session notes into one decision record. You capture WHY the code is the way it is: the intent, the hard constraints that shaped it, and alternatives that were rejected. Be terse and concrete. Output ONLY JSON.";

function synthesisPrompt(
  group: RawObservation[],
  intent: string | null,
  alternatives: string[]
): string {
  const obs = group
    .map(
      (o, i) =>
        `${i + 1}. file=${o.file} change=${o.change} reason="${o.reason}"`
    )
    .join("\n");
  return [
    intent ? `Stated intent: ${intent}` : "Intent was not stated; infer it.",
    alternatives.length
      ? `Alternatives weighed: ${alternatives.join("; ")}`
      : "",
    "",
    "Edit-time observations:",
    obs,
    "",
    "Return JSON of exactly this shape:",
    `{"intent": string, "summary": string, "constraints": string[], "rejected": [{"alternative": string, "reason": string}], "confidence": "low"|"medium"|"high"}`,
    "summary: 1-2 sentences on what was decided and why. constraints/rejected: [] if none. confidence: how settled the decision seems.",
  ]
    .filter(Boolean)
    .join("\n");
}

const CLUSTER_SYSTEM =
  "You group raw coding-session edits into distinct decisions by shared reasoning, NOT by folder or file path. Output ONLY JSON.";

function clusterPrompt(observations: RawObservation[]): string {
  const obs = observations
    .map((o) => `id=${o.id} file=${o.file} change=${o.change} reason="${o.reason}"`)
    .join("\n");
  return [
    "These edits had no decision attached. Cluster them into distinct decisions by shared reasoning.",
    "Edits sharing one rationale belong together even across different files. Unrelated edits in the same file belong apart.",
    "",
    obs,
    "",
    'Return JSON: {"clusters": [["id1","id2"], ["id3"]]}. Every id must appear in exactly one cluster.',
  ].join("\n");
}

// ---- normalization / fallbacks ----

function normalizeConfidence(c: unknown): Confidence {
  return c === "low" || c === "medium" || c === "high" ? c : "medium";
}

function normalizeRejected(
  r: Rejected[] | undefined,
  alternatives: string[]
): Rejected[] {
  if (Array.isArray(r) && r.length) {
    return r
      .map((x) => ({
        alternative: clean(x?.alternative),
        reason: clean(x?.reason),
      }))
      .filter((x) => x.alternative);
  }
  // If the model gave nothing but we recorded alternatives, keep them.
  return alternatives.map((a) => ({ alternative: a, reason: "" }));
}

function fallbackIntent(group: RawObservation[]): string {
  return `Changes to ${unique(group.map((o) => o.file)).join(", ")}`;
}

function fallbackSummary(group: RawObservation[]): string {
  const reasons = unique(group.map((o) => o.reason).filter(Boolean));
  return reasons.length ? reasons.join(" ") : fallbackIntent(group);
}

function latestTs(group: RawObservation[], now: string): string {
  return group.reduce((max, o) => (o.ts > max ? o.ts : max), group[0]?.ts ?? now);
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}
