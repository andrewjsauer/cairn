---
name: decision
description: Open a Cairn decision so subsequent file edits attach to it. Use right before making a deliberate implementation choice worth recording — when there is a real intent, a constraint being worked around, or alternatives being weighed.
disable-model-invocation: true
argument-hint: "<intent>"
---

```!
node "${CLAUDE_SKILL_DIR}/../../dist/cli.js" open-decision-stdin <<'CAIRN_INTENT_EOF'
$ARGUMENTS
CAIRN_INTENT_EOF
```

A Cairn decision is now open. Until the next decision opens (or the session ends), the files you edit are journaled under this decision in `.git/cairn/`. On your next commit, Cairn folds that journal into a Lore-compatible decision record on the commit message and into the `refs/notes/cairn` graph, so a future session can ask `why(<file>)` and get this reasoning back.

To make the captured record richer, state in your next message — if they apply — the **constraint** you are working around and any **alternative** you considered and rejected, with the reason. That text is snapshotted from the transcript at edit time and refined into the record at consolidation.
