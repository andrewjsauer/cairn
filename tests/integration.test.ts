import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openDecision, recordEdit, consolidate } from "../src/capture/index.js";
import { readEntries, renamesInHistory } from "../src/store/index.js";
import { atomsForFile, allAtoms } from "../src/read/graph.js";
import { formatChain } from "../src/mcp/format.js";
import { recall, type Complete } from "../src/engine/index.js";
import { gitC, makeRepo as sharedMakeRepo } from "./helpers/repo.js";

/**
 * Full slice against a real git repo, with a fake complete() (no network):
 * decision -> edit journal -> commit -> consolidate -> Lore trailers + notes,
 * then read it all back through the MCP graph layer. This is the executable
 * version of the Section 10 acceptance criteria.
 */

const makeRepo = () => sharedMakeRepo({ prefix: "cairn-it-" });

const fakeComplete: Complete = async (prompt) => {
  if (prompt.includes("Cluster them")) return JSON.stringify({ clusters: [] });
  if (prompt.startsWith("Summarize these related decisions")) {
    return JSON.stringify({ summary: "rollup" });
  }
  return JSON.stringify({
    intent: "retry transient failures twice before giving up",
    summary:
      "Wrapped the client call in a 2-attempt retry with backoff because the upstream is flaky on cold start.",
    constraints: ["upstream cold-start can exceed 500ms"],
    rejected: [{ alternative: "fail fast with no retry", reason: "caused spurious user-facing errors" }],
    confidence: "high",
  });
};

test("decision -> edit -> commit -> consolidate writes Lore trailers + notes, readable back", async () => {
  const repo = makeRepo();
  const now = "2026-05-20T10:00:00.000Z";

  // 1. Open a decision (the /cairn:decision path).
  openDecision(repo, "retry transient failures twice before giving up", [], now);

  // 2. Make an edit and journal it synchronously (the PostToolUse edit hook path).
  mkdirSync(join(repo, "src"), { recursive: true });
  const file = join(repo, "src", "client.ts");
  writeFileSync(file, "export function call() { /* retry x2 */ }\n");
  const entry = recordEdit(repo, {
    toolName: "Write",
    filePath: file,
    reason: "added a 2-attempt retry with backoff",
    ts: now,
  });
  assert.ok(entry, "edit was journaled");

  // The journal entry is on disk immediately (survives /clear): assert it exists.
  assert.equal(readEntries(repo).length, 1);

  // 3. Commit (the change the agent made).
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: add retry to client"]);

  // 4. Consolidate (the PostToolUse commit hook path), with the fake model.
  const result = await consolidate(repo, fakeComplete, { now });
  assert.equal(result.ok, true);
  assert.equal(result.written, 1);
  assert.equal(result.amended, true, "trailers amended onto the local commit");

  // 5a. Interop: git's OWN parser reads the trailers we wrote.
  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  const parsed = gitC(repo, ["interpret-trailers", "--parse"], message);
  assert.match(parsed, /^Lore-id: [0-9a-f]{8}$/m, "git interpret-trailers sees our Lore-id");
  assert.match(parsed, /^Constraint: upstream cold-start can exceed 500ms$/m);
  assert.match(parsed, /^Rejected: fail fast with no retry \| caused spurious user-facing errors$/m);
  assert.match(parsed, /^Confidence: high$/m);

  // 5b. The graph note exists on the (amended) HEAD.
  const note = gitC(repo, ["notes", "--ref=cairn", "show", "HEAD"]);
  const payload = JSON.parse(note);
  assert.equal(payload.v, 1);
  assert.equal(payload.atoms.length, 1);
  assert.equal(payload.atoms[0].files[0], "src/client.ts");

  // 6. The journal was cleared after promotion.
  assert.equal(readEntries(repo).length, 0);

  // 7. Read it back the way the MCP server does: why(file) and recent(n).
  const why = recall(atomsForFile(repo, "src/client.ts"), {
    file: "src/client.ts",
    tokenBudget: 2000,
  });
  assert.equal(why.atoms.length, 1);
  assert.match(why.atoms[0].intent, /retry transient failures/);

  const recent = recall(allAtoms(repo), { recent: 5, tokenBudget: 2000 });
  assert.ok(recent.atoms.length >= 1);
});

