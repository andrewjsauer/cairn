import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The hard requirement (Section 8 / acceptance criteria): nothing under
 * src/engine/ may import git, Claude Code, the store, the Anthropic SDK, or any
 * other Cairn layer. The engine takes an injected complete() and nothing else.
 *
 * This test fails the build if anyone ever adds such an import. It is the
 * executable form of the decoupling promise.
 */

const ENGINE_DIR = fileURLToPath(new URL("../src/engine", import.meta.url));

const FORBIDDEN: { pattern: RegExp; label: string }[] = [
  { pattern: /["']node:child_process["']/, label: "child_process (git shelling)" },
  { pattern: /["']node:fs["']/, label: "the filesystem (the engine is pure)" },
  { pattern: /["']@anthropic-ai\/sdk["']/, label: "Anthropic SDK" },
  { pattern: /["']@modelcontextprotocol\/sdk/, label: "MCP SDK" },
  { pattern: /\.\.\/store/, label: "the store" },
  { pattern: /\.\.\/capture/, label: "capture" },
  { pattern: /\.\.\/mcp/, label: "the MCP layer" },
  { pattern: /\.\.\/complete/, label: "the complete() adapter" },
  { pattern: /\.\.\/config/, label: "the config module" },
  { pattern: /["']simple-git["']/, label: "a git library" },
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

test("the engine has zero imports from git, Claude Code, the store, or the SDK", () => {
  const files = tsFiles(ENGINE_DIR);
  assert.ok(files.length > 0, "expected engine source files");
  const violations: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Catch static imports, re-exports (`export ... from`), and dynamic import()/require().
    const moduleLines = src
      .split("\n")
      .filter(
        (l) =>
          /^\s*import\b/.test(l) ||
          /^\s*export\b[^;]*\bfrom\b/.test(l) ||
          /\bimport\s*\(/.test(l) ||
          /\brequire\(/.test(l)
      );
    for (const line of moduleLines) {
      for (const { pattern, label } of FORBIDDEN) {
        if (pattern.test(line)) {
          violations.push(`${file}: depends on ${label}\n    ${line.trim()}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], `engine decoupling violated:\n${violations.join("\n")}`);
});
