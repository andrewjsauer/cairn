# Atom staleness — requirements

**Date:** 2026-06-03
**Scope:** Deep — feature (extends existing Cairn product shape)
**Status:** Ready for planning

## Problem

Cairn decision atoms carry a `files: string[]` code index captured at write time. Nothing checks whether those files still exist when `why(file)` or `recent(n)` serves the atom. A decision whose code has been deleted is served with the same authority as one written yesterday — the agent can act on a constraint that describes code that is gone.

`supersedes` already handles the case where code *evolves* (the next decision sits on top of the old one). The gap it does **not** cover: you delete a file, you don't open a decision announcing the deletion — so atoms about deleted code are never retired and become orphaned noise.

**Honest framing:** this is anticipatory, not observed. Cairn is single-player and pre-users; there is no logged case of a stale atom degrading a `why()` answer yet. The narrow, structural-only scope below is the deliberate hedge against speculatively over-building.

## Inspiration

GitHub Copilot's just-in-time citation verification — the only memory mechanism in the field with published production outcome data (PR merge rate 83%→90%). Copilot re-validates a memory's file-and-line citation against the current branch before use. Cairn adapts the *structural* half of that idea and deliberately rejects the *semantic* half (see Non-goals).

## Outcome

An atom whose referenced files have all disappeared from `HEAD` is marked `stale: true`, surfaced honestly through `why`/`recent` (never silently dropped), and folded out of the hot set first by the dream. A cold-session agent can tell "this reasoning is about code that no longer exists" from "this reasoning is current."

## Definition

An atom is **structurally stale** when *all* of its `files` are absent from `HEAD` (after `git log --follow` rename resolution). If even one referenced file still resolves, the atom is live.

Consequence of the "all files gone" definition: a stale atom essentially cannot appear in a `why(<liveFile>)` chain — if the queried file is live, not all of the atom's files are gone. Stale atoms therefore only surface in:
- `why(<deleted/renamed path>)` — the whole chain is stale, and
- `recent(n)` — where a *freshly* stale atom ("we just ripped out X") is useful cold-session orientation.

Both cases want flag-don't-reorder. No down-ranking is needed anywhere.

## In scope

- **Structural staleness only** — all of an atom's `files` absent from `HEAD`, after `--follow` rename resolution.
- **Derived, not stored** — staleness is computed by the git-aware store/MCP layer at read-assembly time, annotated as a transient field on the in-memory atom. The engine reads `atom.stale`; it never imports git, and `stale` is never persisted into the notes graph.
- **Recall surface** — `recall()` returns `stale: true` on stale atoms, preserves existing ordering (chronological for `why`, newest-first for `recent`), and never filters. Same honesty contract as the existing `truncated` flag.
- **Dream eviction bias** — when `compactGraph` is over budget and choosing what to fold, stale atoms fold into rollups ahead of live atoms of similar age. Dead-code reasoning compresses out of the hot set; live reasoning stays verbatim longer.

## Deferred to planning

- Exact staleness definition for multi-file atoms and the rename / `--follow` edge cases (e.g. partial-rename, file resurrected at a new path).
- Whether `recent()` ever needs down-ranking of stale atoms (current call: no — a fresh stale atom is informative).
- Precise mechanism for biasing the dream's keep/overflow partition without aggressively evicting a brand-new stale atom that still fits the budget.

## Non-goals (out by design, not budget)

- **Semantic / content re-validation** ("does the constraint still hold against current code?"). This is a category error in Cairn: code evolving is `supersedes`' job (the next atom retires the old one), and a model-based re-evaluation pass is the memory-platform drift `DESIGN.md` §93 forbids. A model asked "does this still hold?" against current code also hallucinates confidence.
- **Persisting `stale` into the notes graph** — it is volatile, derived state.
- **Any change to Lore commit trailers** — they are the permanent, human-visible record and are never mutated.
- **Embeddings, vector store, TTL / auto-expiry** — all forbidden by the narrow strategy.

## Success criteria

- `why(<deleted path>)` returns the chain with every atom flagged `stale: true`, in chronological order, nothing dropped.
- `why(<live path>)` is unchanged — no atom flagged stale.
- `recent(n)` flags atoms whose code is gone while preserving newest-first order.
- The engine source still passes `tests/decoupling.test.ts` (zero git imports added).
- Over budget, the dream folds stale atoms into rollups before live atoms of comparable age.
- `stale` never appears in persisted notes or in Lore trailers.

## Architectural constraints (from DESIGN.md)

- Engine (`src/engine/`) keeps **zero imports** from git, Claude Code, the store, or the Anthropic SDK — enforced by `tests/decoupling.test.ts`. Staleness is injected as data, computed upstream.
- Read path stays **pure git, no model call** — the structural check is a git operation, which is why semantic re-validation (a model call) is excluded rather than deferred.
- Git is the only backend; honesty over silent truncation/drop (precedent: `recall.ts`).

## Dependencies

- Existing rename-following helper `commitsTouchingFile` (`src/store/git.ts:114`, `git log --follow`).
- The store/MCP atom-assembly path (reads notes graph + Lore trailers) is where HEAD-resolution and annotation land.
- `recall()` (`src/engine/recall.ts`) and `compactGraph()` (`src/engine/compact.ts`) consume the annotated atoms.
