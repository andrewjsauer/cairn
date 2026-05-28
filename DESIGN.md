# Cairn — Design rationale

This document is the part of the work that is as much the artifact as the code: what gap Cairn occupies, why it stays narrow, and why each substrate choice was made. If you only read one file to judge the project, read this one.

## The white space

Lay the prior art on four axes and the gap is visible:

- **Capture**: automatic (at decision/edit time) vs. manual (a writeup step).
- **Index**: code-indexed (bound to the code that changed) vs. problem- or conversation-indexed.
- **Size discipline**: self-compacting under a budget vs. grows until useless.
- **Delivery**: served to agents over a standard protocol (MCP) vs. locked in a CLI.

Almost everything strong occupies two or three of these:

- **Decision-record formats** (Lore, Contextual Commits) are code-indexed and git-native, but have no compaction and mostly no protocol.
- **The memory layer** (mem0, Letta, Zep, and native model-lab memory) is self-compacting and protocol-served, but problem- or conversation-indexed — it remembers what you *talked about*, not why a line of code looks the way it does.
- **The context platforms** (Sourcegraph, Augment, Unblocked, Pieces) are automatic and agent-served, but are retrieval engines over many sources, not git-native decision graphs.

The unoccupied intersection is **all four at once**: automatic capture, indexed to the *decision* that touched specific code, compacted into a hierarchy that stays under an agent's token budget, stored in git itself, and served over MCP. The sharpest, most underserved part of that is **code-indexed at decision granularity**. That is the flag Cairn plants, and nothing wider.

## The differentiator, stated plainly

Cairn answers exactly one question — *"why is this code the way it is, and how did the thinking evolve?"* — and refuses to drift into general agent memory, conversation memory, or a competing capture format. Each individual capability already exists somewhere; Cairn is the composition plus one differentiated layer (the self-compacting, code-indexed graph in the middle).

**Narrowness is the strategy, not a limitation.** The self-compacting engine generalizes naturally to "memory for any agent" — which is precisely the most crowded, best-funded part of the stack (mem0, Letta, Zep, and the labs). Walking in there means fighting all of them at once. Staying code-indexed and decision-scoped keeps Cairn out of everyone's direct line of fire and pointed at the part that is genuinely open. If a lab ships the simple version natively, Cairn will have been the thing they shipped, in their stack — which is its own kind of useful.

## Substrate choices

### Git is the only backend

Durable records live in git, never a SaaS backend. It is free, it survives forks and clones, it travels with the repo, and it is the right taste signal for this audience. Two surfaces, each chosen for a reason:

- **Lore-compatible commit trailers** for the human-visible decision record. Trailers are interoperable (`git interpret-trailers --parse` and any Lore consumer read them), they sit where the code is, and they make the reasoning legible to a human reading `git log`.
- **A `refs/notes/cairn` git-notes namespace** for the compacted graph and the decision atoms. Notes update *without rewriting history*, produce *no working-tree or pull-request noise*, and travel with the repo. They are keyed by commit SHA, so a commit's note explains that commit's decisions.

### Don't invent a format

Cairn emits and reads a subset of the **Lore** trailer block (`Lore-id`, `Constraint`, `Rejected: alt | reason`, `Confidence: low|medium|high`, `Supersedes`), verified field-by-field against the canonical Lore repo. Unknown Lore keys (`Scope-risk`, `Directive`, `Tested`, …) are ignored on read, so the format is forward-compatible and a record written by another Lore tool still parses. Interop is demonstrated, not claimed: the test suite feeds a foreign Lore block through Cairn's parser and feeds Cairn's output through git's own `interpret-trailers`.

### The pre-commit journal lives inside `.git`

The edit-time journal is under `.git/cairn/`. That location is deliberate: inside `.git`, so it is **never committed and never in the working tree or a diff** — but it is real files on disk, so it **survives `/clear`, a crash, and context compaction**. The journal is the durability boundary; consolidation is just promotion. This is what lets durability be independent of which teardown hooks exist.

### MCP for delivery

Most decision-record tools are CLI-only. Serving over MCP is the deliberate differentiator: a fresh agent in any client can call `why(file)` and get oriented. Two read tools, no more — `why` and `recent` — kept read-only and budget-bounded.

## The decisions that were interesting

### Capture is split from persistence

