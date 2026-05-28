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
