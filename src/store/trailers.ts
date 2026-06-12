import type { Confidence, Rejected } from "../engine/types.js";
import { git, commitMessage, isOnRemote, isSignedCommit } from "./git.js";

/** The trailer keys Cairn owns. Used to strip/replace our own block on re-amend. */
const CAIRN_KEYS = new Set(["Lore-id", "Constraint", "Rejected", "Confidence", "Supersedes"]);
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/;

/**
 * Lore-compatible commit trailers (verified against github.com/Ian-stetsenko/lore-protocol).
 *
 * Cairn does NOT invent a format (Section 6). It emits and reads a subset of the
 * Lore trailer block, so any Lore-style consumer can read what Cairn writes:
 *
 *   Lore-id: <8-char hex>         (exactly 1)
 *   Constraint: <free text>       (0..n)
 *   Rejected: <alternative | reason>   (0..n, pipe-separated)
 *   Confidence: low|medium|high   (0..1)
 *   Supersedes: <lore-id>         (0..n)
 *
 * Trailers are a block of "Key: value" lines at the end of the message,
 * separated from the body by a blank line — exactly what `git interpret-trailers`
 * parses. Unknown keys are ignored by Lore, so this subset is forward-compatible.
 */

export interface LoreRecord {
  loreId: string;
  constraints: string[];
  rejected: Rejected[];
  confidence: Confidence;
  supersedes: string[];
}

/** Trailer values must be single logical lines; collapse whitespace/newlines. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Render a Lore trailer block (no leading blank line; caller positions it). */
export function emitTrailers(record: LoreRecord): string {
  const lines: string[] = [`Lore-id: ${record.loreId}`];
  for (const c of record.constraints) lines.push(`Constraint: ${oneLine(c)}`);
  for (const r of record.rejected) {
    const reason = oneLine(r.reason);
    lines.push(`Rejected: ${oneLine(r.alternative)}${reason ? ` | ${reason}` : ""}`);
  }
  lines.push(`Confidence: ${record.confidence}`);
  // Supersedes is the one value emitted without oneLine(). Its only legitimate
  // shape is an 8-char content-hash id; anything else can only come from a
  // crafted/foreign note, and a newline there could forge a trailer line — so
  // drop anything that doesn't match instead of emitting it.
  for (const s of record.supersedes) {
    if (/^[0-9a-f]{8}$/.test(s)) lines.push(`Supersedes: ${s}`);
  }
  return lines.join("\n");
}

/**
 * Locate the trailing trailer block (the final contiguous run of "Key: value"
 * lines plus their RFC-822 folded continuations) and return [start, end) line
 * indices, or null if there is no trailer block.
 */
function trailerBlockBounds(lines: string[]): [number, number] | null {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  let start = end;
  // A line belongs to the block if it is a trailer line or a folded
  // continuation (leading whitespace) of one.
  while (start > 0 && (TRAILER_RE.test(lines[start - 1]) || /^\s+\S/.test(lines[start - 1]))) {
    start--;
  }
  return start === end ? null : [start, end];
}

/** Fold the trailer block into [key, value] pairs, joining continuation lines. */
function foldTrailers(blockLines: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const line of blockLines) {
    const m = line.match(TRAILER_RE);
    if (m) {
      pairs.push([m[1], m[2].trim()]);
    } else if (/^\s+\S/.test(line) && pairs.length) {
      pairs[pairs.length - 1][1] = `${pairs[pairs.length - 1][1]} ${line.trim()}`.trim();
    }
  }
  return pairs;
}

/**
 * Split a `Rejected:` value into alternative + reason. We emit a spaced ` | `
 * separator, so prefer that (which lets an alternative contain a bare `|`); fall
 * back to the first bare `|` for foreign tools that emit `alt|reason`.
 */
function splitRejected(value: string): Rejected {
  const spaced = value.indexOf(" | ");
  if (spaced !== -1) {
    return { alternative: value.slice(0, spaced).trim(), reason: value.slice(spaced + 3).trim() };
  }
  const bare = value.indexOf("|");
  if (bare !== -1) {
    return { alternative: value.slice(0, bare).trim(), reason: value.slice(bare + 1).trim() };
  }
  return { alternative: value.trim(), reason: "" };
}

