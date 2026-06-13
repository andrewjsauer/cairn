---
title: "feat: Revert detection — failed approaches flagged, not forgotten"
type: feat
status: completed
date: 2026-06-04
depth: standard
---

# feat: Revert detection — failed approaches flagged, not forgotten

## Summary

Mark a decision atom **reverted** when the commit it was consolidated at was undone by a `git revert` that is itself still in effect (net status), surface it through `why`/`recent` with a two-part marker ("the approach was undone; its constraints may still apply"), and exempt reverted atoms from the dream's stale-folds-first eviction. Detection is pure git (revert commits self-identify), derived at read time, never persisted — the `stale` pattern extended to consequence (see origin: `docs/brainstorms/2026-06-03-revert-detection-requirements.md`).

This also fixes a real defect in shipped behavior: a revert deletes the code, so the failed-approach atom reads *stale*, and the dream currently folds it **first** — evicting the "don't retry this" memory fastest.

---

## Problem Frame

Cairn's chain captures evolution (`supersedes`) and deletion (`stale`) but not failure. A bare `git revert` flows through `consolidate-if-commit` with an empty journal and produces nothing — the consequence event is invisible. Division of labor (from origin): undos performed *through* capture already become chain decisions with the why; revert detection is the fallback for consequence that **bypassed capture**, which is exactly the case that self-identifies (`This reverts commit <sha>.`). Manual no-capture, no-revert undos stay invisible: accepted.

---

## Key Technical Decisions

- **KTD1 — Net status, derived at read time, never persisted.** Revert-of-revert re-lands an approach, so `reverted` is a *net* fact that changes with history — same epistemics as `stale`. Optional `reverted?: boolean` on the atom types, computed by git-aware layers, consumed by the engine as plain data, stripped at `writeNote`.
- **KTD2 — One git call yields both the edges and the SHA universe.** `git log --format='%H%x00%B%x01'` (probed 2026-06-03): records are `sha\0body\x01`; bodies are parsed for every `This reverts commit ([0-9a-f]{7,40})`. The `%H` values from the same call are the full-SHA universe, so abbreviated SHAs from `git revert --reference` resolve by unique `startsWith` — zero extra git calls, no per-prefix `rev-parse`.
- **KTD3 — Prefix resolution in the store; the pure resolver sees only full SHAs.** The engine's net-status function takes resolved edges (`{reverter, reverted}`, full SHAs) and returns the net-reverted set. Edges always point backward in time, so resolution is a terminating memoized recursion: *S is net-reverted iff some edge (R reverts S) exists where R is not itself net-reverted.*
- **KTD4 — A new entries-based annotator; `annotateStale` is NOT refactored.** Revert status is keyed by commit, but assembly currently drops the commit (`readAllAtoms(cwd).map(x => x.atom)`) before annotating. Staleness keys on *files* and never needed commits, so its signature (and `tests/staleness.test.ts`) stays untouched; a **new** `annotateReverted(entries, cwd)` takes `{atom, commit}` entries, and assembly keeps entries through dedupe so it can call both annotators (reverted on entries, stale on the atoms). Trailer-derived atoms know their commit at construction. **Annotators never set the flag on rollups** (they live on the anchor, not a real commit; their summaries already carry arcs) — the U4 strip is the backstop for every atom regardless.
- **KTD5 — Eviction: neutralize, don't immortalize.** In `compactGraph`, the stale-folds-first bias applies only to **non-reverted** stale atoms. Net-reverted atoms rank as live (plain recency) — their code being gone is the *point* of a revert, not evidence of irrelevance. No keep-forever priority: the store stays bounded; a folded reverted atom's arc survives in its rollup summary.
- **KTD6 — Marker carries both halves and co-occurs with STALE.** Rendering must not read as "ignore this": the approach failed but the recorded constraints/rejected alternatives may still bite. Stale and reverted are different facts; both tags show when both hold.
- **KTD7 — `recall.ts` selection unchanged.** The flag rides on the atom (the `stale`/`truncated` precedent); only `format.ts` changes on the read surface. One detection call per request, shared where the caller already orchestrates (the rename-map precedent in `server.ts`); no cheap pre-filter exists, and a `recent()` silent about reverts is worse than one flat git call.

> Traceability: KTD2, KTD6, and KTD7 resolve the origin doc's three "Deferred to planning" items (detection mechanics, dual-tag display, per-request fetch sharing) — deliberate plan-time decisions, not silent drops.

---

## Requirements Traceability

