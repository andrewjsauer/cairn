import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Complete } from "../../src/engine/index.js";

/**
 * Shared test-repo helpers. Every git call isolates the developer's global and
 * system config (GIT_CONFIG_GLOBAL/SYSTEM -> /dev/null) so a machine-level
 * commit.gpgsign=true (or similar) can't hang a test waiting on a key or sign
 * commits the tests expect to be unsigned.
 */
export function gitC(repo: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    input,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

export function makeRepo(opts?: { prefix?: string; rootCommit?: boolean }): string {
  const repo = mkdtempSync(join(tmpdir(), opts?.prefix ?? "cairn-test-"));
  gitC(repo, ["init", "-q"]);
  gitC(repo, ["config", "user.email", "t@cairn.dev"]);
  gitC(repo, ["config", "user.name", "T"]);
  if (opts?.rootCommit !== false) {
    gitC(repo, ["commit", "-q", "--allow-empty", "-m", "root"]);
  }
  return repo;
}

/** Constant-output fake model: every decision synthesizes to the same record. */
export const fake: Complete = async (prompt) => {
  if (prompt.includes("Cluster them")) return JSON.stringify({ clusters: [] });
  if (prompt.startsWith("Summarize these related decisions")) return JSON.stringify({ summary: "r" });
  return JSON.stringify({
    intent: "i",
    summary: "s",
    constraints: ["c"],
    rejected: [{ alternative: "a", reason: "why" }],
    confidence: "high",
  });
};

// A fake that makes decisions distinguishable: synthesis echoes the recorded
// intent (or the cluster's file) into the constraint, so tests can assert WHICH
// decisions survive a merge — not just how many.
export const fakeEcho: Complete = async (prompt) => {
  if (prompt.includes("Cluster them")) {
    const ids = [...prompt.matchAll(/id=(j-[0-9a-f]+)/g)].map((m) => m[1]);
    return JSON.stringify({ clusters: ids.map((id) => [id]) });
  }
  if (prompt.startsWith("Summarize these related decisions")) {
    return JSON.stringify({ summary: "rollup summary" });
  }
  const intent = prompt.match(/^Stated intent: (.+)$/m)?.[1];
  const which = intent ?? `file:${prompt.match(/file=(\S+)/)?.[1] ?? "unknown"}`;
  return JSON.stringify({
    intent: which,
    summary: `s ${which}`,
    constraints: [`c-${which}`],
    rejected: [{ alternative: `alt-${which}`, reason: "why" }],
    confidence: "high",
  });
};

/** Absolute path to the built CLI, resolved from this file (not process.cwd()). */
export function cliPath(): string {
  return fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
}

/**
 * Command + args to run the CLI FROM SOURCE via tsx, so tests that spawn the
 * CLI exercise the current code and never green-light a stale dist/ artifact.
 */
export function tsxCliArgs(...cliArgs: string[]): [string, string[]] {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  return [process.execPath, [tsx, cli, ...cliArgs]];
}
