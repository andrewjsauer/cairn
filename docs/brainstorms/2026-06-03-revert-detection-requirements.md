# Revert detection (action feedback) — requirements

**Date:** 2026-06-03
**Scope:** Deep — feature (extends existing Cairn product shape)
**Status:** Ready for planning

## Problem

Cairn's chain captures *evolution* (`supersedes`) and *deletion* (the `stale` flag), but not **failure**. A `git revert` of a commit carrying Cairn atoms is a consequence event — "this approach was tried and undone" — and today it is invisible: a bare `git revert` flows through `consolidate-if-commit` with an empty journal and produces nothing (`empty-journal, written: 0`). The highest-value memory for a coding agent — *the failed approach that should not be retried* — is exactly what never gets recorded.

Worse, the staleness feature shipped 2026-06-03 makes this actively backwards: **a revert deletes the code, so the failed-approach atom reads stale, and the dream folds stale atoms first**. Cairn currently evicts the "don't retry this" memory *fastest*. This is not purely anticipatory — it is a real tension in shipped behavior.

## Inspiration

Sentra's "Memory Is Purpose" substrate requirement Cairn lacks: **action feedback** — "when an agent acts, a human corrects it, a bug reappears … the result should feed back into the substrate. Otherwise the system stores traces but does not learn from work." The git-native form: revert commits self-identify (`This reverts commit <sha>.`), and Cairn's notes are keyed by commit SHA, so reverted-sha → its atoms is a clean mapping. Pure git, no model call — fits the read-path invariant.

## Outcome

An atom whose commit was reverted (and not re-landed) is marked `reverted: true`, surfaced honestly through `why`/`recent` with a marker that says *the approach failed but its recorded constraints may still bite*, and exempted from the dream's stale-folds-first eviction so failure memory ages by recency, not by its (deliberately) deleted code.

## Definition

An atom is **net-reverted** when the commit it was consolidated at was undone by a revert commit that is itself still in effect. Net status is computed from history at read time: a revert-of-a-revert re-lands the approach, so the original atom is *not* reverted. Detection covers **literal `git revert` commits only** (the self-identifying `This reverts commit <sha>.` message).

**Why literal-only is principled, not a compromise (division of labor):** an undo performed *through* Cairn's capture — agent edits, journals reasoning, commits — already becomes a chain decision with the *why*, linked by overlap-scored `supersedes`. That is the majority case and the better record. Revert detection is the fallback for consequence that **bypassed capture**, and bare `git revert` is exactly the bypass that self-identifies. A manual code-it-back-by-hand undo with no capture and no revert commit stays invisible: accepted, eyes-open.

## In scope

- **Net-revert detection, pure git** — scan history for revert commits (one `git log --grep`-class call), build reverted-sha relationships, resolve net status (revert-of-revert chains). Map net-reverted SHAs to their atoms (notes are keyed by commit SHA; trailer-derived atoms carry their commit identity).
- **Derived, not stored** — `reverted` follows the `stale` pattern exactly: computed by the git-aware layer at read-assembly (and dream) time, transient on the in-memory atom, stripped at the `writeNote` serialization chokepoint, never persisted.
- **Recall surface** — `why`/`recent` return `reverted: true`, preserve ordering, never filter. The rendered marker must carry **both halves**: the approach was undone, AND its recorded constraints/rejected-alternatives may still apply (e.g. `↩ REVERTED — this approach was undone; its constraints may still apply`). It must not read as "ignore this." Can co-occur with the STALE tag — they often will.
- **Dream eviction: neutralize, don't immortalize** — net-reverted atoms are exempt from the stale-folds-first bias (their code being gone is the point of a revert, not evidence of irrelevance). They age out by plain recency like live atoms. No "never compacts" guarantee — the store stays bounded; a folded reverted atom's arc survives in its rollup summary.

## Deferred to planning

- Detection mechanics: message-grep vs walking commits already in hand; whether `recent()` shares one fetch per request like the rename map (current call: accept one flat git call per query — no cheap pre-filter exists, and silent-about-reverts `recent()` is worse).
- Net-status resolution details for chained/partial reverts (a revert touching only some files of a multi-commit decision).
- Whether the reverted flag also rescues the atom from the *stale display tag* or both tags show (current call: both show — they are different facts).

## Non-goals (out by design, not budget)

- **Manual-undo detection via content analysis** — fuzzy, expensive, and the capture path already records reasoned undos as chain decisions.
- **Synthesized "failure atoms" at write time** — a revert can mean bad approach, wrong timing, release rollback, or accident. Writing "failure" into the store commits to an interpretation; the derived flag records the *event* and lets the reading agent judge. (Semantics at ingestion, ontology at retrieval — the article's own rule.)
- **Persisting `reverted` into notes; mutating Lore trailers; model calls on the read path; keep-forever priority for failure memory.**

## Success criteria

- A consolidated decision whose commit is then `git revert`ed appears in `why(file)`/`recent()` flagged `reverted: true`, in original order, with the two-part marker.
- A revert-of-the-revert clears the flag on the original atom (net status).
- A bare `git revert` with no journal activity still produces the flag (the bypass case).
- Over budget, a reverted+stale atom is NOT folded ahead of live atoms of similar age (stale-first bias does not apply to it); an old reverted atom still folds eventually by recency.
- `reverted` never appears in persisted notes or Lore trailers; `tests/decoupling.test.ts` still passes.

## Architectural constraints (from DESIGN.md + shipped precedents)

- Read path stays pure git, no model call. Engine stays git-free — revert facts are injected as plain data (the `stale`/`renames` precedent: pure rule in `src/engine/`, git in `src/store/`, annotation at assembly in `src/store/staleness.ts` / `src/mcp/graph.ts`).
- `writeNote` (`src/store/notes.ts`) is the single serialization chokepoint — extend the existing strip.
- Honest-flag precedent: `truncated`, `stale` (`src/engine/recall.ts`, `src/mcp/format.ts`).

## Honest assumption on the record

The *retry-prevention* value is anticipatory — no logged incident of an agent re-attempting a reverted approach. The *eviction inversion* is not anticipatory: shipped behavior demonstrably folds reverted-then-stale reasoning first, and this feature corrects it.
