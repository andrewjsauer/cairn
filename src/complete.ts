import Anthropic from "@anthropic-ai/sdk";
import type { Complete } from "./engine/types.js";
import { MODEL } from "./config.js";

/**
 * The concrete `complete()` injected into the engine. This is the one adapter
 * that imports the Anthropic SDK; the engine never sees it. Swapping models or
 * providers is a change here and in config.ts only.
 */
export function makeComplete(): Complete {
  // Without a key, return a stub that always throws. The engine's ingest/compact
  // catch per-call failures and fall back to deterministic records, so capture
  // still works (with recorded intent + raw reasons) — just without model polish.
  if (!process.env.ANTHROPIC_API_KEY) {
    return async () => {
      throw new Error("ANTHROPIC_API_KEY not set; using deterministic fallback");
    };
  }
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return async (prompt, opts) => {
    const message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: opts?.maxTokens ?? 1024,
        system: opts?.system,
        messages: [{ role: "user", content: prompt }],
      },
      // Consolidation runs synchronously in the commit hook; never let a hung
      // request block the session. On timeout the call throws and capture falls
      // back to a deterministic record, preserving the journal.
      { timeout: 30_000 }
    );
    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  };
}
