---
title: "feat: Structural staleness signal for decision atoms"
type: feat
status: completed
date: 2026-06-03
depth: standard
---

# feat: Structural staleness signal for decision atoms

## Summary

Mark a decision atom **stale** when all of its referenced files have disappeared from `HEAD`, surface that fact honestly through `why`/`recent` (flagged, order preserved, never dropped), and let the dream fold stale atoms out of the hot set before live ones. Structural-only: detection is pure git, so the no-model-call read path is preserved. Semantic re-validation is out by design — code evolving is `supersedes`' job, and a model-based re-evaluation pass is the memory-platform drift the brief forbids (see origin: `docs/brainstorms/2026-06-03-atom-staleness-requirements.md`).

---

## Problem Frame

Atoms carry a `files: string[]` code index captured at write time. Nothing checks whether those files still exist when `why(file)` or `recent(n)` serves the atom, so reasoning about deleted code is served with the same authority as current reasoning. `supersedes` covers code that *evolves* (the next decision sits on top of the old one); it does **not** cover deletion — you delete a file, you don't open a decision announcing it, so atoms about deleted code are never retired.

This is anticipatory, not observed (single-player, pre-users). The narrow structural-only scope is the deliberate hedge against over-building.

---

## Key Technical Decisions

- **KTD1 — Staleness is derived data, represented as an optional `stale?: boolean` on the atom.** Computed in the git-aware layers (read: `src/mcp/graph.ts`; write: `src/capture/dream.ts`), consumed by the engine as plain data. The engine imports no git — it only reads `atom.stale`. This honors the origin decision ("transient field on the in-memory atom; engine reads `atom.stale`").
- **KTD2 — The staleness rule lives in one pure engine function.** `isStale(atom, livePaths)` is the single tested definition shared by both paths, so read and write never disagree. The git layer supplies the live-path set; the engine owns the rule.
- **KTD3 — One git call per recall/dream, not per file.** A single `git ls-tree -r --name-only HEAD` snapshot (`filesAtHead`) yields the live-path `Set`; staleness is then set membership. Avoids N `cat-file` calls across many atoms.
- **KTD4 — Non-persistence guaranteed at the serialization chokepoint.** `writeNote` omits derived fields (`stale`) before `JSON.stringify`. One place, one guarantee — the dream can freely annotate `stale` for eviction without any leak into notes.
- **KTD5 — Eviction bias is scoped to `compactGraph` (the dream) only.** Per-commit `compact()` is left unchanged: a just-touched file in a fresh commit is not a staleness case.
- **KTD6 — `recall.ts` selection logic is unchanged.** The flag rides on the atom through the existing result; ordering (chronological for `why`, newest-first for `recent`) is preserved exactly. Only `format.ts` changes on the read surface, to render the marker.
- **KTD7 — Staleness definition (MVP): a path is "present" iff it appears in the HEAD tree snapshot.** A renamed-away file therefore reads as stale until `--follow` rename resolution is added (deferred — see Scope Boundaries). An atom with an empty `files` list is never stale.

---

## Requirements Traceability

| Requirement (origin) | Covered by |
|---|---|
| Structural staleness: all `files` absent from HEAD | U1, U2 |
| Derived, not stored; engine stays git-free | U1 (type + pure rule), U4 (non-persistence) |
| Recall returns `stale: true`, preserves order, never filters | U2 |
| Dream folds stale before live of similar age | U3 |
| No semantic re-validation / no model on read path | Whole design (structural-only) |
| `stale` never in notes or Lore trailers | U4 |
| Engine passes `tests/decoupling.test.ts` | U1, U3 |

---

## Implementation Units

### U1. Staleness primitive: HEAD snapshot, pure rule, type field

**Goal:** Provide the three building blocks staleness needs — a cheap live-path snapshot, a single pure rule, and a place to carry the flag.

**Requirements:** Structural detection; engine stays git-free; derived data.

**Dependencies:** none.

**Files:**
- `src/engine/types.ts` — add optional `stale?: boolean` to `DecisionAtom` and `RollupAtom` (or to a shared base), documented as derived/transient (never persisted).
- `src/engine/staleness.ts` (new) — pure `isStale(atom, livePaths: Set<string>): boolean`. Exported via `src/engine/index.ts`.
- `src/store/git.ts` — `filesAtHead(cwd): Set<string>` via a single `git ls-tree -r --name-only HEAD` (allowFail → empty set on no-HEAD / empty repo).
- `src/store/index.ts` — export `filesAtHead`.
- `tests/staleness.test.ts` (new) — engine rule tests.
- `tests/hardening.test.ts` or `tests/integration.test.ts` — extend with `filesAtHead` git-level tests.

