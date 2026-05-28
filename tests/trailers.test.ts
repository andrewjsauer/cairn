import { test } from "node:test";
import assert from "node:assert/strict";
import { emitTrailers, parseTrailers } from "../src/store/trailers.js";

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
