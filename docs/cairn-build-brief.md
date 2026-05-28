# Cairn — Build Brief (open-source portfolio edition)

> **For the implementing agent (Claude Code).** Every decision here is settled; build against it. This supersedes the earlier Phase 1 brief. Cairn is being built as an open-source portfolio piece, so the bar is taste and clarity, not surface area. The name "Cairn" (trail markers left for the next traveler) is the working name and is renameable by find-and-replace.

---

## 1. What you're building

Cairn is the compaction-and-graph layer that sits on top of commit-native decision records and serves a budget-bounded, code-indexed decision graph back to AI coding agents over the Model Context Protocol (MCP). It captures the reasoning behind code as work happens, stores it in git itself, compacts it so it never outgrows an agent's context budget, and hands a fresh session the answer to "why is this code the way it is."

One line: **a self-compacting, code-indexed decision graph for AI coding agents, built on top of git and existing decision-record formats.**

It is single-player and local in this build. Installed once, it works in every repo.

## 2. Project goals (this is a portfolio piece)

Build toward three goals at once, in priority order:

1. **Useful to the author daily.** It must genuinely make real coding sessions better oriented. If it does not change how a session behaves, nothing else matters.
2. **A credible signal to dev-tools teams** (Anthropic, Cursor, Sourcegraph, Augment, Continue, and similar). The signal is taste: clean code, deep use of git and MCP, thoughtful interop with existing standards rather than not-invented-here, and a clear point of view on where this space is going.
3. **A flag-plant with optionality** if it gains adopters.

Deliverables are therefore not just code:

- The working plugin and MCP server.
- A `README.md` that a stranger can act on in five minutes.
- A short `DESIGN.md` rationale that states the white space, why Cairn stays narrow, and why each substrate choice was made. The thinking is as much the artifact as the code.

## 3. Standing on shoulders (build on these, do not reinvent)

Cairn's whole posture is to compose existing, proven pieces and add one differentiated layer. Explicitly build on:

- **Decision-record formats (Lore, Contextual Commits).** Do not invent a capture format. Emit and read Lore-compatible commit trailers (e.g. Constraint, Rejected, Confidence, Supersedes) and remain compatible with the Contextual Commits action-line style. Cairn is a *layer over* these, not a fifth competing format.
- **Git as the substrate.** Durable records live in git, not a SaaS backend (see Section 5). This is free, survives forks and clones, and is the right taste signal.
- **MCP for delivery.** Use the official MCP TypeScript SDK and follow the reference memory-server patterns. MCP-first is a deliberate differentiator; most decision-record tools are CLI-only.
- **Compound-engineering patterns.** Reuse three battle-tested ideas from Every's compound-engineering plugin: its evidence-source model (Cairn becomes one more source it can pull from), its five-dimension overlap scoring (for deciding when a new decision is really an existing one), and its discoverability check (editing the project instruction file so agents know the store exists).
- **Hierarchical-memory ideas (MemGPT / Letta, mem0, Zep) as inspiration only.** Borrow the concept of tiered, self-compacting memory for the engine. Do not take a dependency on them and do not position Cairn as an agent-memory platform. That category is crowded and well-funded; Cairn deliberately stays narrow (see Section 4).

## 4. The differentiator (state this clearly in DESIGN.md)

Each individual capability already exists somewhere. The unoccupied space is the intersection, and Cairn should occupy exactly that and nothing wider:

- **Automatic** capture at decision-time and edit-time (not a manual writeup step).
- **Code-indexed at decision granularity** (bound to the decision that touched specific code, not to a file, a folder, or a chat session). Most prior art is problem-indexed or repo-indexed; this is Cairn's sharpest claim.
- **Self-compacting hierarchical graph** that stays under a per-agent token budget. Researched widely, not shipped for *code* memory.
- **Served to agents over MCP**, and stored git-natively.