**Approach:** `isStale` returns `true` iff `atom.files.length > 0 && atom.files.every(f => !livePaths.has(f))`. The rule is identical for level-0 and rollup atoms (a rollup's `files` is the union of its sources). `filesAtHead` is the only new git surface and lives in the store layer where git access is allowed.

**Patterns to follow:** `commitsTouchingFile` in `src/store/git.ts` for the `git(...)` + `allowFail` idiom; existing pure engine modules (`overlap.ts`, `budget.ts`) for the decoupled-function style.

**Test scenarios:**
- `isStale`: all files absent from livePaths → true.
- `isStale`: one file present, rest absent → false.
- `isStale`: empty `files` array → false (never stale).
- `isStale`: rollup atom with union files all absent → true.
- `filesAtHead`: repo with tracked files returns the exact set.
- `filesAtHead`: after a file is `git rm`'d and committed, the deleted path is absent from the set.
- `filesAtHead`: empty repo / no HEAD → empty set, no throw.

**Verification:** `isStale` and `filesAtHead` are unit-tested; `tests/decoupling.test.ts` still passes (no git import added to `src/engine/`).

---

### U2. Annotate and surface staleness in the read path (`why` / `recent`)

**Goal:** A cold-session agent sees which served atoms describe code that no longer exists, without losing the evolution arc.

**Requirements:** Recall returns `stale: true`; ordering preserved; never filtered.

**Dependencies:** U1.

**Files:**
- `src/mcp/graph.ts` — in `atomsForFile` and `allAtoms`, snapshot `filesAtHead(cwd)` once and set `atom.stale = isStale(atom, live)` on each assembled atom before returning.
- `src/mcp/format.ts` — render a stale marker per atom in `renderForRead` (and therefore in both `formatChain` and `formatRecent`).
- `tests/integration.test.ts` — read-path behavior tests (drives the assembly + recall + format path).

**Approach:** Staleness is computed at assembly time (post-dedupe) so both note atoms and trailer-derived atoms are covered with one snapshot. `recall.ts` is untouched — the flag rides on the atom through `RecallResult.atoms`, and selection/ordering stay as they are. The marker in `format.ts` should be unambiguous and terse (e.g. a leading `⚠ stale (code no longer present)` line or a `[stale]` tag on the header line), consistent with the existing `[lore-id …]` annotation style.

**Patterns to follow:** existing dedupe-then-return shape in `src/mcp/graph.ts`; the per-atom line composition in `renderForRead` (`src/mcp/format.ts`).

**Test scenarios:**
- `why(file)` on a path whose atoms all reference deleted files → every returned atom flagged stale; chain still oldest→newest; nothing dropped.
- `why(liveFile)` → no atom flagged stale (a live queried file means not all of an atom's files are gone).
- `recent(n)` including an atom whose code was just deleted → that atom flagged stale, newest-first order preserved, others unflagged.
- `format` output renders the stale marker for a stale atom and omits it for a live one.
- Mixed result (some stale, some live) → order unchanged, only stale atoms marked.

**Verification:** Reading `why`/`recent` over a repo with a deleted file shows flagged-but-present records in original order; live files are unaffected.

---

### U3. Dream eviction bias toward stale atoms

**Goal:** When the store is over budget, dead-code reasoning compresses into rollups ahead of live reasoning of similar age, so the hot set stays bounded against the right thing.

**Requirements:** Dream folds stale before live of similar age.

**Dependencies:** U1. Land with or before U4 (U4 prevents the annotated flag from leaking into notes).

**Files:**
- `src/capture/dream.ts` — in `consolidateGraph`, snapshot `filesAtHead(root)` and set `atom.stale` on the atoms before calling `compactGraph`.
- `src/engine/compact.ts` — adjust `compactGraph`'s keep/overflow partition so stale level-0 atoms are preferred for overflow: fill `keep` from newest **live** atoms first, then newest stale atoms only if budget remains; everything else overflows into rollups. Preserve the existing "keep newest verbatim, fold the tail" behavior for live atoms.
- `tests/dream.test.ts` — eviction-order tests.

**Approach:** Today `compactGraph` keeps newest level-0 atoms that fit and overflows the oldest. The change makes staleness the primary eviction key and recency the secondary: a stale atom is a candidate to fold even if it is newer than a kept live atom, but a stale atom that still fits after all live atoms are kept may remain verbatim (don't aggressively evict a brand-new stale atom for no budget reason). `compact()` (per-commit) is intentionally left unchanged (KTD5). `stale` must not appear on the produced rollups' persisted form — guaranteed by U4.

**Patterns to follow:** the existing keep/overflow loop and `groupByFileOverlap`/`rollup` flow in `src/engine/compact.ts`; `consolidateGraph`'s `filesAtHead`-style git access mirrors U2's read-path annotation.

**Test scenarios:**
- Over budget with a stale newer atom and a live older atom → stale atom folds into a rollup, live older atom kept verbatim.
- Over budget, all atoms live → behavior identical to today (recency-only eviction).
- Within budget → no-op regardless of staleness (early return preserved).
- Stale atom that still fits after all live atoms are kept → remains verbatim (no gratuitous eviction).
- Provenance: a rollup folding a stale atom records the stale atom's original `loreId` in `sourceIds`.

**Verification:** A dream run over an over-budget store with deleted-file atoms folds those first; `before`/`after`/`rollups` counts reflect it; live reasoning survives verbatim.

---

### U4. Guarantee staleness never persists

**Goal:** The derived `stale` flag never lands in a git note (and, by construction, never in a Lore trailer).

**Requirements:** `stale` never in notes or trailers.

**Dependencies:** U1 (type field exists so tests can set it).

**Files:**
- `src/store/notes.ts` — `writeNote` strips derived fields (`stale`) from each atom in `payload.atoms` before `JSON.stringify`. Single serialization chokepoint.
- `tests/dream.test.ts` and/or `tests/integration.test.ts` — persistence-exclusion tests.

**Approach:** Apply a small omit transform to `payload.atoms` inside `writeNote` (e.g. map each atom to a copy without `stale`) so any caller — the dream, consolidation, future writers — is protected. Lore trailers are produced by a separate path (`src/store/trailers.ts`) that builds from explicit fields and never reads `stale`, so no change is needed there; note that fact rather than touching it.

**Patterns to follow:** the existing `NotePayload` construction and `writeNote` body in `src/store/notes.ts`.

**Test scenarios:**
- `writeNote` with atoms carrying `stale: true` → `readNote` / raw note JSON contains no `stale` key.
- Round-trip: `consolidateGraph` over atoms annotated stale → no persisted note atom (per-commit or ledger rollup) carries `stale`.
- A live atom round-trips unchanged (no field accidentally dropped besides `stale`).

**Verification:** Inspecting `refs/notes/cairn` after a dream shows no `stale` field on any atom; `readNote` parsing is unaffected.

---

## Scope Boundaries

### In scope
- Structural staleness (all `files` absent from HEAD snapshot), read-path flagging, dream eviction bias, non-persistence guarantee.

### Deferred to Follow-Up Work
- **`--follow` rename resolution** so a renamed-but-present file is not flagged stale (MVP flags it until then — KTD7). Would extend `filesAtHead`/`isStale` with a rename-mapping step using `commitsTouchingFile`.
- Whether `recent()` should ever down-rank stale atoms (current call: no — a freshly stale atom is informative orientation).

### Outside this product's identity (from origin)
- Semantic / content re-validation ("does the constraint still hold?") — `supersedes`' job; model-based re-evaluation is memory-platform drift.
- Persisting `stale` into notes; mutating Lore commit trailers.
- Embeddings, vector store, TTL / auto-expiry.

---

## Risks & Dependencies

- **Persistence leak (mitigated):** the dream annotates atoms it also persists; without U4 the flag would reach notes. U4's chokepoint strip closes this; sequence U3 with/after U4.
- **Decoupling regression:** staleness must not introduce a git import into `src/engine/`. `isStale` takes a `Set<string>`; git access stays in store/capture/mcp. `tests/decoupling.test.ts` enforces this.
- **Rename false-positives (accepted for MVP):** a renamed-away file reads as stale until the deferred `--follow` work lands. Acceptable because the flag is advisory and surfaced, not destructive.
- **Empty/no-HEAD repos:** `filesAtHead` must degrade to an empty set without throwing, which would otherwise mark every atom stale; covered by U1 tests.

---

## Verification Strategy

- Unit: `isStale` rule and `filesAtHead` snapshot (U1); `writeNote` omission (U4).
- Behavior: read-path flagging and ordering via the integration path (U2); dream eviction order and provenance (U3).
- Invariant: `tests/decoupling.test.ts` green; `npm run verify` (existing local gate) passes.
- Manual smoke: in a repo with a recorded decision, `git rm` the file, commit, then call `why(<deleted path>)` and `recent` — records appear flagged, in order; run the dream over an over-budget store and confirm no `stale` field in `refs/notes/cairn`.
