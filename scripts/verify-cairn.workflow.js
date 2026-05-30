export const meta = {
  name: 'verify-cairn',
  description: 'Double-check that Cairn does what it claims — verify each acceptance criterion against the code by actually running it.',
  phases: [
    { title: 'Verify', detail: 'one adversarial agent per claim; runs commands + reads code' },
    { title: 'Synthesize', detail: 'ground-truth re-run + written report' },
  ],
}

const REPO = '/Users/andrewsauer/Documents/SAUERAPPLE/cairn-app'

const CLAIMS = [
  { id: 'C1', title: 'Editing a file writes a durable journal entry immediately (on disk in .git/cairn), surviving /clear',
    how: 'Read src/capture/journalEntry.ts and src/store/journal.ts — confirm appendEntry uses SYNCHRONOUS fs (appendFileSync), no async gap before the write. Then prove it: make a fresh temp git repo, pipe a PostToolUse Write JSON payload to `node dist/cli.js journal-edit` (cwd=temp repo, tool_input.file_path pointing at a file in it), and confirm <repo>/.git/cairn/journal.jsonl exists containing the entry. A file inside .git survives /clear (which only wipes conversation context). Look for any path where the write is deferred or lost.' },
  { id: 'C2', title: 'A decision opens (plan + manual); edits attach; consolidation writes Lore trailers + refs/notes/cairn, grouped by shared reasoning NOT by folder',
    how: 'Read src/capture/consolidate.ts and src/capture/decision.ts. Confirm grouping is by decisionId (engine ingest), never by path. Prove end-to-end in a temp repo: open a decision (node dist/cli.js open-decision-stdin), edit two files in DIFFERENT folders under the same decision, commit, then run consolidation. Verify the commit message has a Lore trailer block AND `git notes --ref=cairn show HEAD` returns JSON, and that both files end up in one decision atom (shared reasoning across folders). Note: without ANTHROPIC_API_KEY the synthesis is deterministic fallback — that is fine, still verify the structure.' },
  { id: 'C3', title: 'Records are readable by a Lore-style consumer (interop is real, not claimed)',
    how: 'Run `npm test` and confirm tests/trailers.test.ts pass. Then prove interop directly: in a temp repo produce a Cairn-consolidated commit and run `git show -s --format=%B HEAD | git interpret-trailers --parse` — confirm git`s OWN parser emits a `Lore-id:` line and the exact Lore field names/casing (Lore-id, Constraint, Rejected with a `|` separator, Confidence enum, Supersedes). Also hand-write a foreign Lore trailer block in a commit (no Cairn note) and confirm src reading code parses it. Check field names against src/store/trailers.ts and flag ANY deviation from the Lore spec.' },
  { id: 'C4', title: 'why(file) returns the file’s decision chain over time and recent(n) the latest, BOTH under a token budget',
    how: 'Read src/engine/recall.ts and src/config.ts (RECALL_TOKEN_BUDGET). Run `npm test` (engine tests cover budget + truncation). Then construct a stress case: programmatically build many atoms (or many consolidations) and confirm recall output stays bounded and sets truncated=true rather than growing without bound. Confirm why() returns oldest->newest chronological chain. Try to find a case where output exceeds the budget unexpectedly.' },
  { id: 'C5', title: 'The engine has ZERO imports from git, Claude Code, the store, or the Anthropic SDK — only the injected complete()',
    how: 'Run `npm test` and confirm tests/decoupling.test.ts passes. Independently verify: grep every import/export-from/dynamic-import line under src/engine/ and confirm none reference node:child_process, node:fs, @anthropic-ai/sdk, @modelcontextprotocol/sdk, ../store, ../capture, ../mcp, ../complete, ../config. Try to defeat the decoupling test (would it catch a re-export or dynamic import?). Report if the test has a blind spot.' },
  { id: 'C6', title: 'A fresh session with the Cairn MCP attached answers a “why is this file the way it is” question a bare session cannot',
    how: 'Run `node scripts/smoke.mjs` (it drives the REAL compiled MCP server over stdio and calls why/recent). Confirm why(file) returns the decision chain with constraints/rejected alternatives, and that the bare-session baseline (git log subject) does NOT contain that reasoning. Confirm the MCP server exposes exactly two tools (why, recent). This is the headline claim — scrutinize whether the demo is honest (note it uses a stubbed model when no API key).' },
  { id: 'C7', title: 'Self-compacting: level-0 atoms plus ONE rollup level with provenance; recall stays under budget regardless of graph size',
    how: 'Read src/engine/compact.ts. Confirm it produces only level 0 and level 1 (no recursive deeper levels) and that rollups carry sourceIds (provenance for future deeper levels without migration). Run `npm test` (compact test). Confirm via code + a quick experiment that recall bounds OUTPUT size even as the stored graph grows (the budget is enforced at read time). Flag if compaction is claimed but never actually wired into consolidation.' },
  { id: 'C8', title: 'Non-goals respected: no new format, no backend/db/web/multiplayer/auth, exactly why+recent (no search/summary), no timer/daemon',
    how: 'Audit the codebase: confirm src/mcp/server.ts registers EXACTLY `why` and `recent` (no search/summary). Grep all of src/ for: http/express/fastify servers, database clients, auth, setInterval/setTimeout-as-daemon/cron/while-true polling. Confirm package.json has no backend/db/web deps (express/cors/hono appearing only as transitive deps of the MCP SDK is OK). Confirm the capture format is Lore (not a new invented format). Report any non-goal that was actually built.' },
  { id: 'C9', title: 'Durability is independent of triggers — a missed consolidation loses nothing; the next trigger picks the journal up',
    how: 'Run `npm test` and confirm the “missed consolidation” test passes. Prove it: in a temp repo, edit + commit but do NOT consolidate; confirm the journal entry persists on disk; then consolidate and confirm it is picked up and the journal cleared. Reason about whether consolidation failure (e.g. mid-way git error) can clear the journal WITHOUT writing the durable record (a data-loss window). Inspect the ordering in src/capture/consolidate.ts.' },
  { id: 'C10', title: 'Idempotency: re-consolidation does not duplicate; exactly ONE Lore-id per commit',
    how: 'Read src/store/trailers.ts (appendTrailersToCommit replace-not-append) and the idempotency/re-consolidation tests in tests/hardening.test.ts. Prove it: in a temp repo, consolidate a commit, then consolidate AGAIN with different journal content on the same HEAD, and confirm `git show -s --format=%B HEAD | grep -c "^Lore-id:"` returns exactly 1 and there are no orphaned notes (listNotes length stays 1). This guards a bug that was previously fixed — confirm it stays fixed.' },
  { id: 'C11', title: 'A notes-only flush (pre-compact / session end/start) does NOT clobber the commit’s note on the same HEAD',
    how: 'Read the flush path in src/capture/consolidate.ts (writeTrailers:false + mergeAtomsByLoreId) and the regression test in tests/hardening.test.ts. Prove it: commit-consolidate a decision touching fileA, then journal an edit to fileB and flush (writeTrailers:false) on the same HEAD; confirm BOTH fileA and fileB decisions remain queryable (atomsForFile finds each). This guards a real bug the dogfood walkthrough caught — confirm the note is merged, not overwritten.' },
  { id: 'C12', title: 'Build + tests are green and the install is live (MCP connected, hooks present)',
    how: 'Run `cd '+REPO+' && npm run build` then `npm test` and report the exact pass/fail counts. Run `claude mcp get cairn` and confirm Status: Connected. Read ~/.claude/settings.json and confirm Cairn hook entries exist for PostToolUse (journal-edit, open-from-plan, consolidate-if-commit) and PreCompact/SessionEnd/SessionStart (flush), and that pre-existing non-Cairn hooks were preserved. Report anything missing or broken.' },
]

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },
    confidence: { type: 'number' },
    evidence: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'verdict', 'confidence', 'evidence', 'gaps'],
}