Narrowness is the strategy. Cairn answers "why is this code the way it is, and how did the thinking evolve," and refuses to drift into general agent memory, conversation memory, or a new capture format. Staying narrow is what keeps it out of the memory companies' and the model labs' direct line of fire.

## 5. Settled decisions (do not deliberate these)

| Decision | Choice |
|---|---|
| Name | Cairn. Plugin, CLI, and MCP server all named `cairn`. |
| Substrate | Git-native. Durable consolidated records go into git: Lore-compatible trailers in commit messages (human-visible, interoperable) plus a `refs/notes/cairn` git-notes namespace for the compacted graph and atoms (travels with the repo, updates without rewriting history, no working-tree or pull-request noise). |
| Pre-commit journal | A local, ephemeral durability journal under `.git/cairn/` (inside `.git`, so never committed and never in the working tree, but on disk so it survives `/clear`, crash, and compaction). Consumed at consolidation, then cleared. |
| Capture format | Emit and read Lore-compatible decision records; do not invent a new one. |
| Language / runtime | TypeScript on Node. |
| Model | Haiku 4.5 (`claude-haiku-4-5-20251001`) for capture and consolidation, behind one config constant so it can be swapped. |
| How a decision opens | Hybrid: auto-open on plan-mode entry if a hook exists, plus a manual `/decision "<intent>"` command. The manual command must work standalone. See Section 7 for close and fallback rules. |
| Read surface | Two MCP tools only: `why(file)` and `recent(n)`. |
| Packaging | One user-level plugin bundling the skill, hooks, and MCP server, resolving the active repo at request time. |

## 6. Non-goals (building these is a defect here)

- No new capture format. Interoperate with Lore / Contextual Commits instead.
- No agent-memory platform, no conversation memory, no general knowledge base. Stay code-indexed.
- No hosted backend, database, web viewer, multiplayer, auth, or team layer. Git is the only backend.
- No recursive multi-level compaction tuning beyond what a single budget knob needs; ship level-0 atoms plus one rollup level, with provenance fields present so deeper levels can be added later without migration.
- No `search` or `summary` MCP tools yet.
- No timer or background daemon. All triggers are event-driven.

## 7. Core model (capture and resolution)

Three events. Separate when reasoning happens from when it is saved.

- **Decision time** (plan-mode entry or a manual `/decision`): open an active decision and record its intent and the alternatives weighed. This is where the why is richest, before a diff compresses it away.
- **Edit time** (every agent file-edit): immediately append a durable raw entry to the `.git/cairn/` journal (file, what changed, reason snapshotted cheaply from the transcript), tagged to the active decision if one is open. Synchronous and on disk, so context teardown cannot lose it. No model call here; the reason is synthesized later.
- **Consolidation at inflection points** (commit, impending compaction, session end or start): fold the journal into level-0 decision atoms, write Lore-compatible trailers into the commit at commit time, and update the compacted graph in `refs/notes/cairn`. A commit is one inflection point, not the only one, and not what durability depends on. A missed trigger loses nothing; the journal survives and the next trigger picks it up.

Decision lifecycle and fallback:

- A decision closes when the next one opens or at session end. Edits attach to whichever decision is open.
- Edits made with no open decision are still journaled; at consolidation, unattached entries are clustered into inferred decisions from the diff and surrounding transcript.
- If Claude Code exposes no catchable plan-mode event (see Section 11), the manual `/decision` command plus consolidation-time inference cover it. Auto-open is an enhancement, not a dependency.

Grouping and resolution:

- The unit of meaning is the **decision**, not the commit and not the folder. File-changes cluster into a decision by shared reasoning, wherever the files sit in the tree. Folder and path are a retrieval filter, never the grouping axis.
- A file accumulates a **chain of decisions** over its life. `why(file)` returns that chain, not a single summary. The evolution is itself the context a newcomer needs.

## 8. Architecture

