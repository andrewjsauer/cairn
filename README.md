# Cairn

**A self-compacting, code-indexed decision graph for AI coding agents — built on git and Lore-compatible decision records, served over MCP.**

Git is a perfect record of *what* changed and an amnesiac about *why*. Cairn captures the reasoning behind code as work happens, stores it in git itself, and hands a fresh agent session the answer to *"why is this code the way it is?"* — bound to the specific decision that touched the code, not to a file, a folder, or a chat log.

Cairn does not invent a format and does not run a backend. It emits [Lore](https://github.com/Ian-stetsenko/lore-protocol)-compatible commit trailers, keeps a compacted graph in a `refs/notes/cairn` git-notes namespace, and serves two read tools over the Model Context Protocol. It is single-player and local.

> **Cairn** (working name) — a cairn is a stack of stones hikers build to mark a trail, left so the next person to come through can find the way the last one already worked out. That is exactly the job here: leave a durable marker of the reasoning behind a piece of code, so the next traveler — usually an agent with no memory of yesterday — doesn't have to re-find the path from scratch.

---

## The loop

```
plan approved / /cairn:decision  ─▶  opens a decision (intent + alternatives)
agent edits a file               ─▶  durable journal entry in .git/cairn/   [synchronous, no model call]
you commit                       ─▶  consolidate: journal ─▶ Lore trailers on the commit
                                                + decision atoms in refs/notes/cairn
compaction / session end|start   ─▶  flush journal ─▶ notes graph, then dream: compact the store if over budget
fresh session                    ─▶  cairn MCP ─▶ why(file) | recent(n)
```

A decision opens two ways: automatically when you **approve a plan** (the plan is the richest statement of intent there is), or manually with `/cairn:decision "<intent>"`. Consolidation runs at every inflection point — at a **commit** it writes Lore trailers onto the commit and updates the notes graph; at **compaction / session end / session start** there is no commit to amend, so it promotes the journal to the notes graph only, making in-flight reasoning queryable across sessions before it is committed.

At those same idle boundaries (or on demand via `cairn dream`), Cairn also **dreams**: when the whole stored graph has grown past a budget, it folds the oldest decisions into compact rollups so the store stays bounded as history accrues — the self-compacting "memory" step, run at sleep-time rather than inline. See [DESIGN.md](DESIGN.md#the-dream-bounding-the-whole-store-memory-consolidation).

Capture is split from persistence on purpose. The reasoning is journaled the instant a file changes, so a `/clear`, a crash, or a compaction can't erase it. Turning that raw journal into clean Lore records happens later, at a commit. **Durability never waits for a commit and never depends on catching a teardown event** — a missed trigger loses nothing, because the journal survives and the next commit picks it up.

## Why Cairn is different

Every individual capability here already exists somewhere. The unoccupied space is the *intersection*, and Cairn occupies exactly that and nothing wider:

- **Decision-record tools** (Lore, Contextual Commits, ADRs) are git-native and code-adjacent, but have no compaction and mostly no protocol — they grow until they're noise, and they never reach the agent.
- **The memory layer** (mem0, Letta, Zep, native model-lab memory) is self-compacting and agent-served, but problem- or conversation-indexed: it remembers what you *talked about*, not why a specific line looks the way it does.
- **Context platforms** (Sourcegraph, Augment, Unblocked) are automatic and agent-served, but are managed retrieval engines over many sources, not git-native decision graphs.

What nobody has shipped as one thing is the full intersection — and that is Cairn:

| Axis | Cairn |
|---|---|
| **Capture** | Automatic, at decision-time and edit-time — not a manual writeup step. |
| **Index** | Bound to the **decision** that touched specific code — not a file, a folder, or a chat session. |
| **Size** | Self-compacting under a per-agent token budget, so a month of work still fits a cold session. |
| **Storage** | Git itself — Lore trailers + `refs/notes/cairn`. No backend; it travels with the repo. |
| **Delivery** | Served to agents over MCP. |

The sharpest, most underserved part is **code-indexed at decision granularity**. Most memory remembers conversations; very little remembers *why a particular piece of code exists*, bound to that code, in a form an agent can query. A file accumulates a **chain of decisions** over its life, and `why(file)` returns that whole chain — the evolution of the thinking is itself the context a newcomer needs.

The discipline matters as much as the features. Everything except that middle layer is composed from proven pieces — git as the substrate, [Lore](https://github.com/Ian-stetsenko/lore-protocol) for the format, MCP for delivery — rather than reinvented. The one differentiated thing is the self-compacting, code-indexed graph in the middle, and Cairn refuses to drift into general agent memory, conversation memory, or a fifth competing capture format. Staying narrow is the strategy. See [DESIGN.md](DESIGN.md) for the full rationale and the honest risks.

## Quick start (about five minutes)

Requirements: Node 18+, git, and an `ANTHROPIC_API_KEY` (only the capture/consolidation path calls a model — the read path is pure git).

```bash
git clone <your-fork-url> cairn && cd cairn
npm install
npm run build           # compiles to dist/ — the plugin runs the compiled output
npm test                # 17 tests, no API key needed
export ANTHROPIC_API_KEY=sk-ant-...   # for consolidation; see .env.example
```

Install it as a user-level Claude Code plugin so it works in every repo. Point Claude Code at this directory as a plugin (via `/plugin` or your marketplace setup). Once enabled:

- A `PostToolUse` hook journals every `Edit`/`Write`/`MultiEdit` to `.git/cairn/`.
- A `PostToolUse` hook on `Bash` consolidates whenever it sees a `git commit`.
- A `PostToolUse` hook on `ExitPlanMode` auto-opens a decision from the approved plan.
- `PreCompact`, `SessionEnd`, and `SessionStart` hooks flush the journal to the notes graph and dream (compact the store) if it has grown past budget.
- An MCP server named `cairn` exposes `why` and `recent`.
- A `/cairn:decision` command opens a decision manually.

Try it:

```
/cairn:decision "retry transient upstream failures twice before failing"
```
…make some edits, then commit. In a **new** session, ask the agent *"why does this file retry twice?"* — it will call `why(<file>)` and get the constraint and the rejected alternatives back, instead of re-deriving them.

### See it work without Claude Code

`node scripts/smoke.mjs` runs the entire slice against a throwaway git repo with a stubbed model: it opens a decision, journals an edit, consolidates into Lore trailers + notes, and drives the **real MCP server over stdio** to call `why` and `recent`. It prints a before/after at the end.

## The two read tools

| Tool | Returns |
|---|---|
| `why(file)` | The file's **chain of decisions** over time (oldest → newest), each with intent, constraints, rejected alternatives, confidence, and supersedes links. The evolution is the point — not a single summary. Reads the notes graph **and** Lore trailers (including ones written by other tools). |
| `recent(n)` | The latest `n` decisions across the repo, newest first. Good for orienting a cold session. |

Both are read-only and **budget-bounded**: a result is trimmed to a token ceiling so the graph never outgrows an agent's attention budget as the repo grows.

## What gets written to git

- **Commit trailers (human-visible, interoperable).** A Lore-compatible block is appended to the commit message:
  ```
  Lore-id: 9b975dc6
  Constraint: upstream cold-start can exceed 500ms
  Rejected: fail fast with no retry | caused spurious user-facing errors on cold start
  Confidence: high
  ```
  `git interpret-trailers --parse` reads these, and so does any Lore-style consumer.
- **A git note** in `refs/notes/cairn`, keyed by commit SHA, holding that commit's decision atoms (and any rollups) as JSON. Notes travel with the repo, update without rewriting history, and never touch the working tree or a PR.

Notes are **not** fetched/pushed by default. To share them, add a fetch refspec (safe and additive) and push notes explicitly:

```bash
git config --add remote.origin.fetch '+refs/notes/cairn:refs/notes/cairn'   # fetch pulls notes
git push origin refs/notes/cairn                                            # push notes
```

Avoid setting `remote.origin.push` to *only* the notes refspec — that would stop plain `git push` from pushing your branches.

## Configuration

One file: [`src/config.ts`](src/config.ts).

- `MODEL` — the model behind capture/consolidation (default `claude-haiku-4-5-20251001`). Swap it here.
- `RECALL_TOKEN_BUDGET` — ceiling for a `why`/`recent` result.
- `COMPACT_TOKEN_BUDGET` — ceiling the graph is compacted to.
- `NOTES_REF` — the git-notes namespace (`cairn`).

## Assumptions and scope (this first pass)

Built against the brief, with the full capture/consolidation trigger set wired (plan-mode auto-open, commit, pre-compaction, session end/start). Decisions made along the way:

- **All triggers wired, durability independent of them.** Capture opens via approved plan or the manual `/cairn:decision`; consolidation runs at commit (trailers + notes), and at compaction / session end / session start (notes only). Because the edit-time journal is synchronous and on disk, every consolidation trigger is a *promptness* enhancement — a missed one loses nothing; the next trigger (or the next commit) picks the journal up.
- **No-key fallback.** Capture/consolidation call Haiku, but if `ANTHROPIC_API_KEY` is unset the model call fails over to a deterministic record (recorded intent + raw reasons), so the loop still produces durable, queryable decisions — just without model polish.
- **`/decision` is `/cairn:decision`.** Claude Code namespaces plugin commands by plugin name; there is no way to claim a bare `/decision` from a plugin.
- **MCP repo resolution.** The brief said "git rev-parse from the session working directory." A user/plugin MCP server is spawned once and its `cwd` isn't guaranteed to be the session repo, so Cairn resolves the active repo from `CLAUDE_PROJECT_DIR` (set in the server's env by Claude Code; `roots/list` is the documented fallback) and then runs `git rev-parse --show-toplevel` from there — same outcome, correct mechanism.
- **Trailers via amend, guarded.** There is no native git-commit hook in Claude Code, so trailers are written onto the just-made commit with `git commit --amend`, **replacing** (not appending) any prior Cairn block so there is always exactly one `Lore-id` per commit. The amend is skipped automatically when it would be wrong — the commit is already on a remote-tracking branch, or the commit is **GPG/SSH-signed** (re-signing without consent is not Cairn's call). In both cases the git-note alone carries the reasoning; notes never rewrite history.
- **Consolidation runs synchronously** inside the commit hook, so a commit pauses briefly while Haiku synthesizes. The Anthropic call and every git call have hard timeouts, and the hook always exits 0 — it never blocks indefinitely or fails the session.
- **Compaction is two-layer.** Read-time `recall()` bounds every `why`/`recent` result to a token budget regardless of graph size. The **dream** (`consolidateGraph` / `cairn dream`) bounds the *stored* graph: at idle boundaries it folds the oldest decisions into one rollup per file-cluster (one rollup level, single `STORE_TOKEN_BUDGET` knob), so the store stays bounded as history grows. Rollups live in a ledger note on git's empty-tree anchor; commit trailers are never rewritten.

### Known limitations (deliberate, for this pass)

- **Commit attribution across a missed trigger.** If consolidation is missed at commit A and runs at commit B, the journaled edits from A are attributed to B (the journal binds to the current HEAD). This follows directly from the brief's "a missed trigger loses nothing" durability model. Per-commit bucketing is a later refinement; nothing is lost, only the commit a decision is filed under.
- **Read-path scaling.** `why`/`recent` scan the whole `refs/notes/cairn` namespace (one git call per noted commit) on each call. Output is always budget-bounded, but the *work* grows with history. Fine for a single developer today; a process-level note cache is the planned fix.
- **Self-compaction holds at one rollup level.** The dream bounds the store by folding old decisions into one rollup per file-cluster — so for a finite codebase the store is bounded (rollup count ≈ number of file-clusters). It does **not** recurse to deeper levels (a deliberate non-goal); if even the rollups exceed the budget, they're kept (provenance is stored, so a deeper level could be added later without migration). After the dream, a compacted commit's coarse Lore *trailer* is still surfaced as a per-commit fallback alongside the rollup. One honest edge: `recall` returns a single atom larger than the budget whole (with `truncated: true`) — it never returns *nothing*.

## Layout

```
src/engine/   ingest · compact · recall · overlap   — pure; zero imports from git/CC/store/SDK
src/store/    journal · notes · trailers · git       — the only git-aware layer
src/capture/  decision · journal · consolidate       — orchestrates engine + store
src/mcp/      server (why, recent) · graph · format   — read-only MCP server
src/complete.ts   the injected complete() (the one Anthropic-SDK adapter)
hooks/, skills/, .mcp.json, .claude-plugin/   the Claude Code plugin
```

See [DESIGN.md](DESIGN.md) for the white space, the differentiator, and why each substrate choice was made.

## License

MIT.
