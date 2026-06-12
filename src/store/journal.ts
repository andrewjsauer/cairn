import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { gitDir } from "./git.js";

/**
 * The pre-commit durability journal, under .git/cairn/.
 *
 * Why .git/cairn/ specifically (Section 5): it lives inside .git, so it is never
 * committed and never shows up in the working tree or a diff — but it is real
 * files on disk, so it survives /clear, a crash, and context compaction. The
 * journal is the durability boundary; consolidation is just promotion. A missed
 * consolidation loses nothing because the journal is still here next time.
 *
 * Append-only JSONL for edit entries, plus a small decisions registry so that a
 * journal entry's decisionId can be resolved to its intent/alternatives even
 * after the decision has closed.
 */

export interface JournalEntry {
  id: string;
  ts: string; // ISO
  decisionId: string | null;
  file: string; // repo-relative
  change: string; // tool name / "edited"
  reason: string; // cheap transcript snapshot, no model call
}

export interface DecisionRecord {
  id: string;
  intent: string;
  alternatives: string[];
  openedAt: string;
  closedAt: string | null;
}

interface CairnPaths {
  dir: string;
  journal: string;
  decisions: string;
  active: string;
  lastHead: string;
}

function paths(cwd: string): CairnPaths {
  const dir = join(gitDir(cwd), "cairn");
  return {
    dir,
    journal: join(dir, "journal.jsonl"),
    decisions: join(dir, "decisions.json"),
    active: join(dir, "active-decision"),
    lastHead: join(dir, "last-head"),
  };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---- edit journal ----

export function appendEntry(cwd: string, entry: JournalEntry): void {
  const p = paths(cwd);
  ensureDir(p.dir);
  appendFileSync(p.journal, JSON.stringify(entry) + "\n", "utf8");
}

export function readEntries(cwd: string): JournalEntry[] {
  const p = paths(cwd);
  if (!existsSync(p.journal)) return [];
  const entries: JournalEntry[] = [];
  for (const line of readFileSync(p.journal, "utf8").split("\n")) {
    if (!line) continue;
    // Skip a corrupt line (e.g. a partial write at crash) rather than aborting
    // the whole journal — durability of the surviving entries matters more.
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * Remove exactly the consumed entries from the journal, preserving anything
 * appended while consolidation ran (its model calls take seconds — a parallel
 * hook's entry landing in that window must survive, or "a missed trigger
 * loses nothing" breaks). The journal is re-read fresh at clear time; a line
 * is kept when its id was not consumed, and unparseable lines are kept too —
 * a torn write is not ours to delete. Same-directory temp + rename so a crash
 * mid-clear can never tear the surviving lines; the temp name carries the pid
 * so two concurrent consolidations cannot rename over each other. The
 * sub-millisecond window between re-read and rename is accepted: closing it
 * needs locking, and a hook that can block the session is worse than a rare
 * re-consolidated entry (atom ids are content hashes, so re-consolidation is
 * idempotent anyway).
 */
export function consumeEntries(cwd: string, consumed: Set<string>): void {
  const p = paths(cwd);
  if (!existsSync(p.journal)) return;
  const kept: string[] = [];
  for (const line of readFileSync(p.journal, "utf8").split("\n")) {
    if (!line) continue;
    let id: string | undefined;
    try {
      id = (JSON.parse(line) as JournalEntry).id;
    } catch {
      kept.push(line); // torn write: preserve, never delete
      continue;
    }
    if (!id || !consumed.has(id)) kept.push(line);
  }
  const tmp = `${p.journal}.tmp.${process.pid}`;
  writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  renameSync(tmp, p.journal);
}

// ---- last consolidated HEAD ----

/**
 * The HEAD sha observed at the end of the last successful consolidation.
 * The commit-trigger gate uses it to reject the "fresh timestamp but HEAD
 * never moved" shape (`git commit || true` seconds after a real commit):
 * recency alone is not proof a NEW commit exists.
 */
export function readLastConsolidatedHead(cwd: string): string | null {
  const p = paths(cwd);
  if (!existsSync(p.lastHead)) return null;
  const sha = readFileSync(p.lastHead, "utf8").trim();
  return sha || null;
}

export function writeLastConsolidatedHead(cwd: string, sha: string): void {
  const p = paths(cwd);
  ensureDir(p.dir);
  writeFileSync(p.lastHead, sha, "utf8");
}

// ---- decisions registry + active pointer ----

export function readDecisions(cwd: string): Record<string, DecisionRecord> {
  const p = paths(cwd);
  if (!existsSync(p.decisions)) return {};
  try {
    return JSON.parse(readFileSync(p.decisions, "utf8")) as Record<string, DecisionRecord>;
  } catch {
    return {};
  }
}

function writeDecisions(cwd: string, decisions: Record<string, DecisionRecord>): void {
  const p = paths(cwd);
  ensureDir(p.dir);
  // Temp + rename: a crash mid-write must not corrupt the whole registry
  // (readDecisions would silently degrade every attached entry to {}).
  const tmp = `${p.decisions}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(decisions, null, 2), "utf8");
  renameSync(tmp, p.decisions);
}

export function getActiveDecisionId(cwd: string): string | null {
  const p = paths(cwd);
  if (!existsSync(p.active)) return null;
  const id = readFileSync(p.active, "utf8").trim();
  return id || null;
}

/**
 * Open a decision. Closes whatever decision is currently active first — a
 * decision closes when the next one opens (Section 7). Returns the new record.
 */
export function openDecision(
  cwd: string,
  record: Omit<DecisionRecord, "closedAt">
): DecisionRecord {
  const decisions = readDecisions(cwd);
  const prevId = getActiveDecisionId(cwd);
  if (prevId && decisions[prevId] && !decisions[prevId].closedAt) {
    decisions[prevId].closedAt = record.openedAt;
  }
  const full: DecisionRecord = { ...record, closedAt: null };
  decisions[record.id] = full;
  writeDecisions(cwd, decisions);
  const p = paths(cwd);
  ensureDir(p.dir);
  writeFileSync(p.active, record.id, "utf8");
  return full;
}

export function getDecision(cwd: string, id: string): DecisionRecord | null {
  return readDecisions(cwd)[id] ?? null;
}