phase('Verify')
const verdicts = (await parallel(
  CLAIMS.map((claim) => () =>
    agent(
      `You are adversarially verifying ONE claim about the Cairn project at ${REPO}. Do NOT take the claim on faith — actively try to find where it is false, overstated, or only partially true.\n\n` +
      `IMPORTANT: dist/ is already built; do NOT run \`npm run build\` (avoid clobbering it concurrently). You MAY run \`npm test\` (uses tsx, isolated temp repos), the scripts in scripts/, git, and \`claude mcp get\`. Always work in fresh temp dirs you create; never mutate ${REPO}'s own git state. Use absolute paths.\n\n` +
      `CLAIM ${claim.id}: ${claim.title}\n\nHOW TO VERIFY:\n${claim.how}\n\n` +
      `Return your verdict: pass (fully true, proven by running it), partial (true with caveats/gaps), or fail (false or unproven). Put the concrete evidence (command output snippets, file:line, observed behavior) in evidence[], any caveats/gaps in gaps[], and the commands you actually ran in commands[]. Be specific and honest — a partial with a real gap is more useful than a hollow pass.`,
      { label: `verify:${claim.id}`, phase: 'Verify', schema: VERDICT, model: 'sonnet' }
    )
  )
)).filter(Boolean)

phase('Synthesize')
const summary = await agent(
  `You are writing the final verification report for the Cairn project at ${REPO}. Below are per-claim verdicts from independent verifiers (JSON).\n\n` +
  `${JSON.stringify(verdicts, null, 2)}\n\n` +
  `First, GROUND-TRUTH it yourself: run \`cd ${REPO} && npm run build && npm test\` and \`node scripts/smoke.mjs\`, and note the actual results. Then act as a completeness critic: is any claim marked pass without real evidence of having been RUN? Is any headline claim (C6) only mechanism-proven, not lived? Call that out.\n\n` +
  `Write a markdown report to ${REPO}/docs/verification/REPORT.md with: (1) a one-line overall verdict (READY / READY-WITH-GAPS / NOT-READY); (2) a summary table (Claim | Verdict | Confidence | One-line note); (3) per-claim detail with the strongest evidence and any gap; (4) a prioritized \"Gaps to fix\" list (empty if none); (5) a short \"What automated checks still cannot prove\" note (the live-session in-situ behavior). Create the docs/verification/ directory if needed. Keep it honest and skimmable.\n\n` +
  `Return a ~12-line plain-text summary: the overall verdict, the pass/partial/fail counts, the ground-truth test+smoke result, and the top 3 gaps (or \"no gaps\").`,
  { label: 'synthesize', phase: 'Synthesize' }
)

return { verdicts, summary }