/** Parse the trailing trailer block of a commit message into a partial record. */
export function parseTrailers(message: string): LoreRecord | null {
  const lines = message.replace(/\r/g, "").split("\n");
  const bounds = trailerBlockBounds(lines);
  if (!bounds) return null;

  const record: LoreRecord = {
    loreId: "",
    constraints: [],
    rejected: [],
    confidence: "medium",
    supersedes: [],
  };
  let sawLore = false;
  for (const [key, value] of foldTrailers(lines.slice(bounds[0], bounds[1]))) {
    switch (key) {
      case "Lore-id":
        record.loreId = value;
        sawLore = true;
        break;
      case "Constraint":
        record.constraints.push(value);
        break;
      case "Rejected":
        record.rejected.push(splitRejected(value));
        break;
      case "Confidence":
        if (value === "low" || value === "high" || value === "medium") {
          record.confidence = value;
        }
        break;
      case "Supersedes":
        record.supersedes.push(value);
        break;
      // Unknown Lore keys (Scope-risk, Directive, Tested, ...) ignored on read.
    }
  }
  // Only treat as a Lore record if it actually carried a Lore-id.
  return sawLore ? record : null;
}

/**
 * Remove Cairn's own trailers from the trailing block so a re-amend REPLACES
 * rather than appends them (guaranteeing exactly one Lore-id). Foreign trailers
 * in the same block (Signed-off-by, Co-authored-by, …) are preserved verbatim,
 * including their RFC-822 folded continuation lines.
 */
export function stripCairnTrailers(message: string): string {
  const lines = message.replace(/\r/g, "").split("\n");
  const bounds = trailerBlockBounds(lines);
  if (!bounds) return message;
  const [start, end] = bounds;
  const block = lines.slice(start, end);
  if (!block.some((l) => /^Lore-id:/.test(l))) return message; // nothing of ours

  // Track which trailer the current line belongs to: a folded continuation
  // (non-trailer line) is dropped only when it continues a Cairn trailer;
  // foreign trailers keep their first line AND their continuations verbatim.
  let inCairnTrailer = false;
  const kept = block.filter((l) => {
    const m = l.match(TRAILER_RE);
    if (m) inCairnTrailer = CAIRN_KEYS.has(m[1]);
    return !inCairnTrailer;
  });
  const rebuilt = [...lines.slice(0, start), ...kept].join("\n").replace(/\s+$/, "");
  return rebuilt;
}

/** Read and parse the Lore trailers from a specific commit. */
export function readCommitTrailers(sha: string, cwd: string): LoreRecord | null {
  return parseTrailers(commitMessage(sha, cwd));
}

/**
 * Write a Lore trailer block onto a commit's message via amend.
 *
 * Amending is the only way to put trailers into the commit that was just made
 * (there is no native git-commit hook in Claude Code — Section 11). It rewrites
 * the commit, so we GUARD it and skip the amend (relying on the git-note alone,
 * which never rewrites history) when amending would be wrong:
 *   - the commit is already on a remote-tracking branch, or
 *   - the commit is GPG/SSH-signed (re-signing without consent is not ours to do).
 *
 * When we do amend, we REPLACE any existing Cairn trailer block rather than
 * appending, so a re-consolidation never produces a second Lore-id. Returns the
 * new HEAD sha (changed iff we amended).
 */
export function appendTrailersToCommit(
  sha: string,
  block: string,
  cwd: string
): { amended: boolean; reason?: string; sha: string } {
  if (isOnRemote(sha, cwd)) {
    return { amended: false, reason: "on-remote", sha };
  }
  if (isSignedCommit(sha, cwd)) {
    return { amended: false, reason: "signed", sha };
  }
  const existing = commitMessage(sha, cwd);
  // If this commit already carries exactly our Lore-id, there's nothing to do.
  const already = parseTrailers(existing);
  const newId = block.match(/Lore-id:\s*(\S+)/)?.[1];
  if (already && newId && already.loreId === newId) {
    return { amended: false, reason: "already-current", sha };
  }
  // Replace (not append) any prior Cairn block -> exactly one Lore-id per commit.
  const body = stripCairnTrailers(existing).replace(/\s+$/, "");
  const message = `${body}\n\n${block}\n`;
  // --only with no pathspec amends the MESSAGE against HEAD's tree, never the
  // index — staged-but-uncommitted work must not be folded into the rewrite.
  // --no-verify: the tree already passed the user's hooks when the commit was
  // made; re-running them against a message-only amend can only break it.
  // --allow-empty: a message-only rewrite of an empty commit stays empty —
  // without it git rejects the amend ("No changes") and consolidation fails.
  git(
    ["commit", "--amend", "--only", "--allow-empty", "--no-edit", "--no-verify", "-F", "-"],
    { cwd, input: message }
  );
  return { amended: true, sha: git(["rev-parse", "HEAD"], { cwd }) };
}
