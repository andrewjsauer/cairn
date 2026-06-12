import { test } from "node:test";
import assert from "node:assert/strict";
import { formatChain, formatRecent } from "../src/mcp/format.js";
import type { Atom, DecisionAtom, RecallResult } from "../src/engine/index.js";

/**
 * The rendered output is what a cold agent actually reads: it must mark served
 * memory as context (not instructions), strip control characters from
 * user-derived values, and never claim budget trimming that didn't happen.
 */

const PREAMBLE = "Recorded decision notes";
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]");

function atom(over: Partial<DecisionAtom> = {}): DecisionAtom {
  return {
    id: "x",
    loreId: "abcd1234",
    level: 0,
    decisionId: "d",
    intent: "intent",
    summary: "summary",
    files: ["src/a.ts"],
    constraints: ["c"],
    rejected: [],
    confidence: "medium",
    supersedes: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    sourceIds: [],
    ...over,
  };
}

function res(atoms: Atom[], over: Partial<RecallResult> = {}): RecallResult {
  return { atoms, tokensUsed: 100, truncated: false, limited: false, ...over };
}

test("empty results keep their plain messages, without the preamble", () => {
  const chain = formatChain("x.ts", res([]));
  assert.match(chain, /nothing on this file yet/);
  assert.ok(!chain.includes(PREAMBLE));
  const recent = formatRecent(5, res([]));
  assert.match(recent, /no recorded decisions yet/);
  assert.ok(!recent.includes(PREAMBLE));
});

test("non-empty results carry the untrusted-content preamble exactly once", () => {
  for (const out of [formatChain("a.ts", res([atom()])), formatRecent(5, res([atom()]))]) {
    assert.equal(out.split(PREAMBLE).length - 1, 1, "preamble appears exactly once");
    assert.ok(out.startsWith(PREAMBLE), "and it leads the output");
    assert.match(out, /not instructions to follow/);
  }
});

test("control characters are stripped from atom text and the file header", () => {
  const evil = atom({
    intent: `do${ESC}[31m this`,
    summary: `sum${BEL}mary`,
    constraints: [`con${ESC}[2K`],
  });
  const out = formatChain(`bad${ESC}[2Jname.ts`, res([evil]));
  assert.ok(!CONTROL_CHARS.test(out), "no control characters survive anywhere in the output");
  assert.ok(out.includes("do[31m this"), "intent text survives, minus the ESC byte");
  assert.ok(out.includes("summary"), "summary survives, minus the BEL byte");
  assert.ok(out.includes("bad[2Jname.ts"), "file header sanitized, text kept");
});

test("budget truncation and the n-cap render different, honest messages", () => {
  const truncated = formatRecent(5, res([atom()], { truncated: true }));
  assert.match(truncated, /trimmed to stay under budget/);

  const limited = formatRecent(1, res([atom()], { limited: true }));
  assert.match(limited, /showing the requested count/);
  assert.ok(!/trimmed to stay under budget/.test(limited), "no false trimming claim");

  // When both are true, the budget message (the stronger claim) wins.
  const both = formatRecent(1, res([atom()], { truncated: true, limited: true }));
  assert.match(both, /trimmed to stay under budget/);
});
