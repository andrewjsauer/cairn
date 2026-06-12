# Cairn — Final Verification Report

> **SUPERSEDED (2026-06-12).** This report describes the repo as of 2026-05-30
> (28 tests). Its open findings — the recall `truncated` flag (C4), the shallow
> decoupling regex (C5), and the missing global store ceiling (C7) — have all
> since been fixed, and a newer five-perspective review with its own findings
> (and their fixes) lives at
> [2026-06-12-codebase-review.md](2026-06-12-codebase-review.md). Read that
> instead; this file is kept as a historical snapshot.

**Overall verdict: READY-WITH-GAPS** — every claim is mechanism-true and the build/tests/smoke pass cleanly, but the headline "answers WHY" demo (C6) is mechanism-proven against a stubbed model, never lived end-to-end with a real LLM, and four claims carry honest edge-case caveats.

## Ground truth (re-run by this report, 2026-05-30)

- `npm run build` — **PASS** (tsc clean, no errors).
- `npm test` — **28 passed, 0 failed, 0 skipped** (duration ~18.8s).
- `node scripts/smoke.mjs` — **all 9 checks pass, exit 0**.

These were executed directly for this report, not taken on trust from the verifiers.

## Summary

| Claim | Verdict | Conf. | One-line note |
|------|---------|------|----------------|
| C1 Durable edit journal | pass | 0.97 | Synchronous append to `.git/cairn/journal.jsonl`; live-tested, survives `/clear`. |
| C2 Decisions group by reasoning, not folder | pass | 0.95 | Two files in different folders attached to one decision atom; live-tested incl. plan mode. |
| C3 Lore-compatible trailers | pass | 0.97 | Round-trips through `git interpret-trailers --parse`; foreign Lore blocks read back. |
| C4 Recall stays under token budget | partial | 0.92 | Budget enforced, oldest-first correct — but first atom is always kept even if it busts budget. |
| C5 Engine has zero external imports | partial | 0.90 | Confirmed today; test regex is shallow (subdirs / other `node:` builtins uncaught). |
| C6 MCP session answers "why" | partial | 0.85 | Mechanism proven, but demo runs a stubbed model + hardcoded baseline — not lived. |
| C7 One rollup level, bounded recall | partial | 0.88 | Output bounded; stored cross-commit graph has **no** global size ceiling. |
| C8 No backend / 2 MCP tools / Lore format | pass | 0.98 | Exactly `why` + `recent`; no db/web/auth/daemon; web deps only transitive. |
| C9 Missed consolidation loses nothing | pass | 0.95 | `clearJournal` is always last; throws propagate first. Live-tested. |
| C10 Re-consolidation replaces, not appends | pass | 0.98 | Exactly one `Lore-id` after repeat runs; orphan notes cleaned. |
| C11 Flush merges, doesn't overwrite note | pass | 0.98 | Union-by-loreId merge; regression test passes. |
| C12 Build/tests/MCP wired | pass | 0.98 | 28/28, MCP connected, all hooks present. Re-confirmed today. |

**Counts: 7 pass, 5 partial, 0 fail.**

## Per-claim detail

### C1 — Durable edit journal (pass)
Strongest evidence: `appendFileSync` at `src/store/journal.ts:62`, zero async in the capture path; live test wrote valid JSONL entries for both Write and Edit, and out-of-repo paths were silently skipped (guard at `journalEntry.ts:26`). Gap: `reason` comes from the transcript; if `transcript_path` is missing the entry still writes but with an empty reason. No live test with an active `decisionId`.

### C2 — Group by reasoning, not folder (pass)
Two files in different folders landed in one decision atom (`dec-d64cdbd4`), consolidation amended the message with Lore trailers, and the note carried a single atom listing both files. Plan-mode open and the commit hook both fired end-to-end. Gap: the last-resort `clusterByFile` fallback (no decisionId **and** LLM unavailable) groups by file key; without an API key synthesized intent is thin.

### C3 — Lore-compatible trailers (pass)
Round-trips through git's own `interpret-trailers --parse`; foreign Lore blocks with unknown keys parse back correctly (unknown keys ignored); `atomsForFile` reads Lore records written with no Cairn note. Gap: the external Lore spec URL was not independently fetched — interop rests on code docs plus git's parser as the common mechanism.

