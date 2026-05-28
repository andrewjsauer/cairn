import { existsSync, readFileSync } from "node:fs";

/**
 * Cheap reason snapshot from the session transcript (Section 7: "reason
 * snapshotted cheaply from the transcript"). No model call — that would defeat
 * the point of the synchronous edit-time journal. We just read the transcript
 * JSONL tail and pull the most recent assistant text, which is almost always
 * the agent explaining what it is about to do right before the edit.
 *
 * The real, refined reason is synthesized later at consolidation by the engine.
 * This is only a durable breadcrumb so that synthesis has raw material even if
 * the session is torn down immediately after the edit.
 */
export function lastAssistantText(transcriptPath: string | undefined): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return "";
  }
  // Walk backward to the latest assistant message with text content.
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = extractAssistantText(entry);
    if (text) return truncate(text, 600);
  }
  return "";
}

function extractAssistantText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const e = entry as Record<string, unknown>;
  // Claude Code transcript entries wrap an Anthropic message under `message`.
  const message = (e.message ?? e) as Record<string, unknown>;
  if (message.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
    .map((b) => String((b as Record<string, unknown>).text ?? ""))
    .join(" ")
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}
