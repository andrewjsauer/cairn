import { test } from "node:test";
import assert from "node:assert/strict";
import { emitTrailers, parseTrailers, stripCairnTrailers } from "../src/store/trailers.js";

/**
 * Lore interop is a real claim, not a vibe: what we emit must round-trip, and a
 * hand-written Lore block from another tool must parse. Field names/casing are
 * pinned to the Lore spec (Lore-id, Constraint, Rejected "alt | reason",
 * Confidence enum, Supersedes).
 */

test("emit -> parse round-trips a Lore record", () => {
  const record = {
    loreId: "a1b2c3d4",
    constraints: ["auth service has no token introspection"],
    rejected: [{ alternative: "extend token TTL to 24h", reason: "security policy" }],
    confidence: "high" as const,
    supersedes: ["f7e8d9c0"],
  };
  const block = emitTrailers(record);
  const parsed = parseTrailers(block);
  assert.ok(parsed);
  assert.equal(parsed!.loreId, "a1b2c3d4");
  assert.deepEqual(parsed!.constraints, record.constraints);
  assert.deepEqual(parsed!.rejected, record.rejected);
  assert.equal(parsed!.confidence, "high");
  assert.deepEqual(parsed!.supersedes, ["f7e8d9c0"]);
});

test("emitted block uses exact Lore trailer keys and pipe-separated Rejected", () => {
  const block = emitTrailers({
    loreId: "deadbeef",
    constraints: ["c"],
    rejected: [{ alternative: "A", reason: "B" }],
    confidence: "medium",
    supersedes: [],
  });
  assert.match(block, /^Lore-id: deadbeef$/m);
  assert.match(block, /^Constraint: c$/m);
  assert.match(block, /^Rejected: A \| B$/m);
  assert.match(block, /^Confidence: medium$/m);
});

test("parses a Lore block authored by another tool, ignoring unknown keys", () => {
  // Note the extra Lore keys Cairn doesn't emit (Scope-risk, Directive): they
  // must be ignored, not break the parse.
  const message = [
    "fix: broaden auth error handling",
    "",
    "Body text describing the change.",
    "",
    "Lore-id: 99887766",
    "Constraint: upstream returns 4xx for all auth failures",
    "Rejected: per-code handling | upstream codes are unstable",
    "Scope-risk: narrow",
    "Directive: [until:auth-v3] keep error handling broad",
    "Confidence: low",
  ].join("\n");
  const parsed = parseTrailers(message);
  assert.ok(parsed, "should parse a foreign Lore record");
  assert.equal(parsed!.loreId, "99887766");
  assert.equal(parsed!.confidence, "low");
  assert.equal(parsed!.constraints.length, 1);
  assert.equal(parsed!.rejected[0].alternative, "per-code handling");
  assert.equal(parsed!.rejected[0].reason, "upstream codes are unstable");
});

test("returns null when there is no Lore-id trailer", () => {
  const message = "chore: tidy up\n\nSigned-off-by: Someone <x@y.z>\n";
  assert.equal(parseTrailers(message), null);
});

// A re-amend must never corrupt another tool's trailers, and nothing Cairn
// emits may be able to forge a trailer line.

const FOREIGN_TRAILERS = "Signed-off-by: A <a@b.c>\nAcked-by: someone\n  with a wrapped value";

test("stripCairnTrailers preserves foreign trailers including folded continuations", () => {
  const message = [
    "feat: mixed trailer block",
    "",
    "Body text.",
    "",
    "Lore-id: a1b2c3d4",
    "Constraint: auth service has no token introspection",
    FOREIGN_TRAILERS,
    "Confidence: high",
  ].join("\n");
  const stripped = stripCairnTrailers(message);
  assert.ok(stripped.includes("Signed-off-by: A <a@b.c>"), "Signed-off-by must survive");
  assert.ok(
    stripped.includes("Acked-by: someone\n  with a wrapped value"),
    "folded foreign trailer must survive including its continuation line"
  );
  assert.doesNotMatch(stripped, /^(Lore-id|Constraint|Rejected|Confidence|Supersedes):/m);
});

test("re-amend round-trip: exactly one Lore-id, foreign trailers intact byte-for-byte", () => {
  const record = {
    loreId: "a1b2c3d4",
    constraints: ["keep handling broad"],
    rejected: [],
    confidence: "high" as const,
    supersedes: [],
  };
  // First consolidation: Cairn block lands in the same trailer block as the
  // pre-existing foreign trailers (e.g. a sign-off tool ran in between).
  const base = `feat: x\n\nBody.\n\n${FOREIGN_TRAILERS}`;
  const once = `${base}\n${emitTrailers(record)}`;
  // Re-amend: strip our block, re-emit a fresh one.
  const reEmitted = { ...record, loreId: "e5f6a7b8" };
  const twice = `${stripCairnTrailers(once)}\n${emitTrailers(reEmitted)}`;
  assert.equal(twice.match(/^Lore-id:/gm)!.length, 1, "exactly one Lore-id after re-amend");
  assert.equal(parseTrailers(twice)!.loreId, "e5f6a7b8");
  assert.ok(twice.includes(FOREIGN_TRAILERS), "foreign trailers intact byte-for-byte");
});

test("emitTrailers drops Supersedes values that are not 8-char hex ids", () => {
  const block = emitTrailers({
    loreId: "a1b2c3d4",
    constraints: [],
    rejected: [],
    confidence: "medium",
    supersedes: ["abcdef12", "evil\nLore-id: 99999999", "not-hex"],
  });
  assert.deepEqual(parseTrailers(block)!.supersedes, ["abcdef12"]);
  assert.equal(block.match(/^Lore-id:/gm)!.length, 1, "injected Lore-id must not be emitted");
  // No emitted value may forge a trailer line: every line in the block is a
  // single well-formed "Key: value" line.
  for (const line of block.split("\n")) {
    assert.match(line, /^[A-Za-z-]+: [^\n]*$/);
  }
});

test("emitTrailers collapses embedded newlines in Constraint to one line", () => {
  const block = emitTrailers({
    loreId: "a1b2c3d4",
    constraints: ["line1\nline2"],
    rejected: [],
    confidence: "medium",
    supersedes: [],
  });
  assert.match(block, /^Constraint: line1 line2$/m);
  for (const line of block.split("\n")) {
    assert.match(line, /^[A-Za-z-]+: [^\n]*$/);
  }
});
