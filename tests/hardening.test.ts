import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";
import { isGitCommit } from "../src/cli.js";
import {
  openDecision,
  openDecisionFromPlan,
  recordEdit,
  consolidate,
} from "../src/capture/index.js";
import { getActiveDecisionId, getDecision } from "../src/store/journal.js";
import { parseTrailers } from "../src/store/trailers.js";
import { listNotes } from "../src/store/notes.js";
import { atomsForFile } from "../src/mcp/graph.js";
import type { Complete } from "../src/engine/index.js";

/** Tests that lock in the code-review hardening fixes. */

// --- #3 isGitCommit ---

test("isGitCommit matches a real commit but not amend/decoys", () => {
  assert.equal(isGitCommit("git commit -m 'x'"), true);
  assert.equal(isGitCommit("git add -A && git commit -m 'x'"), true);
  assert.equal(isGitCommit("git commit --amend --no-edit"), false, "amend rewrites, not create");
  assert.equal(isGitCommit("git commit --dry-run"), false);
  assert.equal(isGitCommit("git commit-graph write"), false, "commit-graph is not commit");
  assert.equal(isGitCommit("git log | grep commit"), false, "substring decoy");
  assert.equal(isGitCommit("echo 'time to commit'"), false);
});

// --- #13 parseTrailers: folded lines + pipe-in-alternative ---

test("parseTrailers folds RFC-822 continuation lines", () => {
  const msg = [
    "subject",
    "",
    "Lore-id: abcdef12",
    "Constraint: first part of a long",
    "  constraint that wrapped",
    "Confidence: high",
  ].join("\n");
  const parsed = parseTrailers(msg);
  assert.ok(parsed);
  assert.equal(parsed!.constraints[0], "first part of a long constraint that wrapped");
});

test("parseTrailers splits Rejected on the first pipe only", () => {
  const msg = ["s", "", "Lore-id: abcdef12", "Rejected: use A|B fallback | too slow"].join("\n");
  const parsed = parseTrailers(msg);
  assert.ok(parsed);
  assert.equal(parsed!.rejected[0].alternative, "use A|B fallback");
  assert.equal(parsed!.rejected[0].reason, "too slow");
});

// --- integration helpers ---

function gitC(repo: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: repo, input, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cairn-hard-"));
  gitC(repo, ["init", "-q"]);
  gitC(repo, ["config", "user.email", "t@cairn.dev"]);
  gitC(repo, ["config", "user.name", "T"]);
  gitC(repo, ["commit", "-q", "--allow-empty", "-m", "root"]);
  return repo;
}

const fake: Complete = async (prompt) => {
  if (prompt.includes("Cluster them")) return JSON.stringify({ clusters: [] });
  if (prompt.startsWith("Summarize these related decisions")) return JSON.stringify({ summary: "r" });
  return JSON.stringify({
    intent: "i",
    summary: "s",
    constraints: ["c"],
    rejected: [{ alternative: "a", reason: "why" }],
    confidence: "high",
  });
};

// --- #2 re-consolidation keeps exactly one Lore-id and one note ---

test("re-consolidating the same HEAD replaces (not appends) trailers and the note", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "first", [], now);
  writeFileSync(join(repo, "a.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r1", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: a"]);
  await consolidate(repo, fake, { now });

  // A new edit lands with NO new commit, then we consolidate again on the same logical commit.
  openDecision(repo, "second", [], now);
  writeFileSync(join(repo, "a.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r2", ts: now });
  await consolidate(repo, fake, { now });

  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  const loreIdCount = (message.match(/^Lore-id:/gm) ?? []).length;
  assert.equal(loreIdCount, 1, "exactly one Lore-id per commit after re-consolidation");

  // git's own parser agrees there is exactly one Lore-id.
  const parsed = gitC(repo, ["interpret-trailers", "--parse"], message);
  assert.equal((parsed.match(/^Lore-id:/gm) ?? []).length, 1);

  // The note orphaned by the second amend was removed; exactly one note remains.
  assert.equal(listNotes(repo).length, 1, "no orphaned notes accumulate");
});

// --- inbound Lore interop: a foreign trailer (no Cairn note) is read by why() ---

test("atomsForFile reads a Lore record written by another tool (no Cairn note)", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "b.ts"), "x\n");
  gitC(repo, ["add", "-A"]);
  // Commit authored with a hand-written Lore trailer block, as a foreign tool would.
  const msg = [
    "feat: foreign change",
    "",
    "Lore-id: 0badf00d",
    "Constraint: must stay backward compatible",
    "Confidence: medium",
  ].join("\n");
  gitC(repo, ["commit", "-q", "-F", "-"], msg);

  const atoms = atomsForFile(repo, "b.ts");
  assert.equal(atoms.length, 1, "foreign Lore record surfaces via the trailer path");
  assert.equal(atoms[0].loreId, "0badf00d");
  assert.deepEqual(atoms[0].constraints, ["must stay backward compatible"]);
});

