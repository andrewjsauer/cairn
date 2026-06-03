import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

/**
 * Thin git wrapper. The store is the ONLY module that shells out to git.
 * Everything is synchronous on purpose: the edit-time journal must land on disk
 * before any teardown (a /clear, a crash, a compaction) can race it.
 */

export interface GitOpts {
  cwd: string;
  /** Passed to stdin (used for amend / notes from "-"). */
  input?: string;
  /** If true, return "" instead of throwing on non-zero exit. */
  allowFail?: boolean;
}

/**
 * Hard ceiling on any single git invocation. Cairn runs git synchronously
 * inside the commit hook; a hung git (e.g. a stale .git/index.lock or a
 * credential helper waiting on input) must not block the session forever.
 */
const GIT_TIMEOUT_MS = 20_000;

export function git(args: string[], opts: GitOpts): string {
  try {
    return execFileSync("git", args, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", opts.allowFail ? "pipe" : "inherit"],
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    throw err;
  }
}

/** Absolute path to the repository root, or null if cwd is not in a git repo. */
export function repoRoot(cwd: string): string | null {
  const root = git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  return root || null;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Repo-relative, symlink-safe path. git's --show-toplevel returns a canonical
 * (realpath) root, so a file path under a symlinked dir (e.g. /tmp -> /private/tmp
 * on macOS) must be canonicalized too or `relative()` produces a `../../..` mess.
 */
export function repoRelativePath(root: string, filePath: string): string {
  const realRoot = safeReal(root);
  const abs = isAbsolute(filePath) ? filePath : resolve(realRoot, filePath);
  const rel = relative(realRoot, safeReal(abs));
  return rel || filePath;
}

/** Absolute path to the .git directory (handles worktrees and submodules). */
export function gitDir(cwd: string): string {
  const dir = git(["rev-parse", "--git-dir"], { cwd });
  return resolve(cwd, dir);
}

export function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], { cwd });
}

/**
 * The git "empty tree" object, written into the object DB so a note can attach
 * to it. Cairn uses it as a stable anchor for the compacted rollup ledger — it
 * always exists, is never a real commit, and so never collides with a
 * per-commit note. Universal SHA-1 value: 4b825dc6…
 */
export function graphAnchor(cwd: string): string {
  return git(["hash-object", "-w", "-t", "tree", "--stdin"], { cwd, input: "" });
}

/** True if the given commit is already present on any remote-tracking branch. */
export function isOnRemote(sha: string, cwd: string): boolean {
  const out = git(["branch", "-r", "--contains", sha], { cwd, allowFail: true });
  return out.length > 0;
}

/**
 * True if the commit carries a GPG/SSH signature. We never amend a signed
 * commit: re-signing (or silently dropping the signature) without consent is
 * not ours to do. The git-note still records the reasoning.
 * %G? is "G" (good), "U" (good, untrusted), etc. for signed; "N" for unsigned.
 */
export function isSignedCommit(sha: string, cwd: string): boolean {
  const status = git(["show", "-s", "--format=%G?", sha], { cwd, allowFail: true });
  return status !== "" && status !== "N";
}

/** Full commit message body for a commit. */
export function commitMessage(sha: string, cwd: string): string {
  return git(["show", "-s", "--format=%B", sha], { cwd, allowFail: true });
}

/** ISO author date for a commit. */
export function commitDate(sha: string, cwd: string): string {
  return git(["show", "-s", "--format=%aI", sha], { cwd, allowFail: true });
}

/**
 * The set of repo-relative paths tracked at HEAD. One git call; staleness is
 * then pure set membership (an atom is stale when none of its files are here).
 * Returns an empty set for an empty repo / no HEAD — callers must treat "no
 * HEAD" as "nothing live", not "everything stale" (the engine's isStale already
 * leaves files-less atoms alone, but a real atom in a HEAD-less repo will read
 * stale; that only happens before the first commit, which has no notes anyway).
 */
export function filesAtHead(cwd: string): Set<string> {
  // -z gives NUL-separated, verbatim paths — this disables core.quotepath's
  // C-quoting of non-ASCII names, so the output matches the raw UTF-8 form that
  // repoRelativePath stores in atom.files (otherwise "café.ts" would never match
  // git's "caf\303\251.ts" and live files would read as stale).
  const out = git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], { cwd, allowFail: true });
  return new Set(out ? out.split("\0").filter(Boolean) : []);
}

/**
 * Every rename in history as an old-path -> new-path map, newest rename winning
 * per old path. One git call (`log --diff-filter=R --name-status`); -z gives
 * verbatim NUL-separated `R<score> old new` triples (no core.quotepath quoting),
 * -M forces rename detection even if the user disabled diff.renames. Used to
 * rescue renamed-but-live files from a false structural-staleness flag and to
 * match a renamed file's chain by its canonical current name.
 *
 * An old path that is itself LIVE at HEAD is dropped from the map: a live path
 * was recreated (or never really left), so it is its own canonical name.
 * Resolving through it would leak the recreated file's chain into the rename
 * target. The cost of this conservatism: once a renamed-away path is reused,
 * reasoning recorded under it stays attributed to the path name, not to where
 * the original content moved — path identity is genuinely ambiguous at that
 * point, and we prefer no association over a contested one. (Same reasoning for
 * the newest-rename-wins rule: resolving which rename was "active" when an atom
 * was recorded would need per-rename dates for a pathological history shape.)
 */
export function renamesInHistory(cwd: string): Map<string, string> {
  const out = git(["log", "-M", "--diff-filter=R", "--name-status", "-z", "--format="], {
    cwd,
    allowFail: true,
  });
  const renames = new Map<string, string>();
  const tokens = out ? out.split("\0").filter(Boolean) : [];
  for (let i = 0; i + 2 < tokens.length; ) {
    if (!/^R\d+$/.test(tokens[i])) {
      i++;
      continue;
    }
    const [oldPath, newPath] = [tokens[i + 1], tokens[i + 2]];
    // Output is newest-first; keep the newest rename for each old path.
    if (!renames.has(oldPath)) renames.set(oldPath, newPath);
    i += 3;
  }
  if (renames.size > 0) {
    const live = filesAtHead(cwd);
    for (const oldPath of [...renames.keys()]) {
      if (live.has(oldPath)) renames.delete(oldPath);
    }
  }
  return renames;
}

/** Commits (newest first) that touched a file, following renames. */
export function commitsTouchingFile(file: string, cwd: string): string[] {
  const out = git(["log", "--follow", "--format=%H", "--", file], {
    cwd,
    allowFail: true,
  });
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Subject line (first line) of a commit message. */
export function commitSubject(sha: string, cwd: string): string {
  return git(["show", "-s", "--format=%s", sha], { cwd, allowFail: true });
}

/** Repo-relative paths changed by a commit. */
export function filesChanged(sha: string, cwd: string): string[] {
  const out = git(["show", "--name-only", "--format=", sha], { cwd, allowFail: true });
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
