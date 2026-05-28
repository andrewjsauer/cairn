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
  const entry: JournalEntry = {
    id: `j-${idFrom(file, ts, args.toolName)}`,
    ts,
    decisionId,
    file,
    change: args.toolName,
    reason: args.reason,
  };
  appendEntry(root, entry);
  return entry;
}
