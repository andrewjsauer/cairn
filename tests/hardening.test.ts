import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnSync } from "node:child_process";
import { isGitCommit, commitLandedOnHead } from "../src/cli.js";
import {
  openDecision,
  openDecisionFromPlan,
  recordEdit,
  consolidate,
} from "../src/capture/index.js";
import { getActiveDecisionId, getDecision, readEntries } from "../src/store/journal.js";
import { parseTrailers } from "../src/store/trailers.js";
import { listNotes } from "../src/store/notes.js";
import { isSignedCommit } from "../src/store/git.js";
import { atomsForFile } from "../src/read/graph.js";
import type { Complete } from "../src/engine/index.js";
import { gitC, makeRepo as sharedMakeRepo, fake, fakeEcho, tsxCliArgs } from "./helpers/repo.js";

const makeRepo = () => sharedMakeRepo({ prefix: "cairn-hard-" });

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

test("isGitCommit scopes exclusions to the matched segment, outside quotes", () => {
  // A commit MESSAGE that mentions --amend is still a real commit.
  assert.equal(isGitCommit('git commit -m "fix --amend detection in isGitCommit"'), true);
  assert.equal(isGitCommit("git commit -m 'document --dry-run behavior'"), true);
  // A SIBLING segment that amends does not mask the real commit…
  assert.equal(isGitCommit("git commit -m 'x'; git commit --amend --no-edit"), true);
  // …and an amend alone is still excluded.
  assert.equal(isGitCommit("git add -A && git commit --amend"), false);
  // Documented accepted misses (deferred trigger, journal survives):
  assert.equal(isGitCommit("git -C sub commit -m 'x'"), false);
  assert.equal(isGitCommit("git -c user.name=x commit -m 'x'"), false);
});

// --- C3: the commit-trigger gate — only amend when a commit REALLY landed ---

