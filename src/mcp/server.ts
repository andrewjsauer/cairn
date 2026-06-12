#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recall } from "../engine/index.js";
import { repoRoot, repoRelativePath, renamesInHistory } from "../store/index.js";
import { allAtoms, atomsForFile } from "../read/graph.js";
import { formatChain, formatRecent } from "./format.js";
import { RECALL_TOKEN_BUDGET, DEFAULT_RECENT } from "../config.js";

/**
 * The Cairn MCP server: read-only, two tools (why, recent).
 *
 * Resolving the active repo (Section 11): a user/plugin-level stdio server is
 * spawned once, so it cannot assume its process.cwd() is the session's repo.
 * Claude Code sets CLAUDE_PROJECT_DIR in the server's environment (and a server
 * may also call roots/list). We resolve in that order, then `git rev-parse` from
 * there to get the repo root — and we re-resolve on every call so the answer
 * tracks the active workspace rather than wherever the server happened to start.
 */

function resolveRepoRoot(): string | null {
  const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return repoRoot(base);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

const server = new McpServer({
  name: "cairn",
  version: "0.1.0",
});

server.registerTool(
  "why",
  {
    title: "Why is this file the way it is",
    description:
      "Return the chain of recorded decisions for a file over time — the intent, " +
      "constraints, and rejected alternatives behind how the code got this way. " +
      "Reads Cairn's git-notes graph and Lore commit trailers. Budget-bounded.",
    inputSchema: {
      file: z.string().describe("Path to the file (absolute or repo-relative)."),
    },
  },
  async ({ file }) => {
    const root = resolveRepoRoot();
    if (!root) return errorResult("Cairn: not inside a git repository.");
    const rel = repoRelativePath(root, file);
    // One rename map per request, shared by assembly and recall so both match
    // a renamed file's chain by its canonical current name.
    const renames = renamesInHistory(root);
    const atoms = atomsForFile(root, rel, renames);
    const result = recall(atoms, { file: rel, tokenBudget: RECALL_TOKEN_BUDGET, renames });
    return textResult(formatChain(rel, result));
  }
);

server.registerTool(
  "recent",
  {
    title: "Recent decisions",
    description:
      "Return the most recent decisions recorded across the repository, newest " +
      "first, under a token budget. Useful for orienting a fresh session.",
    inputSchema: {
      n: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe(`How many decisions to return (default ${DEFAULT_RECENT}).`),
    },
  },
  async ({ n }) => {
    const root = resolveRepoRoot();
    if (!root) return errorResult("Cairn: not inside a git repository.");
    const count = n ?? DEFAULT_RECENT;
    const atoms = allAtoms(root);
    const result = recall(atoms, { recent: count, tokenBudget: RECALL_TOKEN_BUDGET });
    return textResult(formatRecent(count, result));
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`cairn-mcp: ${(err as Error).message}\n`);
  process.exit(1);
});
