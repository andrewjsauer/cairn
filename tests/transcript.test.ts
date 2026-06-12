import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lastAssistantText } from "../src/capture/transcript.js";

/**
 * The cheap edit-time reason snapshot: walk the transcript JSONL backward to
 * the latest assistant TEXT, skipping corrupt lines, tool_use blocks, and
 * non-assistant entries. No model call — this is the durability breadcrumb.
 */

function fixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-transcript-"));
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

test("lastAssistantText skips a corrupt tail, tool_use blocks, and user lines", () => {
  const p = fixture([
    JSON.stringify({ role: "user", content: "please add retry" }),
    JSON.stringify({
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        { type: "text", text: "I will add retry" },
      ],
    }),
    "{not json", // crash-truncated tail line
  ]);
  assert.equal(lastAssistantText(p), "I will add retry");
});

test("lastAssistantText reads bare string content", () => {
  const p = fixture([
    JSON.stringify({ role: "assistant", content: "plain string reasoning" }),
  ]);
  assert.equal(lastAssistantText(p), "plain string reasoning");
});

test("lastAssistantText unwraps the Claude Code `message` envelope", () => {
  const p = fixture([
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "wrapped reasoning" }] },
    }),
  ]);
  assert.equal(lastAssistantText(p), "wrapped reasoning");
});

test("lastAssistantText truncates long text to 600 chars plus an ellipsis", () => {
  const long = "x".repeat(700);
  const p = fixture([JSON.stringify({ role: "assistant", content: long })]);
  const out = lastAssistantText(p);
  assert.equal(out, "x".repeat(600) + "…");
  assert.equal(out.length, 601);
});

test("lastAssistantText returns '' for missing, empty, and nonexistent paths", () => {
  assert.equal(lastAssistantText(undefined), "");
  assert.equal(lastAssistantText(""), "");
  assert.equal(lastAssistantText(join(tmpdir(), "cairn-no-such-transcript.jsonl")), "");
  const empty = fixture([]);
  assert.equal(lastAssistantText(empty), "");
});