Reasoning is recorded the instant a file changes, synchronously, to the on-disk journal — no model call, because durability cannot wait on the network. Synthesizing that raw journal into clean Lore records happens later, at a natural inflection point (a commit). Durability never depends on catching a teardown event, and a missed consolidation loses nothing.

### Reasoning groups by decision, never by folder

A single decision routinely touches files across the tree; a single folder routinely holds changes made for unrelated reasons. So the **decision** is the unit of meaning, and the directory structure is only a retrieval filter. Attached edits group by their open decision; unattached edits are clustered into *inferred* decisions by the model from the changes and reasons — never by path.

### A file has a chain of decisions, not one explanation

`why(file)` returns the evolution of the thinking about a file over time, oldest to newest, with `supersedes` links between versions. That arc — what was tried, what was rejected, what constraint forced the current shape — is exactly the context a newcomer (human or agent) needs and a diff destroys.

## The hard architectural rule: a decoupled engine

Everything under `src/engine/` has **zero imports from git, Claude Code, the store, or the Anthropic SDK**. It takes a single injected capability — a `complete(prompt) => Promise<string>` function — and nothing else. `ingest`, `compact`, `recall`, and the five-dimension overlap scorer are pure domain logic over plain data.

This is enforced, not just asserted: `tests/decoupling.test.ts` scans every engine source file and fails the build if a forbidden import ever appears. The payoff is concrete:

- The engine is tested with a fake `complete()` — no model, no git, no network.
- The model is swappable behind one constant; the provider behind one adapter (`src/complete.ts`).
- The "memory" idea (tiered, self-compacting recall, borrowed in spirit from MemGPT/Letta) is isolated from the substrate, so the substrate can change without touching it.

A clean dependency boundary is the load-bearing portfolio signal here: it is the difference between "a script that calls an LLM and shells out to git" and "a memory engine with a substrate adapter."

### Compaction: one rollup level, provenance for more

Per the non-goals, Cairn ships **level-0 atoms plus one rollup level** — no recursive multi-level tuning. `compact()` keeps the newest atoms verbatim and folds the overflow into level-1 rollups grouped by shared files, recording each rollup's `sourceIds`. Those provenance fields mean a deeper level could be added later **without migrating stored data**. The per-agent budget that actually matters for "never outgrows the context window" is enforced at read time by `recall()`.

## What this is not (the non-goals are binding)

No new capture format. No agent-memory platform, conversation memory, or general knowledge base. No hosted backend, database, web viewer, multiplayer, auth, or team layer — git is the only backend. No `search` or `summary` tools yet. No timer or background daemon — every trigger is event-driven. Building any of these would be a defect against the brief, and against the strategy: the discipline of *not* building them is what keeps the bet narrow and credible.

## Facts verified before building (not assumed)

The hook/MCP/Lore/git-notes details were resolved against current documentation before any wiring was written, because guessing names or schemas would have made the interop fake:

- **Claude Code hooks**: there is no native commit or plan-mode-entry event. A commit is detected via `PostToolUse` on `Bash` matching `git commit`; a decision is auto-opened via `PostToolUse` on the `ExitPlanMode` tool (the plan is approved → work begins), reading `tool_input.plan`. The `PostToolUse` payload carries `tool_name` / `tool_input.file_path` but **no reason** (hence the transcript-tail snapshot). Pre-compaction / session end / session start use the `PreCompact`, `SessionEnd`, and `SessionStart` events for notes-only flushes. `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` are substituted into hook commands and exported to the process.
- **MCP workspace path**: Claude Code sets `CLAUDE_PROJECT_DIR` in the spawned stdio server's environment; `roots/list` is the documented fallback. Plugin MCP configs substitute `${CLAUDE_PROJECT_DIR}` directly.
- **Lore trailers**: exact keys/casing/cardinality and the pipe-separated `Rejected` value, from the canonical Lore repo.
- **Git notes**: `--ref=cairn` → `refs/notes/cairn`; keyed by object SHA; not fetched/pushed by default.

## Honest risks

The labs and editors are shipping native memory and could absorb the simple version of this. The substrate question (commit trailers vs. side-stores) is being decided right now by projects further along. And the compaction engine — the most differentiated piece — is also the easiest to copy. What keeps it worth doing is that the narrow slice (reasoning bound to code at decision granularity, served to agents, stored in git) is the part nobody has planted a flag on, and the trajectory of the field points straight at it.