// --- #8 NotePayload version gate ---

test("readNote-backed reads ignore a future note schema version", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "c.ts"), "x\n");
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: c"]);
  // A note written by a hypothetical future Cairn (v:2) must not be mis-read.
  gitC(repo, ["notes", "--ref=cairn", "add", "-f", "-F", "-", "HEAD"], JSON.stringify({ v: 2, atoms: [{ loreId: "x", files: ["c.ts"] }] }));
  const atoms = atomsForFile(repo, "c.ts");
  assert.equal(atoms.length, 0, "v:2 note skipped, not surfaced as v:1");
});

// --- #1 open-decision-stdin treats intent as literal text (no shell eval) ---

test("open-decision-stdin stores a metachar-laden intent verbatim", () => {
  const repo = makeRepo();
  const cli = join(process.cwd(), "dist", "cli.js");
  const evil = "retry logic; touch PWNED && echo $(whoami) `id`";
  const r = spawnSync("node", [cli, "open-decision-stdin"], { cwd: repo, input: evil, encoding: "utf8" });
  assert.equal(r.status, 0);
  const id = getActiveDecisionId(repo);
  assert.ok(id);
  // The intent round-trips exactly — proof it was read as data, not a command.
  assert.equal(getDecision(repo, id!)!.intent, evil);
});

// --- deferred trigger: plan-mode auto-open derives intent from the plan ---

test("openDecisionFromPlan derives a concise intent from the plan's first line", () => {
  const repo = makeRepo();
  const plan = "# Add retry to the client\n\n- step one\n- step two";
  const rec = openDecisionFromPlan(repo, plan, "2026-05-20T00:00:00.000Z");
  assert.equal(rec.intent, "Add retry to the client", "strips markdown heading marker");
  assert.equal(getActiveDecisionId(repo), rec.id, "becomes the active decision");
});

// --- deferred trigger: notes-only flush (no commit to amend) ---

test("flush consolidates to the notes graph WITHOUT amending the commit message", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  const headBefore = gitC(repo, ["rev-parse", "HEAD"]);
  openDecision(repo, "in-flight decision, not yet committed", [], now);
  writeFileSync(join(repo, "wip.ts"), "draft\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "wip.ts"), reason: "drafting", ts: now });

  // Notes-only consolidation (the PreCompact / SessionEnd / SessionStart path).
  const result = await consolidate(repo, fake, { now, writeTrailers: false });
  assert.equal(result.amended, false, "non-commit flush never amends");

  // HEAD is untouched: no Lore trailers were written to the commit message.
  assert.equal(gitC(repo, ["rev-parse", "HEAD"]), headBefore, "commit not rewritten");
  assert.equal(parseTrailers(gitC(repo, ["show", "-s", "--format=%B", "HEAD"])), null);

  // ...but the reasoning is now queryable via the notes graph.
  const atoms = atomsForFile(repo, "wip.ts");
  assert.equal(atoms.length, 1, "in-flight decision is queryable before any commit");
});

// --- regression: a flush must NOT clobber the commit's note on the same HEAD ---

test("flush merges into the commit's note instead of overwriting it", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";

  // Commit-consolidate a decision touching committed.ts.
  openDecision(repo, "committed decision", [], now);
  writeFileSync(join(repo, "committed.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "committed.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: committed"]);
  await consolidate(repo, fake, { now });

  // Now an in-flight edit + a notes-only flush on the SAME HEAD.
  openDecision(repo, "in-flight decision", [], now);
  writeFileSync(join(repo, "inflight.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "inflight.ts"), reason: "r2", ts: now });
  await consolidate(repo, fake, { now, writeTrailers: false });

  // BOTH decisions must still be queryable — the flush must not have clobbered
  // the committed one (the bug the dogfood walkthrough caught).
  assert.equal(atomsForFile(repo, "committed.ts").length, 1, "committed decision survives the flush");
  assert.equal(atomsForFile(repo, "inflight.ts").length, 1, "in-flight decision is added");
});

// --- #15 out-of-repo edits are not journaled ---

test("recordEdit ignores edits outside the repo", () => {
  const repo = makeRepo();
  const outside = join(tmpdir(), "definitely-not-in-repo.ts");
  writeFileSync(outside, "x\n");
  const entry = recordEdit(repo, { toolName: "Write", filePath: outside, reason: "r" });
  assert.equal(entry, null, "out-of-repo edit returns null");
});
