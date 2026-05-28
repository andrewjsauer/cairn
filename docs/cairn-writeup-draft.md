> **DRAFT NOTES — delete this block before publishing.**
> This is a draft in your voice. Before publishing under your name:
> 1. Re-verify every external number against its source. The survey percentages, GitHub star counts, and funding figures came from a research pass and some rest on single sources (the Lore preprint, individual GitHub issues, third-party benchmark estimates). Treat those as directional signals, link them, and only state what you have checked.
> 2. Fill the section marked `[TODO: before/after example]` once you have dogfooded the tool. That concrete moment is the most persuasive part of the whole piece; without it the essay is theory.
> 3. Pick a title (options listed below the working title).
> 4. Add the repository link where marked.
> 5. Decide how much of the "where this goes" section you want public versus held back.

# Code remembers what changed, not why

*Working title. Alternatives: "The Decision Shadow"; "Your coding agent has amnesia, and the context window isn't the cause"; "Git versions your code. Nothing versions your reasoning."*

Every commit stores a diff. None of them store the argument that produced it. The constraint you were working around, the two approaches you rejected and why, the thing you tried Tuesday that broke and never want to try again: all of it lives in your head and in a chat transcript, and both of those are gone by Thursday. Git is a perfect record of *what* changed and a complete amnesiac about *why*.

This was a tolerable problem when the only reader of code was a human who could ask the person at the next desk. It stops being tolerable when most of the code is being written by an agent that has no next desk, no memory across sessions, and a context window that gets wiped every time you type `/clear` or the conversation compacts. The agent re-derives the same reasoning every morning, makes the same mistake it made yesterday, and cheerfully reintroduces the bug you already fixed, because from its perspective none of that ever happened.

I have been building a small tool to close that gap. This is the thinking behind it, the landscape I found when I went looking, and the deliberately narrow bet I decided to make.

## The pain is documented, not hypothetical

If you have used a coding agent on a real codebase you already feel this, but it is worth showing that it is widespread rather than a personal quirk.

Stack Overflow's 2024 developer survey found that a large majority of developers say AI tools lack the internal context they need to understand their own codebase and institutional knowledge, and that knowledge silos cost a meaningful share of developers productivity many times a week. Cortex's 2024 productivity survey put "trouble finding context" at the top of the list of developer pains. On Hacker News, the recurring "how do you find the why behind old code decisions" threads converge on the same grim punchline: you usually do not, because the why was never written down, and when it was, it was the first thing cut under deadline.

The agent-specific version is sharper. The Cursor community forum has a widely-read thread describing the "vicious circle of agent context loss," where the agent finishes five pull requests on Tuesday and wakes up Wednesday not knowing what the app is. The Claude Code issue tracker has reports of agents repeating documented mistakes across sessions with no mechanism to make a correction stick, even when every mistake is catalogued in a memory file the agent loads at startup and then ignores. And Anthropic's own engineering writing is explicit that the context window is a finite "attention budget" with diminishing returns, not a bucket you can keep filling.

That last point matters, because the obvious objection is "won't bigger context windows make this go away." They will not. A ten-million-token window does not help if the right reasoning was never captured, and research keeps showing that what you put in the window and what you leave out matters more than how big the window is. The bottleneck is curation and capture, not capacity.

## What already exists, and what it gets right

When I went looking, I found that I was not early. I was arriving mid-race into a problem a lot of capable people are circling. Pretending otherwise would have led me to build a worse version of something that already exists, so here is the honest map.

**Decision records in git.** The Lore protocol and the Contextual Commits spec both attack exactly the "decision shadow" problem by writing structured reasoning into commit messages: the constraint, the rejected alternatives, the confidence, what was learned. This is the right substrate instinct. It is free, it survives forks and clones, and it puts the reasoning where the code is.

**Reasoning graphs served to agents.** A project called agit builds a graph of reasoning parallel to git's commit graph and serves it to Cursor and Claude Code over the Model Context Protocol. This is the closest thing to what I wanted to build, and its existence was a useful gut-check.

**Lessons capture in the agent loop.** Every's compound-engineering plugin bakes a "compound" step into the workflow that captures what was learned solving a problem so future agents inherit it. It is well-built and well-adopted, and it answers a different question than mine: it documents *solved problems*, the exceptional events worth a writeup.

**The memory layer.** mem0, Letta, Zep, and now native memory features from Anthropic and Cursor all provide persistent, often hierarchical, sometimes self-compacting memory for agents. This is a crowded and well-funded category. It is also, almost without exception, *problem-indexed* or *conversation-indexed*: it remembers what you and the agent talked about, not why a specific line of code looks the way it does.