```
plan mode / /decision ─> open decision
agent file edit ───────> durable journal entry (.git/cairn/)        [synchronous, no model call]
commit / pre-compact / session end|start ─> consolidate ─>
        Lore-compatible trailers in commit  +  atoms & graph in refs/notes/cairn
fresh session ─> cairn MCP ─> why(file) | recent(n)
```

Components:

- **Engine** (`src/engine/`): `ingest()`, `compact()` (level-0 to one rollup level), and a budget-aware `recall()`. Model-agnostic and domain-agnostic: no imports from git, Claude Code, the store, or the Anthropic SDK; takes an injected `complete()`. This decoupling is a hard requirement and is itself a portfolio signal.
- **Store** (`src/store/`): reads and writes the `.git/cairn/` journal, the `refs/notes/cairn` namespace, and commit trailers. The only module that knows about git.
- **Capture** (`src/capture/`): decision open/close, edit-time journaling, consolidation, and overlap scoring for dedup.
- **Hooks** (`hooks/`): plan-mode to open decision; edit tool to journal; commit / pre-compaction / session end or start to consolidate.
- **MCP server** (`src/mcp/`): `why(file)` and `recent(n)`, read-only. Resolves the active repo at request time (`git rev-parse --show-toplevel` from the session working directory) and reads that repo's notes and trailers.

## 9. Build sequence

1. Engine skeleton: `ingest()` and a naive `recall()` (gather a file's atoms and recent atoms; no budget logic yet). Pure, decoupled, unit-tested.
2. Store over git: write and read the `.git/cairn/` journal and the `refs/notes/cairn` namespace; emit and parse Lore-compatible trailers.
3. Edit-time journaling hook plus decision open/close (hybrid). Verify by inspection that a journal entry lands on disk before a `/clear` would run.
4. Consolidation at the inflection points, producing level-0 atoms grouped by decision plus one rollup level, with overlap scoring for dedup.
5. MCP server with `why` and `recent`; install as a user-level plugin and point Claude Code at it.
6. Write `README.md` and `DESIGN.md`. Dogfood for several days; capture one before/after example where `why(file)` orients a cold session that a bare session could not handle. That example is the spine of the public writeup.

## 10. Acceptance criteria

- Editing a file writes a durable journal entry immediately, and that entry survives a `/clear`.
- Plan mode or `/decision` opens a decision; subsequent edits attach to it; consolidation writes Lore-compatible trailers and updates `refs/notes/cairn`, grouped by shared reasoning rather than by folder.
- The decision records Cairn writes are readable by a Lore-style consumer (interop is demonstrated, not just claimed).
- `why(file)` returns that file's decision chain over time; `recent(n)` returns the latest decisions, both under a token budget.
- The engine module has zero imports from git, Claude Code, the store, or the Anthropic SDK, only the injected `complete()`.
- A fresh session with the Cairn MCP attached answers a "why is this file the way it is" question that a session without it cannot.
- `README.md` and `DESIGN.md` exist and are good enough that a dev-tools engineer skimming the repo understands the white space, the differentiator, and the substrate choices within a few minutes.

## 11. Verify at build time (facts to look up, not decisions to make)

Confirm against current documentation before wiring; do not assume names or schemas:

- Claude Code lifecycle hooks for plan-mode entry, file edits (the PostToolUse path), commit, context compaction, and session end or start, and whether `/clear` fires a catchable hook, and the input schema each hook receives.
- How a user-level MCP server receives the active workspace path.
- Current `git notes` behavior for the chosen namespace (add, append, fetch, push semantics) and the current Lore / Contextual Commits trailer field names, so interop is real.

The synchronous edit-time journal makes durability safe regardless of which teardown hooks exist; the consolidation hooks only affect how promptly journal entries become durable records.

## 12. Start here

Begin at Section 9, step 1. Before step 3, resolve the Section 11 facts. Proceed without asking the human unless a step is genuinely ambiguous; note assumptions in `README.md`.
