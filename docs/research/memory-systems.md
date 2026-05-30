# Memory / store-compaction research

Background for Cairn's "dream" (global store compaction). The question: how do current agent-memory systems keep an unbounded, growing memory under control — and should Cairn depend on any of them? Conducted 2026-05; treat external numbers as directional and re-check against sources before quoting publicly.

## The dependency call: depend on none of them

| System | Consolidation strategy | Trigger | Deployment footprint |
|---|---|---|---|
| **mem0** | LLM extracts facts, then per-fact ADD/UPDATE/DELETE/NOOP vs. similar memories (LLM-driven dedup) | every write (inline) | OSS lib **but requires a vector DB** (Qdrant/pgvector/Neo4j); self-host = 3-container Docker stack |
| **Letta / MemGPT** | OS-style main-context ↔ archival paging; agent decides when to page | agent-initiated; **sleep-time** background agent refines during idle | a **runtime/server** (port 8283), not a library |
| **Zep** | Temporal knowledge graph, **non-lossy** (never deletes); map-reduce community summaries | inline graph writes | cloud-first, **requires a graph DB**; Community Edition deprecated 2025 |

None is embeddable in a git-native, single-process, no-backend context, and all pull toward being a memory *platform* — exactly the crowded space the brief says to avoid. **Recommendation (taken): implement natively, depend on nothing.** The effective techniques are small and portable.

## Techniques Cairn borrows natively

- **Keep recent verbatim, summarize the tail** (Focus Agent, arXiv:2601.07190; 18–57% savings) → `compactGraph` keeps newest level-0, rolls the tail.
- **Cluster by a stable entity, then summarize each cluster** (mem0 dedup; Zep community summaries) → Cairn clusters by shared **file** (a stable code entity), so rollups are anchored to code, not free-floating themes — which avoids lossy-compression-of-lossy-compression drift.
- **Trigger at a size threshold and at idle teardown, not inline** (Letta *sleep-time compute*, arXiv:2504.13171; ~5× test-time-compute reduction, ~2.5× cost cut by amortizing) → the dream runs on `SessionEnd`/`SessionStart`/`PreCompact` or `cairn dream`, never per write, never on a daemon.
- **Provenance over re-compression** (avoids the "compaction loop makes things worse" failure mode) → rollup `sourceIds` always point at original atom ids; re-summarization stays at one level.

Structurally Cairn's store is a **log-structured merge tree**: per-commit notes = L0, the rollup ledger (on git's empty-tree anchor) = L1, compaction is size-triggered. It deliberately stops at one rollup level — for a finite codebase the store is bounded because rollup count ≈ number of file-clusters.

## Not adopted (deliberately)

- **Recency × importance eviction / Ebbinghaus decay** (Generative Agents; MemoryBank) — viable later, but adds tuning knobs the brief's "single budget knob" rules out for now.
- **RL-trained compaction policy** (AgeMem) — best-in-class in the 2026 survey, but far beyond scope and needs training infrastructure.
- **Embedding/vector clustering** (K-means KV compression) — would add an embedding dependency; file-overlap clustering needs none.

## Sources

- mem0 — arXiv:2504.19413 · self-host docs (docs.mem0.ai)
- Letta sleep-time compute — arXiv:2504.13171 · letta.com/blog/sleep-time-compute
- Zep — arXiv:2501.13956
- SleepGate (conflict-aware consolidation) — arXiv:2603.14517
- Focus Agent (active context compression) — arXiv:2601.07190
- Generative Agents (recency × importance × relevance) — Park et al. 2023
- Survey of memory-augmented agents — arXiv:2603.07670
- Dependency-footprint comparison — vectorize.io "Best AI Agent Memory Systems 2026"