test("a missed consolidation loses nothing: the journal persists for the next run", async () => {
  const repo = makeRepo();
  const now = "2026-05-21T10:00:00.000Z";
  openDecision(repo, "tidy logging", [], now);
  const file = join(repo, "log.ts");
  writeFileSync(file, "export const log = () => {};\n");
  recordEdit(repo, { toolName: "Write", filePath: file, reason: "added logger", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "chore: logging"]);

  // Simulate a "missed" trigger: we simply don't consolidate yet.
  assert.equal(readEntries(repo).length, 1, "journal entry still on disk");

  // Next trigger picks it up.
  const result = await consolidate(repo, fakeComplete, { now });
  assert.equal(result.written, 1);
  assert.equal(readEntries(repo).length, 0);
});

test("consolidation is idempotent on the same journal", async () => {
  const repo = makeRepo();
  const now = "2026-05-22T10:00:00.000Z";
  openDecision(repo, "cache results", [], now);
  writeFileSync(join(repo, "cache.ts"), "export const cache = {};\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "cache.ts"), reason: "add cache", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: cache"]);

  const first = await consolidate(repo, fakeComplete, { now });
  // Re-journal the same edit and consolidate again; the atom id is content-hashed,
  // so re-running must not create a second, conflicting Lore-id for the same work.
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "cache.ts"), reason: "add cache", ts: now });
  const second = await consolidate(repo, fakeComplete, { now });
  assert.equal(first.loreId, second.loreId, "same work -> same Lore-id");
});