### C4 — Recall under token budget (partial)
`recallChain` / `recallRecent` enforce both the item cap and the token budget, oldest-first presentation confirmed, stress-tested to 50 atoms. **Edge case:** the guard `if (used + cost > budget && kept.length > 0)` always keeps the first atom even if it alone exceeds the budget, and in the single-atom case `truncated` stays false. "Stays bounded" is really bounded at `max(budget, single_atom_cost)`. Rollup preference is emergent (they're cheaper), not a coded guarantee. The `RECALL_TOKEN_BUDGET = 2000` constant must be passed by callers; it isn't auto-wired.

### C5 — Engine zero external imports (partial)
Re-confirmed today: every import in `src/engine/` is intra-engine relative; no `node:` builtins, no npm packages, no `../` escapes; the `Complete` type is injected, not imported. Gap: the decoupling test's regex only catches single-level `../` paths and a few named packages — a future subdir or an import of `node:path`/`zod` would pass undetected. No live violation today.

### C6 — MCP session answers "why" (partial — headline caveat)
All 9 smoke checks pass and `why(file)` returns a full chain with constraints and rejected alternatives, contrasted against a bare `git log` baseline. **But this report verified that the demo runs `fakeComplete` (smoke.mjs:23) — the rich chain content is hardcoded stub JSON, the cluster path returns `{clusters: []}`, and the "bare session" baseline is a printed string (smoke.mjs:115–118), not a captured agent session.** The data plumbing is genuinely proven; the *lived* "an agent surfaces this to a user, powered by a real LLM" claim is not exercised by any automated check.

### C7 — One rollup level, bounded recall (partial)
`compact()` emits only level-0 + level-1 with `sourceIds` provenance; recall output is bounded at read time and both MCP tools call recall with the 2000-token budget. **Gap:** `compact()` runs only on the current journal batch — `readAllAtoms` reads every note from every commit, so the stored cross-commit graph grows unboundedly. Output is bounded; the global store is not. Same first-atom overrun as C4; a single rollup larger than the budget is kept whole.

### C8 — No backend, two tools, Lore format (pass)
Exactly `why` + `recent` registered; no express/fastify/hono/db/auth/daemon patterns in `src/`; direct deps are only the Anthropic SDK, MCP SDK, and zod. Hono/cors appear only as transitive MCP-SDK deps (unused — stdio transport only). Capture format is Lore, not invented.

### C9 — Missed consolidation loses nothing (pass)
`clearJournal` is always the last call; any throw from ingest/compact/trailers/writeNote propagates first; no try/catch swallows errors. Live-tested: journal persisted through a commit-without-consolidate and was picked up and cleared on the next run. Narrow self-healing window if trailers write but the note doesn't (not data loss).

### C10 — Re-consolidation replaces, not appends (pass)
`stripCairnTrailers` + re-append guarantees exactly one `Lore-id`; an "already-current" short-circuit skips redundant amends; orphan notes keyed to the pre-amend SHA are removed; `writeNote` forces (`-f`). Hardening + integration tests confirm idempotency.

### C11 — Flush merges, doesn't overwrite (pass)
`mergeAtomsByLoreId(existingNote.atoms, compactedNew)` unions by loreId before writing; regression test asserts both the committed-file atom and the in-flight atom survive a notes-only flush on the same HEAD.

### C12 — Build / tests / wiring (pass)
Re-confirmed: 28/28 tests, MCP server connected over stdio, all PostToolUse / PreCompact / SessionStart / SessionEnd hooks present, pre-existing non-Cairn hooks preserved.

## Gaps to fix (prioritized)

1. **C6 (headline): prove it lived, not stubbed.** Add a real-LLM (or recorded-fixture) end-to-end demo where an agent actually calls `why()` and surfaces reasoning, and capture an *actual* bare-session failure for the before/after — rather than `fakeComplete` + a hardcoded baseline string. This is the product's core claim and is currently only mechanism-proven.
2. **C7: bound the stored graph.** Recall output is capped, but the cross-commit notes graph grows without limit. Add periodic/global compaction or document the unbounded-store behavior explicitly as a non-goal.
3. **C4 / C7: fix or document the first-atom budget overrun.** When a single atom exceeds the budget it is returned anyway and `truncated` stays false. Either flag truncation in that case or document that the bound is `max(budget, single_atom_cost)`.
4. **C5: harden the decoupling test.** Make the forbidden-import regex catch nested subdirectories and all `node:` builtins / arbitrary npm packages, so the "zero external imports" guarantee can't silently regress.

## What automated checks still cannot prove

The build, tests, and smoke validate the *mechanism* — files written, trailers parsed, notes merged, budgets enforced. They cannot prove the *lived in-situ behavior*: that during a real Claude Code session the PostToolUse/PreCompact/SessionEnd hooks fire on real edits, that a real LLM synthesizes useful intent/constraints/rejected-alternatives (every test and the smoke use a stub or run without an API key), or that an agent actually invokes `why()` and surfaces the reasoning to a human at the right moment. The plumbing is verified; the end-to-end "it remembers why, with a real model, in a real session" experience is not yet captured by any automated check.
