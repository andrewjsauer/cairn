import { idFrom } from "../engine/index.js";
import {
  appendEntry,
  getActiveDecisionId,
  repoRoot,
  repoRelativePath,
  type JournalEntry,
} from "../store/index.js";

/**
 * Edit-time journaling (Section 7). On every agent file-edit we synchronously
 * append a durable raw entry to .git/cairn/, tagged to the active decision if
 * one is open. No model call here — durability cannot wait on the network, and
 * context teardown must not be able to lose the entry.
 */
export function recordEdit(
  cwd: string,
  args: { toolName: string; filePath: string; reason: string; ts?: string }
): JournalEntry | null {
  const root = repoRoot(cwd);
  if (!root) return null; // not in a git repo; nothing to journal

  const file = repoRelativePath(root, args.filePath);
  // An edit outside the repo (or absolute path that didn't relativize) is not
  // part of this repo's decision graph; don't pollute it with `../` entries.
  if (file.startsWith("..") || file.startsWith("/")) return null;
  const ts = args.ts ?? new Date().toISOString();
  const decisionId = getActiveDecisionId(root);
  // The id must be unique per APPENDED entry, not just per (file, ts, tool):
  // consume-by-id clearing would otherwise filter a colliding new entry as
  // already-consumed. Reason separates same-millisecond edits in one process;
  // pid separates parallel hook processes (each hook is its own process, so a
  // counter would never increment). A true duplicate — same process replaying
  // identical args — still collapses to one id, which is what dedupe wants.
  const entry: JournalEntry = {
    id: `j-${idFrom(file, ts, args.toolName, args.reason, String(process.pid))}`,
    ts,
    decisionId,
    file,
    change: args.toolName,
    reason: args.reason,
  };
  appendEntry(root, entry);
  return entry;
}