| Requirement (origin) | Covered by |
|---|---|
| Net-revert detection, pure git, one log call | U1 |
| Abbreviated-SHA (`--reference`) resolution | U1 |
| Derived, not stored; engine git-free | U1 (type + pure resolver), U4 (non-persistence) |
| `why`/`recent` flag with two-part marker, order preserved, never filtered | U2 |
| Bare revert (no journal) still flagged | U2 (detection is read-side, independent of capture) |
| Revert-of-revert clears the flag | U1, U2 |
| Dream: reverted exempt from stale-first, ages by recency | U3 |
| `reverted` never persisted; decoupling test passes | U1, U3, U4 |

---

## Implementation Units

### U1. Revert detection primitive: edges, pure net-status resolver, type field

**Goal:** Provide the building blocks — revert edges from history, a single pure net-status rule, and a place to carry the flag.

**Requirements:** Net detection; abbreviated-SHA resolution; engine stays git-free.

**Dependencies:** none.

**Files:**
- `src/engine/types.ts` — optional `reverted?: boolean` on `DecisionAtom` and `RollupAtom` (documented: derived, never persisted; rollups never set it — present on both for uniform strip/typing).
- `src/engine/reverts.ts` (new) — pure `netRevertedShas(edges: {reverter: string; reverted: string}[]): Set<string>` (memoized recursion per KTD3). Exported via `src/engine/index.ts`.
- `src/store/git.ts` — `revertEdgesInHistory(cwd): {reverter: string; reverted: string}[]`: one `git log --format='%H%x00%B%x01'` call, parse bodies for `This reverts commit ([0-9a-f]{7,40})` (global — a commit can revert several), resolve abbreviated SHAs by unique prefix against the call's own `%H` universe, drop unresolvable/ambiguous prefixes.
- `src/store/index.ts` — export.
- `tests/reverts.test.ts` (new) — pure resolver + git-level edge extraction.

**Approach:** Mirror the staleness split exactly: rule in the engine (plain data in, set out), git in the store. Parsing reuses the NUL-delimiter discipline from `filesAtHead`/`renamesInHistory` (the `-z`/`%x00` lesson: verbatim output, no quotepath surprises in `%H`/`%B`).

**Patterns to follow:** `renamesInHistory` (`src/store/git.ts`) for the one-call + token-parse shape; `src/engine/staleness.ts` for the pure-rule module shape.

**Test scenarios:**
- Resolver: single edge → reverted; revert-of-revert chain → original NOT net-reverted, middle revert IS; two independent reverters, one itself reverted → still net-reverted via the other; empty edges → empty set.
- Edge extraction: standard `git revert` → full-SHA edge; `git revert --reference` → abbreviated SHA resolved to full via prefix; commit whose body merely *mentions* "This reverts commit" without a valid sha-in-history → no edge; repo with no reverts / no HEAD → empty, no throw.
- Multiple `This reverts commit` lines in one body → multiple edges.

**Verification:** Resolver and extraction unit-tested; `tests/decoupling.test.ts` passes (no git import in `src/engine/reverts.ts`).

---

### U2. Entries-based annotation + marker in the read path

**Goal:** `why`/`recent` flag net-reverted atoms with the two-part marker, order preserved, nothing dropped; works for bare reverts with no journal activity.

**Requirements:** Read surface; bare-revert case; revert-of-revert clears.

**Dependencies:** U1.

**Files:**
- `src/store/reverts.ts` (new, sibling of `src/store/staleness.ts`) — `annotateReverted(entries: {atom, commit}[], cwd)`: computes the net-reverted SHA set once (U1 primitives) and flags level-0 atoms whose commit is in it. `annotateStale` and its signature are **untouched** (`tests/staleness.test.ts` keeps passing unmodified).
- `src/mcp/graph.ts` — `allAtoms`/`atomsForFile` keep `{atom, commit}` entries through dedupe, call `annotateReverted` on the entries and `annotateStale` on the atoms, then strip to atoms; trailer atoms carry their commit from construction (`trailerToAtom` already has `sha`).
- `src/mcp/server.ts` — share per-request fetches as with the rename map.
- `src/mcp/format.ts` — marker constant, e.g. `↩ REVERTED — this approach was undone; its constraints may still apply`, rendered on the header line; co-occurs with the STALE tag.
- `tests/integration.test.ts` — end-to-end through real capture.

