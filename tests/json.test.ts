import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson } from "../src/engine/json.js";

/**
 * Pure tests for the defensive JSON extractor. Models wrap JSON in fences and
 * prose despite instructions; the engine's fallbacks depend on extractJson
 * returning null (never throwing) when nothing parseable exists.
 */

test("extractJson parses a ```json fenced block", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test("extractJson finds JSON embedded in prose before and after", () => {
  const text = 'Sure! Here is the record you asked for: {"a":1,"b":[2,3]} — hope that helps.';
  assert.deepEqual(extractJson(text), { a: 1, b: [2, 3] });
});

test("extractJson handles braces and escaped quotes inside string values", () => {
  const text = 'The result is {"s":"brace } in \\" string"} as requested.';
  assert.deepEqual(extractJson(text), { s: 'brace } in " string' });
});

test("extractJson finds an array embedded in prose", () => {
  assert.deepEqual(extractJson("the list is [1,2] ok"), [1, 2]);
});

test("extractJson returns null when there is no JSON at all", () => {
  assert.equal(extractJson("no json here"), null);
});

test("extractJson returns null on truncated/unterminated JSON", () => {
  assert.equal(extractJson('{"unterminated": '), null);
});