test("commitLandedOnHead accepts only proof that HEAD is the new commit", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  const payload = (over: object) => ({
    cwd: repo,
    tool_name: "Bash",
    tool_input: { command: "git commit -m x" },
    ...over,
  });

  // A failed command never consolidates with trailers.
  assert.equal(commitLandedOnHead(payload({ tool_output: { exit_code: 1 } })), false, "non-zero exit");

  // Success stdout naming HEAD's sha: positive proof.
  const head = gitC(repo, ["rev-parse", "HEAD"]);
  const short = head.slice(0, 7);
  assert.equal(
    commitLandedOnHead(payload({ tool_output: { exit_code: 0, stdout: `[main ${short}] feat: x\n 1 file changed` } })),
    true,
    "summary line matching HEAD"
  );
  assert.equal(
    commitLandedOnHead(payload({ tool_output: { exit_code: 0, stdout: `[main (root-commit) ${short}] root` } })),
    true,
    "root-commit summary shape"
  );
  assert.equal(
    commitLandedOnHead(payload({ tool_output: { exit_code: 0, stdout: `[detached HEAD ${short}] x` } })),
    true,
    "detached HEAD summary shape"
  );

  // A summary line naming a DIFFERENT sha (commit happened elsewhere — the
  // `cd sub && git commit` shape): reject.
  assert.equal(
    commitLandedOnHead(payload({ tool_output: { exit_code: 0, stdout: "[main 1234567] other repo's commit" } })),
    false,
    "summary sha not at this repo's HEAD"
  );

  // No stdout sha: fresh committer time + HEAD unseen by Cairn → accept.
  writeFileSync(join(repo, "g.ts"), "1\n");
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: g"]);
  assert.equal(
    commitLandedOnHead(payload({ tool_output: { exit_code: 0, stdout: "" } })),
    true,
    "quiet commit: recency + HEAD moved"
  );

  // After consolidation records last-head, the same fresh-looking HEAD is no
  // longer proof: `git commit || true` right after a real commit must demote.
  openDecision(repo, "gate", [], now);
  writeFileSync(join(repo, "g.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "g.ts"), reason: "r", ts: now });
  await consolidate(repo, fakeEcho, { now });
  assert.equal(
    commitLandedOnHead(payload({ tool_input: { command: "git commit -m x || true" }, tool_output: { exit_code: 0, stdout: "" } })),
    false,
    "fresh timestamp but HEAD == last consolidated sha"
  );

  // A sha-like bracket line buried in stdout (an echoed commit message) is
  // NOT git's summary line and cannot act as positive proof: with recency
  // exhausted, the decoy must not flip the gate back open.
  const consolidatedHead = gitC(repo, ["rev-parse", "HEAD"]).slice(0, 7);
  assert.equal(
    commitLandedOnHead(
      payload({
        tool_output: { exit_code: 0, stdout: `nothing committed\n[main ${consolidatedHead}] decoy` },
      })
    ),
    false,
    "only the first non-empty line counts as the summary"
  );

  // Not a repo at all: never amend.
  assert.equal(commitLandedOnHead({ cwd: tmpdir(), tool_name: "Bash" }), false, "non-repo cwd");
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

// --- #2 / C1: re-consolidating the same HEAD MERGES — prior decisions survive ---

test("re-consolidating the same HEAD preserves the first decision in note AND trailers", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  const later = "2026-05-20T00:01:00.000Z";
  openDecision(repo, "first", [], now);
  writeFileSync(join(repo, "a.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r1", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: a"]);
  await consolidate(repo, fakeEcho, { now });

  // A new edit lands with NO new commit, then we consolidate again on the same logical commit.
  openDecision(repo, "second", [], later);
  writeFileSync(join(repo, "a.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r2", ts: later });
  await consolidate(repo, fakeEcho, { now: later });

  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  assert.equal((message.match(/^Lore-id:/gm) ?? []).length, 1, "exactly one Lore-id");
  // git's own parser agrees there is exactly one Lore-id.
  const parsed = gitC(repo, ["interpret-trailers", "--parse"], message);
  assert.equal((parsed.match(/^Lore-id:/gm) ?? []).length, 1);

  // THE C1 REGRESSION: decision "first" must survive the second amend — in the
  // trailer block (its constraint and rejected alternative) and in the graph.
  assert.ok(/^Constraint: c-first$/m.test(message), "first decision's constraint survives");
  assert.ok(/^Constraint: c-second$/m.test(message), "second decision's constraint present");
  assert.ok(message.includes("alt-first"), "first decision's rejected alternative survives");
  const atoms = atomsForFile(repo, "a.ts");
  assert.deepEqual(
    atoms.map((a) => a.intent).sort(),
    ["first", "second"],
    "both decisions queryable from the notes graph"
  );

  // The note orphaned by the second amend was removed; exactly one note remains.
  assert.equal(listNotes(repo).length, 1, "no orphaned notes accumulate");
});

test("commit-trigger consolidation at a flush-noted HEAD carries flush atoms into the trailers", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  // A real commit exists at HEAD…
  writeFileSync(join(repo, "base.ts"), "0\n");
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: base"]);
  // …in-flight reasoning is promoted by a notes-only flush at that HEAD…
  openDecision(repo, "flushed", [], now);
  writeFileSync(join(repo, "f1.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "f1.ts"), reason: "r", ts: now });
  await consolidate(repo, fakeEcho, { now, writeTrailers: false });

  // …then a commit-shaped consolidation lands at the SAME HEAD.
  const later = "2026-05-20T00:01:00.000Z";
  openDecision(repo, "committed", [], later);
  writeFileSync(join(repo, "f2.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "f2.ts"), reason: "r2", ts: later });
  await consolidate(repo, fakeEcho, { now: later });

  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  assert.ok(/^Constraint: c-flushed$/m.test(message), "flush-written decision reaches the trailers");
  assert.ok(/^Constraint: c-committed$/m.test(message), "new decision in the trailers");
  assert.equal(atomsForFile(repo, "f1.ts").length, 1, "flushed decision still queryable");
  assert.equal(atomsForFile(repo, "f2.ts").length, 1, "committed decision queryable");
  assert.equal(listNotes(repo).length, 1, "one merged note");
});

test("replaying an identical journal is idempotent: no re-amend, no sha churn", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "stable", [], now);
  writeFileSync(join(repo, "i.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "i.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: i"]);
  const first = await consolidate(repo, fakeEcho, { now });
  assert.equal(first.amended, true);
  const shaAfterFirst = gitC(repo, ["rev-parse", "HEAD"]);

  // The exact same journal content again (a re-fired hook replaying its input).
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "i.ts"), reason: "r", ts: now });
  const second = await consolidate(repo, fakeEcho, { now });
  assert.equal(second.amended, false, "identical record short-circuits (already-current)");
  assert.equal(gitC(repo, ["rev-parse", "HEAD"]), shaAfterFirst, "no sha churn on replay");
  assert.equal((gitC(repo, ["show", "-s", "--format=%B", "HEAD"]).match(/^Lore-id:/gm) ?? []).length, 1);
});

test("a rollup in the existing note never leaks into the trailer record", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  writeFileSync(join(repo, "a.ts"), "1\n");
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: a"]);
  // A dream previously left a level-1 rollup in this commit's note.
  const rollup = {
    id: "r-1",
    loreId: "r-1",
    level: 1,
    summary: "ROLLUP-SUMMARY-TEXT",
    files: ["a.ts"],
    sourceIds: ["dead", "beef"],
    createdAt: now,
  };
  gitC(
    repo,
    ["notes", "--ref=cairn", "add", "-f", "-F", "-", "HEAD"],
    JSON.stringify({ v: 1, commit: "x", generatedAt: now, loreId: "old", atoms: [rollup] })
  );

  openDecision(repo, "fresh", [], now);
  writeFileSync(join(repo, "a.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r", ts: now });
  await consolidate(repo, fakeEcho, { now });

  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  assert.ok(!message.includes("ROLLUP-SUMMARY-TEXT"), "rollup text stays out of trailers");
  assert.ok(/^Constraint: c-fresh$/m.test(message), "decision constraint present");
  // The rollup itself survives in the merged note.
  const note = gitC(repo, ["notes", "--ref=cairn", "show", "HEAD"]);
  assert.ok(note.includes('"level":1') || note.includes('"level": 1'), "rollup kept in note");
});

test("constraints folded by within-run compaction still reach the trailer block", async () => {
  const repo = makeRepo();
  // Three unattached edits whose synthesized constraints are ~2k tokens each —
  // past COMPACT_TOKEN_BUDGET, so the oldest folds into a rollup in the NOTE.
  // The TRAILER record is built pre-compaction and must keep all three.
  const pad = "x".repeat(8000);
  const fakeBig: Complete = async (prompt) => {
    if (prompt.includes("Cluster them")) {
      const ids = [...prompt.matchAll(/id=(j-[0-9a-f]+)/g)].map((m) => m[1]);
      return JSON.stringify({ clusters: ids.map((id) => [id]) });
    }
    if (prompt.startsWith("Summarize these related decisions")) {
      return JSON.stringify({ summary: "rollup summary" });
    }
    const f = prompt.match(/file=(\S+)/)?.[1] ?? "unknown";
    return JSON.stringify({
      intent: `intent ${f}`,
      summary: `s ${f}`,
      constraints: [`marker-${f} ${pad}`],
      confidence: "high",
    });
  };

  for (const [i, f] of (["big1.ts", "big2.ts", "big3.ts"] as const).entries()) {
    writeFileSync(join(repo, f), "x\n");
    recordEdit(repo, {
      toolName: "Write",
      filePath: join(repo, f),
      reason: `r${i}`,
      ts: `2026-05-20T00:0${i}:00.000Z`,
    });
  }
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: big"]);
  await consolidate(repo, fakeBig, { now: "2026-05-20T00:05:00.000Z" });

  const note = gitC(repo, ["notes", "--ref=cairn", "show", "HEAD"]);
  assert.ok(
    note.includes('"level":1') || note.includes('"level": 1'),
    "compaction actually fired (note holds a rollup) — otherwise this test is vacuous"
  );
  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  for (const f of ["big1.ts", "big2.ts", "big3.ts"]) {
    assert.ok(message.includes(`marker-${f}`), `${f}'s constraint survives in the trailer`);
  }
});

// --- amend safety: message-only, never the index, never blocked by user hooks ---

test("amend never folds staged-but-uncommitted changes into the commit", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "amend safety", [], now);
  writeFileSync(join(repo, "a.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: a"]);

  // The user stages MORE work before the hook-driven consolidation runs
  // (the `git commit -m wip && git add .` compound-command shape).
  const treeBefore = gitC(repo, ["rev-parse", "HEAD^{tree}"]);
  writeFileSync(join(repo, "staged-later.ts"), "next commit's work\n");
  gitC(repo, ["add", "staged-later.ts"]);

  const result = await consolidate(repo, fake, { now });
  assert.equal(result.amended, true, "amend ran");

  // The amended commit's TREE is unchanged: staged work was not folded in.
  assert.equal(gitC(repo, ["rev-parse", "HEAD^{tree}"]), treeBefore, "tree unchanged by amend");
  assert.ok(
    !gitC(repo, ["ls-tree", "--name-only", "HEAD"]).includes("staged-later.ts"),
    "staged file is not in the amended commit"
  );
  // ...and it is still staged for the user's NEXT commit.
  assert.equal(gitC(repo, ["diff", "--cached", "--name-only"]), "staged-later.ts");
});

test("a rejecting commit-msg hook does not block the trailer amend", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "hook safety", [], now);
  writeFileSync(join(repo, "h.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "h.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: h"]);

  // Install a commit-msg hook that rejects everything AFTER the commit exists.
  // The tree already passed the user's hooks; a message-only amend must not
  // re-run them (and must not fail when they would reject).
  const hooksDir = join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  const result = await consolidate(repo, fake, { now });
  assert.equal(result.amended, true, "amend not blocked by the rejecting hook");
  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  assert.ok(/^Lore-id:/m.test(message), "trailers landed despite the hook");
});

// --- amend guards: never rewrite a pushed or signed commit; the note alone carries the reasoning ---

test("on-remote guard: a pushed commit is never amended, but the note still lands on HEAD", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "pushed work", [], now);
  writeFileSync(join(repo, "p.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "p.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: p"]);

  // Push HEAD to a bare remote BEFORE consolidation runs: the commit is now
  // public history, so the amend must be refused.
  const bare = mkdtempSync(join(tmpdir(), "cairn-hard-remote-"));
  gitC(bare, ["init", "--bare", "-q"]);
  gitC(repo, ["remote", "add", "origin", bare]);
  gitC(repo, ["push", "-q", "-u", "origin", "HEAD"]);

  const headBefore = gitC(repo, ["rev-parse", "HEAD"]);
  const result = await consolidate(repo, fake, { now });
  assert.equal(result.amended, false, "pushed commit is never amended");
  assert.equal(gitC(repo, ["rev-parse", "HEAD"]), headBefore, "HEAD sha untouched");
  // The git-note alone carries the reasoning (README's guarantee).
  assert.ok(gitC(repo, ["notes", "--ref=cairn", "show", "HEAD"]).length > 0, "note exists on HEAD");
});

test("signed guard: a signed commit is never amended, but the note still lands on HEAD", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";

  // Throwaway SSH signing key — repo-local config only (gitC nulls global/system).
  const keyDir = mkdtempSync(join(tmpdir(), "cairn-hard-key-"));
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", join(keyDir, "key"), "-q"]);
  gitC(repo, ["config", "gpg.format", "ssh"]);
  gitC(repo, ["config", "user.signingkey", join(keyDir, "key")]);
  gitC(repo, ["config", "commit.gpgsign", "true"]);
  // gpg.ssh semantics: %G? reports "N" for an SSH-signed commit unless an
  // allowedSignersFile lets git VERIFY it — so configure one for the test key.
  const pub = readFileSync(join(keyDir, "key.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
  writeFileSync(join(keyDir, "allowed_signers"), `t@cairn.dev ${pub}\n`);
  gitC(repo, ["config", "gpg.ssh.allowedSignersFile", join(keyDir, "allowed_signers")]);

  openDecision(repo, "signed work", [], now);
  writeFileSync(join(repo, "s.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "s.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: s"]);

  const headBefore = gitC(repo, ["rev-parse", "HEAD"]);
  assert.equal(isSignedCommit(headBefore, repo), true, "the commit really is signed");

  const result = await consolidate(repo, fake, { now });
  assert.equal(result.amended, false, "signed commit is never amended");
  assert.equal(gitC(repo, ["rev-parse", "HEAD"]), headBefore, "HEAD sha untouched");
  assert.ok(gitC(repo, ["notes", "--ref=cairn", "show", "HEAD"]).length > 0, "note exists on HEAD");

  // And the detector itself: an unsigned commit elsewhere is NOT signed.
  const plain = makeRepo();
  assert.equal(isSignedCommit(gitC(plain, ["rev-parse", "HEAD"]), plain), false);
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
  // Run the CLI from SOURCE (via tsx) so this test can never green-light a stale dist/.
  const evil = "retry logic; touch PWNED && echo $(whoami) `id`";
  const [cmd, args] = tsxCliArgs("open-decision-stdin");
  const r = spawnSync(cmd, args, { cwd: repo, input: evil, encoding: "utf8" });
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

// --- C4: consolidation consumes only what it read — late appends survive ---

test("an entry appended during consolidation survives the journal clear", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "early", [], now);
  writeFileSync(join(repo, "early.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "early.ts"), reason: "r", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: early"]);

  // A parallel hook appends WHILE the model call is in flight.
  let appended = false;
  const sneaky: Complete = async (prompt) => {
    if (!appended) {
      appended = true;
      writeFileSync(join(repo, "late.ts"), "2\n");
      recordEdit(repo, {
        toolName: "Write",
        filePath: join(repo, "late.ts"),
        reason: "raced in mid-consolidation",
        ts: "2026-05-20T00:00:30.000Z",
      });
    }
    return fakeEcho(prompt);
  };
  await consolidate(repo, sneaky, { now });

  // The early entry was consumed; the late one is still in the journal…
  const remaining = readEntries(repo);
  assert.equal(remaining.length, 1, "late append survived the clear");
  assert.equal(remaining[0].file, "late.ts");
  // …and the next consolidation promotes it.
  await consolidate(repo, fakeEcho, { now: "2026-05-20T00:01:00.000Z", writeTrailers: false });
  assert.equal(atomsForFile(repo, "late.ts").length, 1, "raced entry reaches the graph");
  assert.equal(readEntries(repo).length, 0, "journal fully drained after second pass");
});

test("a torn journal line is skipped by reads and preserved by the clear", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T00:00:00.000Z";
  openDecision(repo, "torn", [], now);
  writeFileSync(join(repo, "t1.ts"), "1\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "t1.ts"), reason: "r1", ts: now });
  // A crash mid-append left a truncated JSON line behind…
  appendFileSync(join(repo, ".git", "cairn", "journal.jsonl"), '{"id":"j-torn","ts"\n', "utf8");
  writeFileSync(join(repo, "t2.ts"), "2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "t2.ts"), reason: "r2", ts: now });

  const entries = readEntries(repo);
  assert.equal(entries.length, 2, "both valid entries read; torn line skipped");

  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: torn"]);
  await consolidate(repo, fakeEcho, { now });
  assert.equal(atomsForFile(repo, "t1.ts").length, 1);
  assert.equal(atomsForFile(repo, "t2.ts").length, 1);
  // The torn line is not ours to delete — it survives the consume.
  const raw = readFileSync(join(repo, ".git", "cairn", "journal.jsonl"), "utf8");
  assert.ok(raw.includes('{"id":"j-torn","ts"'), "torn write preserved");
  assert.equal(readEntries(repo).length, 0, "no valid entries left");
});

test("journal entry ids are unique for same-file same-ms edits with different reasons", () => {
  const repo = makeRepo();
  const ts = "2026-05-20T00:00:00.000Z";
  writeFileSync(join(repo, "u.ts"), "1\n");
  const a = recordEdit(repo, { toolName: "Write", filePath: join(repo, "u.ts"), reason: "first pass", ts });
  const b = recordEdit(repo, { toolName: "Write", filePath: join(repo, "u.ts"), reason: "second pass", ts });
  const c = recordEdit(repo, { toolName: "Write", filePath: join(repo, "u.ts"), reason: "first pass", ts });
  assert.ok(a && b && c);
  assert.notEqual(a!.id, b!.id, "different reasons -> different ids");
  assert.equal(a!.id, c!.id, "a true duplicate (same process, same args) collapses to one id");
  assert.equal(readEntries(repo).length, 3, "all three appends are on disk");
});

// --- #15 out-of-repo edits are not journaled ---

test("recordEdit ignores edits outside the repo", () => {
  const repo = makeRepo();
  const outside = join(tmpdir(), "definitely-not-in-repo.ts");
  writeFileSync(outside, "x\n");
  const entry = recordEdit(repo, { toolName: "Write", filePath: outside, reason: "r" });
  assert.equal(entry, null, "out-of-repo edit returns null");
});

// --- M11: CLI hook gating, spawned from source — garbage in, nothing out ---

/**
 * Spawn a hook command the way Claude Code does (JSON on stdin), from SOURCE
 * via tsx. ANTHROPIC_API_KEY is stripped so flush/consolidate-if-commit stay
 * offline on the deterministic no-key fallback; CLAUDE_PROJECT_DIR is stripped
 * so resolution comes from the payload/cwd, not the developer's session.
 */
function spawnHook(repo: string, command: string, input: string) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_PROJECT_DIR;
  const [cmd, args] = tsxCliArgs(command);
  return spawnSync(cmd, args, { cwd: repo, input, encoding: "utf8", env });
}

test("every hook command exits 0 on garbage stdin and leaves no side effects", () => {
  const repo = makeRepo();
  for (const command of ["journal-edit", "open-from-plan", "consolidate-if-commit", "flush"]) {
    const r = spawnHook(repo, command, "not json{");
    assert.equal(r.status, 0, `${command} must exit 0 on garbage stdin (stderr: ${r.stderr})`);
  }
  assert.equal(readEntries(repo).length, 0, "no journal entry written");
  assert.equal(getActiveDecisionId(repo), null, "no decision opened");
  assert.equal(listNotes(repo).length, 0, "no note written");
});

test("journal-edit gates on the tool: NotebookEdit journals, Bash does not", () => {
  const repo = makeRepo();
  const file = join(repo, "nb.ipynb");
  writeFileSync(file, "{}\n");

  const editPayload = JSON.stringify({
    tool_name: "NotebookEdit",
    tool_input: { file_path: file },
    cwd: repo,
  });
  const r1 = spawnHook(repo, "journal-edit", editPayload);
  assert.equal(r1.status, 0, r1.stderr);
  const entries = readEntries(repo);
  assert.equal(entries.length, 1, "NotebookEdit edit journaled");
  assert.equal(entries[0].file, "nb.ipynb");
  assert.equal(entries[0].change, "NotebookEdit");

  const bashPayload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { file_path: file },
    cwd: repo,
  });
  const r2 = spawnHook(repo, "journal-edit", bashPayload);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readEntries(repo).length, 1, "a Bash payload journals nothing");
});

test("open-from-plan opens a decision whose intent is derived from the plan", () => {
  const repo = makeRepo();
  const payload = JSON.stringify({
    tool_name: "ExitPlanMode",
    tool_input: { plan: "# Do X" },
    cwd: repo,
  });
  const r = spawnHook(repo, "open-from-plan", payload);
  assert.equal(r.status, 0, r.stderr);
  const id = getActiveDecisionId(repo);
  assert.ok(id, "a decision is now active");
  assert.equal(getDecision(repo, id!)!.intent, "Do X", "heading marker stripped, intent kept");
});