test("U2: read path flags atoms whose code is gone, preserving order, dropping nothing", async () => {
  const repo = makeRepo();

  // Decision A touches keep.ts (older); decision B touches gone.ts (newer).
  for (const [i, f] of [["a", "keep.ts"], ["b", "gone.ts"]].entries()) {
    const now = `2026-05-2${5 + i}T10:00:00.000Z`;
    openDecision(repo, `decision about ${f[1]}`, [], now);
    writeFileSync(join(repo, f[1]), `// ${f[0]}\n`);
    recordEdit(repo, { toolName: "Write", filePath: join(repo, f[1]), reason: `work on ${f[1]}`, ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", `feat: ${f[1]}`]);
    await consolidate(repo, fakeComplete, { now });
  }

  // Delete gone.ts — no superseding decision is opened, exactly the gap.
  gitC(repo, ["rm", "-q", "gone.ts"]);
  gitC(repo, ["commit", "-q", "-m", "chore: drop gone.ts"]);

  // recent(): newest-first order preserved, only the deleted-code atom flagged.
  const recent = recall(allAtoms(repo), { recent: 5, tokenBudget: 2000 });
  assert.equal(recent.atoms.length, 2);
  assert.deepEqual(recent.atoms[0].files, ["gone.ts"], "newest first — order unchanged");
  assert.equal(recent.atoms[0].stale, true, "deleted-code atom flagged");
  assert.deepEqual(recent.atoms[1].files, ["keep.ts"]);
  assert.equal(recent.atoms[1].stale, false, "live-code atom not flagged");

  // why(gone.ts): the whole chain is stale, still returned, nothing dropped.
  const whyGone = recall(atomsForFile(repo, "gone.ts"), { file: "gone.ts", tokenBudget: 2000 });
  assert.equal(whyGone.atoms.length, 1);
  assert.equal(whyGone.atoms[0].stale, true);
  assert.match(formatChain("gone.ts", whyGone), /STALE — code no longer present/);

  // why(keep.ts): unaffected.
  const whyKeep = recall(atomsForFile(repo, "keep.ts"), { file: "keep.ts", tokenBudget: 2000 });
  assert.equal(whyKeep.atoms.length, 1);
  assert.equal(whyKeep.atoms[0].stale, false);
  assert.doesNotMatch(formatChain("keep.ts", whyKeep), /STALE/);
});

test("rename resolution: a renamed file's chain is found via --follow and NOT flagged stale", async () => {
  const repo = makeRepo();
  const now = "2026-05-27T10:00:00.000Z";

  openDecision(repo, "decision about moved.ts", [], now);
  writeFileSync(join(repo, "moved.ts"), "// original\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "moved.ts"), reason: "create", ts: now });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: moved.ts"]);
  await consolidate(repo, fakeComplete, { now });

  // Rename (not delete) — the reasoning is still about live code.
  gitC(repo, ["mv", "moved.ts", "renamed.ts"]);
  gitC(repo, ["commit", "-q", "-m", "chore: rename moved.ts"]);

  // recent(): the atom is rescued by the rename map — not stale.
  const recent = recall(allAtoms(repo), { recent: 5, tokenBudget: 2000 });
  assert.equal(recent.atoms.length, 1);
  assert.equal(recent.atoms[0].stale, false, "renamed-but-live code is not stale");

  // why(renamed.ts): canonical-name matching finds the chain recorded under
  // the old path, and it is served unflagged. Mirrors the server: one rename
  // map per request, shared by assembly and recall.
  const renames = renamesInHistory(repo);
  const why = recall(atomsForFile(repo, "renamed.ts", renames), {
    file: "renamed.ts",
    tokenBudget: 2000,
    renames,
  });
  assert.ok(why.atoms.length >= 1, "chain found under the new name");
  assert.ok(why.atoms.every((a) => !a.stale), "no false STALE tag on renamed code");

  // Querying by the OLD path resolves to the same chain (both canonicalize
  // to the current name).
  const whyOld = recall(atomsForFile(repo, "moved.ts", renames), {
    file: "moved.ts",
    tokenBudget: 2000,
    renames,
  });
  assert.ok(whyOld.atoms.length >= 1, "old-path query still resolves the chain");
});

test("revert detection: a bare git revert flags the decision; revert-of-revert clears it", async () => {
  const repo = makeRepo();

  // Control decision on keep.ts (older), then the doomed decision on f.ts.
  for (const [i, f] of [["keep.ts", "2026-05-25"], ["f.ts", "2026-05-26"]].entries()) {
    const now = `${f[1]}T10:00:00.000Z`;
    openDecision(repo, `decision ${i} about ${f[0]}`, [], now);
    writeFileSync(join(repo, f[0]), `// ${i}\n`);
    recordEdit(repo, { toolName: "Write", filePath: join(repo, f[0]), reason: `work ${i}`, ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", `feat: ${f[0]}`]);
    await consolidate(repo, fakeComplete, { now });
  }

  // Bare git revert — no journal, no capture. The consequence that bypassed capture.
  gitC(repo, ["revert", "--no-edit", "HEAD"]);

  // recent(): the reverted decision is flagged (and stale — the revert deleted
  // its file); the control decision is untouched. Order preserved.
  const recent = recall(allAtoms(repo), { recent: 5, tokenBudget: 2000 });
  assert.equal(recent.atoms.length, 2);
  const fAtom = recent.atoms.find((a) => a.files.includes("f.ts"))!;
  const keepAtom = recent.atoms.find((a) => a.files.includes("keep.ts"))!;
  assert.equal(fAtom.reverted, true, "bare revert flagged the decision");
  assert.equal(fAtom.stale, true, "revert deleted the file -> also stale");
  assert.equal(keepAtom.reverted, undefined);
  assert.equal(keepAtom.stale, false);

  // why(f.ts): chain served with BOTH tags rendered, nothing dropped.
  const why = recall(atomsForFile(repo, "f.ts"), { file: "f.ts", tokenBudget: 2000 });
  assert.equal(why.atoms.length, 1);
  const rendered = formatChain("f.ts", why);
  assert.match(rendered, /REVERTED — this approach was undone/);
  assert.match(rendered, /STALE — code no longer present/);

  // Revert the revert: the approach re-lands; net status clears, file restored.
  gitC(repo, ["revert", "--no-edit", "HEAD"]);
  const after = recall(allAtoms(repo), { recent: 5, tokenBudget: 2000 });
  const fAfter = after.atoms.find((a) => a.files.includes("f.ts"))!;
  assert.equal(fAfter.reverted, undefined, "revert-of-revert cleared the flag");
  assert.equal(fAfter.stale, false, "file restored by the re-land");
});

// Keeps tsc/eslint from flagging the import in environments without it.
void existsSync;
void readFileSync;

// --- M6: end-to-end no-key fallback through the REAL makeComplete() adapter ---

import { makeComplete } from "../src/complete.js";
import { isDecisionAtom } from "../src/engine/index.js";

test("M6: consolidation without ANTHROPIC_API_KEY falls back to the recorded intent", async () => {
  const repo = makeRepo();
  const now = "2026-05-28T10:00:00.000Z";
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    // Built AFTER the key is gone: this is the throwing stub the CLI would get.
    const complete = makeComplete();

    openDecision(repo, "use exponential backoff for flaky network calls", [], now);
    writeFileSync(join(repo, "net.ts"), "export const call = () => {};\n");
    recordEdit(repo, { toolName: "Write", filePath: join(repo, "net.ts"), reason: "added backoff", ts: now });
    gitC(repo, ["add", "-A"]);
    gitC(repo, ["commit", "-q", "-m", "feat: backoff"]);

    const result = await consolidate(repo, complete, { now });
    assert.equal(result.ok, true, "no key is degraded service, not failure");
    assert.equal(result.written, 1);

    const atoms = atomsForFile(repo, "net.ts").filter(isDecisionAtom);
    assert.equal(atoms.length, 1);
    assert.equal(
      atoms[0].intent,
      "use exponential backoff for flaky network calls",
      "deterministic fallback preserves the recorded decision intent"
    );
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

// --- M10: a repo with zero commits has no HEAD — consolidate must bail cleanly ---

test("M10: consolidate in a commit-less repo returns no-head, spends no model call, keeps the journal", async () => {
  const repo = sharedMakeRepo({ prefix: "cairn-it-", rootCommit: false });
  const now = "2026-05-28T11:00:00.000Z";
  openDecision(repo, "first ever decision", [], now);
  writeFileSync(join(repo, "a.ts"), "x\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "a.ts"), reason: "r", ts: now });

  let modelCalled = false;
  const spy: Complete = async () => {
    modelCalled = true;
    throw new Error("must not be called");
  };
  const result = await consolidate(repo, spy, { now });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-head");
  assert.equal(result.written, 0);
  assert.equal(result.amended, false);
  assert.equal(modelCalled, false, "the guard fires BEFORE any model latency is spent");
  assert.equal(readEntries(repo).length, 1, "journal intact for the first real commit's trigger");
});

// --- M7: a same-decision follow-up records supersedes end-to-end ---

test("M7: a superseding decision links, lands a Supersedes trailer, and renders in formatChain", async () => {
  const repo = makeRepo();

  // Synthesis echoes the stated intent; decision B is low-confidence and
  // returns two rejected alternatives differing only by case.
  const echoRetry: Complete = async (prompt) => {
    if (prompt.includes("Cluster them")) return JSON.stringify({ clusters: [] });
    if (prompt.startsWith("Summarize these related decisions")) return JSON.stringify({ summary: "rollup" });
    const intent = prompt.match(/^Stated intent: (.+)$/m)?.[1] ?? "unknown";
    const jitter = intent.includes("jitter");
    return JSON.stringify({
      intent,
      summary: `Decided to ${intent}.`,
      constraints: ["upstream is flaky on cold start"],
      rejected: jitter
        ? [
            { alternative: "Fixed Delay", reason: "thundering herd" },
            { alternative: "fixed delay", reason: "duplicate differing only by case" },
          ]
        : [{ alternative: "no retry at all", reason: "spurious errors" }],
      confidence: jitter ? "low" : "high",
    });
  };

  // Decision A on client.ts.
  const nowA = "2026-05-29T10:00:00.000Z";
  openDecision(repo, "retry transient upstream failures twice", [], nowA);
  writeFileSync(join(repo, "client.ts"), "// retry x2\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "client.ts"), reason: "retry x2", ts: nowA });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: retry"]);
  await consolidate(repo, echoRetry, { now: nowA });

  // Decision B revisits the SAME file with overlapping reasoning.
  const nowB = "2026-05-30T10:00:00.000Z";
  openDecision(repo, "retry transient upstream failures with jitter", [], nowB);
  writeFileSync(join(repo, "client.ts"), "// retry with jitter\n");
  recordEdit(repo, { toolName: "Write", filePath: join(repo, "client.ts"), reason: "add jitter", ts: nowB });
  gitC(repo, ["add", "-A"]);
  gitC(repo, ["commit", "-q", "-m", "feat: jitter"]);
  await consolidate(repo, echoRetry, { now: nowB });

  // The newer atom supersedes the older one in the graph.
  const atoms = atomsForFile(repo, "client.ts").filter(isDecisionAtom);
  assert.equal(atoms.length, 2);
  const older = atoms.find((a) => a.intent.includes("twice"))!;
  const newer = atoms.find((a) => a.intent.includes("jitter"))!;
  assert.ok(
    newer.supersedes.includes(older.loreId),
    `newer atom's supersedes [${newer.supersedes}] names the older lore-id ${older.loreId}`
  );

  // The new commit's trailers carry the link, the case-deduped Rejected, and
  // the commit-level confidence reduced to the LOWEST member confidence.
  const message = gitC(repo, ["show", "-s", "--format=%B", "HEAD"]);
  assert.match(message, new RegExp(`^Supersedes: ${older.loreId}$`, "m"));
  assert.match(message, /^Confidence: low$/m, "commit confidence reduces to the lowest member");
  const rejectedLines = message.match(/^Rejected: /gm) ?? [];
  assert.equal(rejectedLines.length, 1, "case-only duplicate alternatives dedupe to one line");
  assert.match(message, /^Rejected: Fixed Delay \| thundering herd$/m);

  // And the read side renders the evolution.
  const why = recall(atomsForFile(repo, "client.ts"), { file: "client.ts", tokenBudget: 4000 });
  assert.match(formatChain("client.ts", why), new RegExp(`supersedes: .*${older.loreId}`));
});
