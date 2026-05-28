# Dogfooding Cairn

A turnkey path from a fresh clone to watching Cairn work in a real Claude Code session. Two stages: **(A)** verify every trigger offline in seconds, then **(B)** wire it into a live session.

---

## A. Verify offline first (no Claude Code, ~10s)

```bash
npm install          # also builds (prepare → tsc)
npm test             # 28 tests
npm run dogfood      # fires EVERY trigger against a throwaway repo, narrated
```

`npm run dogfood` walks through, in order: plan approved → decision opens, file edit → journal entry, commit → Lore trailers + note, manual `/cairn:decision`, in-flight edit → pre-compact/session flush (notes-only), then reads it all back over the **real MCP server**. It builds its own temp repo and never touches your real ones.

Set `ANTHROPIC_API_KEY` first if you want to see real Haiku synthesis instead of the deterministic fallback:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # see .env.example
npm run dogfood
```

If that looks right, move to the live session.

---

## B. Wire it into a live Claude Code session

### 1. Build and set the key

```bash
npm run build
export ANTHROPIC_API_KEY=sk-ant-...   # consolidation calls Haiku; the read path doesn't
```

### 2. Install as a user-level plugin

Point Claude Code at this directory as a plugin (via `/plugin` or your marketplace config). On enable you should see, in `/plugin`:

- hooks: `PostToolUse` (Edit/Write/MultiEdit, ExitPlanMode, Bash), `PreCompact`, `SessionEnd`, `SessionStart`
- an MCP server named **cairn** (check with `/mcp` — it should list `why` and `recent`)
- a command **`/cairn:decision`**

### 3. First session — exercise each trigger

Run `claude` inside a **real git repo** you're working in, then:

| Do this | Trigger | Verify |
|---|---|---|
| `/cairn:decision "switch retries to exponential backoff"` | manual open | prints `Cairn: opened decision …` |
| Ask Claude to plan something, then **approve the plan** | `ExitPlanMode` auto-open | a decision opens from the plan |
| Let Claude edit a file | edit journaling | `cat $(git rev-parse --git-dir)/cairn/journal.jsonl` shows an entry |
| Commit (`git commit -m …`) | commit consolidation | `git log -1 --format=%B \| cat` shows a `Lore-id:` block; `git notes --ref=cairn show HEAD` shows JSON |

Then **start a new session** in the same repo and ask Claude:

> "Why is `<that file>` the way it is?"

Claude should call `why(<file>)` and answer with the recorded intent, constraints, and rejected alternatives — the thing a bare session can't do. That answer (vs. the same question without Cairn) is the before/after worth capturing for the writeup.

### 4. Confirm the cross-session / teardown triggers

- Type `/clear`, then ask `why(<file>)` again — the answer survives (it's in git, not context).
- Make an edit, **don't commit**, then end the session and start a new one. The in-flight reasoning is queryable via `recent()` (the `SessionEnd`/`SessionStart` flush promoted the journal to the notes graph).

---

## What to look at under the hood

```bash
git log --format=%B -1 | cat                 # Lore trailers on the latest commit
git interpret-trailers --parse < <(git show -s --format=%B HEAD)   # git's own parser reads them
git notes --ref=cairn list                   # the decision graph (one note per consolidated commit)
git notes --ref=cairn show HEAD              # atoms for the latest commit
cat "$(git rev-parse --git-dir)/cairn/journal.jsonl"   # pending (un-consolidated) edits, if any
```

Cairn's git notes are **local by default**. To share them, add a fetch refspec (safe, additive) and push notes explicitly:

```bash
git config --add remote.origin.fetch '+refs/notes/cairn:refs/notes/cairn'   # fetch pulls notes
git push origin refs/notes/cairn                                            # push notes
```

Don't set `remote.origin.push` to only the notes refspec — plain `git push` would then stop pushing your branches.

---

## Troubleshooting

- **`/cairn:decision` prints nothing / no decision opens.** The skill passes the intent through a quoted heredoc to `open-decision-stdin`. Confirm `dist/` is built and that `${CLAUDE_SKILL_DIR}` resolves — run `node dist/cli.js open-decision-stdin <<<'test'` from the repo and check `decisions.json` appears under `.git/cairn/`.
- **Hooks don't fire.** They run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" …`; if `dist/` is missing, every hook no-ops silently. Run `npm run build`. (Durability still holds once edits *are* journaled — a missed hook loses nothing.)
- **Commit has no `Lore-id` trailers.** Expected when the commit is already pushed to a remote, or is **GPG/SSH-signed** — Cairn won't rewrite those; the reasoning is in the git-note instead (`git notes --ref=cairn show HEAD`).
- **Records are terse / no constraints extracted.** `ANTHROPIC_API_KEY` isn't set, so capture used the deterministic fallback. Set the key and the next consolidation will synthesize properly.
- **`why` says "not inside a git repository."** The MCP server resolves the repo from `CLAUDE_PROJECT_DIR`; make sure you launched Claude Code inside the git repo.