**The context platforms.** Unblocked, Pieces, Sourcegraph, and Augment build retrieval layers over code plus docs plus tickets plus chat, and several pitch the literal "why is this code the way it is" use case. These are largely managed products and retrieval engines rather than git-native decision graphs.

Architecture Decision Records, the legacy answer, deserve a mention only to explain why they are not enough: they operate at architectural granularity, live as separate files, and go stale because nothing keeps them synchronized with the code they describe.

## The white space

Lay those out on a few axes and the gap becomes obvious. Capture can be automatic or manual. Memory can be code-indexed or problem-indexed. It can be self-compacting under a budget or it can grow until it is useless. And it can be served to agents over a standard protocol or locked in a CLI.

Almost everything occupies two or three of those. Decision-record tools are code-indexed and git-native but have no compaction and mostly no protocol. The memory layer is self-compacting and protocol-served but problem-indexed. The context platforms are automatic and agent-served but are retrieval engines, not decision graphs, and not git-native.

What I could not find shipped as one thing was the full intersection: **automatic capture, indexed to the decision that touched specific code, compacted into a hierarchy that stays under an agent's token budget, stored in git itself, and served over MCP.** The sharpest part of that, the part genuinely underserved, is *code-indexed at decision granularity*. Most memory remembers conversations. Very little remembers why a particular piece of code exists, bound to that code, in a form an agent can query.

## The bet, and the things I refused to build

The tool is called Cairn, after the stacked stones that mark a trail for whoever comes next. The design is built almost entirely on other people's shoulders, with one differentiated layer on top.

It does not invent a capture format. It emits and reads Lore-compatible decision records, so it interoperates with work that already exists rather than competing for the same slot. It stores durable records in git itself, using commit trailers for the human-visible decisions and a git-notes namespace for the compacted graph, so nothing pollutes the working tree or the pull request and everything travels with the repo. It serves the result to coding agents over MCP. The one piece that is mine is the layer in the middle: a self-compacting, code-indexed decision graph, with a small engine that keeps the memory under a budget so a month of work can still be handed to a fresh session.

A few design choices are worth calling out because they were the interesting decisions:

Capture is split from persistence. Reasoning is recorded the instant a file changes, to a durable local journal, so that a `/clear` or a compaction or a crash cannot erase it. Turning that raw journal into clean decision records happens later, at natural inflection points like a commit. Durability never waits for a commit and never depends on catching a teardown event.

Reasoning groups by decision, not by folder. A single decision routinely touches files across the tree, and a single folder routinely holds changes made for unrelated reasons. So the directory structure is a filter for retrieval, never the axis the memory is organized around.

A file has a chain of decisions, not a single explanation. Querying why a file looks the way it does returns the evolution of the thinking about it over time, which is exactly what a newcomer, human or agent, actually needs.

And then the discipline, which mattered as much as the features. I decided not to build a company, not to build a hosted backend, and not to build a general agent-memory platform. That last one was the real temptation, because the self-compacting engine generalizes naturally to "memory for any agent." But that is the most crowded, best-funded part of the entire stack, and walking into it means fighting mem0, Letta, Zep, and the model labs at once. Staying narrow, code-indexed decisions and nothing wider, is what keeps Cairn out of everyone's direct line of fire and pointed at the part that is genuinely open.

## Does it work

[TODO: before/after example. Drop in one concrete, honest moment from dogfooding: a real question like "why does this module retry twice before failing," asked of a fresh session with Cairn attached and the same session without it, and the difference in the answers. This is the most convincing paragraph in the piece. Do not write it until it is true.]

## Where this goes, and where it might not

I am not certain this should be more than a tool I use and an open layer other people can build on. The honest risks are real. Anthropic and Cursor are both shipping native memory features and could absorb the simple version of this. The substrate war between commit trailers and side-stores is being decided right now by projects further along than mine. And the most differentiated piece, the compaction engine, is also the easiest to copy.

What makes me think it is still worth doing is that the narrow slice, reasoning bound to code at decision granularity, served to agents, stored in git, is the part nobody has planted a flag on, and the trajectory of the whole field points straight at it. If it turns out to be a feature the labs build natively, then I will have built the thing they build, in their stack, which is its own kind of useful.

It is open source. [TODO: repository link.] If you work on coding agents or developer memory and any of this is wrong or already solved better somewhere, I would genuinely like to hear it.