**Approach:** Dedupe currently keys on `loreId` over bare atoms; carrying commits through means dedupe operates on entries (keep the entry whose atom wins; the surviving entry's commit is the one annotated). Annotation order: stale then reverted (independent facts, no interaction on the read side).

**Patterns to follow:** the staleness annotation seam and `STALE_TAG` rendering shipped 2026-06-03; the shared-fetch pattern in `server.ts`'s `why` handler.

**Test scenarios:**
- Consolidated decision → `git revert` (bare, no journal) → `why(file)`/`recent()` return the atom flagged `reverted: true`, original order, marker rendered with both halves.
- Revert the revert → flag cleared on the original atom.
- Reverted decision whose files are gone → BOTH tags render (stale + reverted).
- Unreverted atoms in the same result → unflagged.
- Rollup atoms → never flagged.

**Verification:** The bare-revert scenario (the whole point: consequence that bypassed capture) produces a flagged, ordered, marked result.

---

### U3. Dream eviction exemption

**Goal:** Failure memory ages by recency, not by its deliberately deleted code.

**Requirements:** Reverted exempt from stale-first; store stays bounded.

**Dependencies:** U1, U4 — merge order, not runtime: U4's strip must be in the codebase with or before U3, so annotated atoms never reach an un-stripped `writeNote` (no persistence-leak window between commits).

**Files:**
- `src/capture/dream.ts` — *calls* the store annotators (`annotateReverted` on its `{atom, commit}` entries, `annotateStale` on the atoms) before `compactGraph`; same post-early-return placement as the staleness annotation.
- `src/engine/compact.ts` — eviction rank becomes: fold-first iff `stale && !reverted`; otherwise plain recency. Comment updated to name the rule.
- `tests/dream.test.ts`, `tests/engine.test.ts` — eviction-order scenarios.

**Approach:** One-line change to the existing comparator's stale rank (`(a.stale && !a.reverted) ? 1 : 0`). `compact()` (per-commit) remains untouched.

**Patterns to follow:** the staleness eviction-bias change in `compactGraph` (same comparator, same tests file).

**Test scenarios:**
- Over budget: a single atom carrying BOTH flags (reverted decision whose code is gone) vs an older live atom → the dual-flagged atom is NOT folded ahead of the live one purely for staleness; ranks by recency.
- Over budget: very old reverted atom vs newer live atoms → reverted atom still folds (no immortality).
- Non-reverted stale atom → still folds first (existing behavior preserved).
- Round-trip: after a dream over annotated atoms, no persisted atom carries `reverted` (with U4).

**Verification:** Eviction order matches the rule; store size still converges under budget.

---

### U4. Extend the non-persistence chokepoint

**Goal:** `reverted` never lands in a git note.

**Requirements:** Derived-only; Lore trailers untouched (no trailer path reads the flag).

**Dependencies:** U1.

**Files:**
- `src/store/notes.ts` — extend the `writeNote` strip: `({ stale, reverted, ...rest }) => rest`.
- `tests/staleness.test.ts` or `tests/reverts.test.ts` — persistence-exclusion test.

**Test scenarios:**
- `writeNote` with atoms carrying `reverted: true` → raw note JSON has no `reverted` key; other fields intact.

**Verification:** Inspecting `refs/notes/cairn` after a dream over reverted atoms shows neither derived flag.

---

## Scope Boundaries

### In scope
- Net-revert detection (literal `git revert`, incl. `--reference`), entries-based annotation, two-part marker, dream eviction exemption, strip extension.

### Deferred to Follow-Up Work
- Partial reverts (a revert touching only some files of a multi-commit decision) — v1 flags per reverted commit only.
- **Merge-commit reverts (`git revert -m`)**: the revert body names the *merge* commit, but decision atoms live on the merged-in branch commits — so reverting a whole feature via its merge commit flags nothing in v1. Distinct from partial reverts; named here so the smoke test doesn't read as "detection is broken."
- Whether `recent()` should batch/share detection across calls in a long-lived server (cache-by-HEAD micro-optimization).

### Outside this product's identity (from origin)
- Manual-undo content analysis; synthesized "failure atoms" at write time; persisting derived flags; keep-forever failure memory; model calls on the read path.

---

## Risks & Dependencies

- **Read-path cost:** one extra full-history `git log` per request, alongside the existing rename-map call. Acceptable (explicit agent calls, 20s git timeout, lazy patterns available if it ever bites); flagged in Deferred.
- **Annotation-seam refactor touches day-old code** (staleness entries) — tests from the staleness build are the safety net; behavior of `stale` must not change.
- **Abbreviated-SHA ambiguity:** a 7-char prefix matching multiple commits is dropped rather than guessed — a missed flag, never a wrong one.
- **Engine decoupling:** `netRevertedShas` is pure; enforced by `tests/decoupling.test.ts`.

---

## Verification Strategy

- Unit: resolver chains (U1), edge extraction incl. `--reference` (U1), strip (U4).
- Behavior: bare-revert end-to-end, revert-of-revert, dual tags (U2); eviction order (U3).
- Invariant: decoupling test, `npm run verify` green.
- Manual smoke: record a decision, commit, `git revert` it, call `why` in a fresh session — the failed approach appears flagged with constraints intact.
