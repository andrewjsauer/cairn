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
 * This is enforced as an ALLOWLIST, not a denylist: every module specifier in
 * the engine must be a relative `./` import (i.e. intra-engine). Anything else —
 * an npm package, a `node:` builtin, or a `../` escape to another layer — fails
 * the test, so the guarantee can't silently regress when a new import is added.
 */

const ENGINE_DIR = fileURLToPath(new URL("../src/engine", import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

/** Pull the module specifier from an import / export-from / dynamic-import / require line. */
function moduleSpecifier(line: string): string | null {
  const m =
    line.match(/\bfrom\s*["']([^"']+)["']/) ||
    line.match(/\bimport\s*\(\s*["']([^"']+)["']/) ||
    line.match(/\brequire\(\s*["']([^"']+)["']/) ||
    line.match(/^\s*import\s+["']([^"']+)["']/); // side-effect import
  return m ? m[1] : null;
}

test("the engine imports nothing but its own relative modules (no git/CC/store/SDK)", () => {
  const files = tsFiles(ENGINE_DIR);
  assert.ok(files.length > 0, "expected engine source files");
  const violations: string[] = [];

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      const isModuleLine =
        /^\s*import\b/.test(line) ||
        /^\s*export\b[^;]*\bfrom\b/.test(line) ||
        /\bimport\s*\(/.test(line) ||
        /\brequire\(/.test(line);
      if (!isModuleLine) continue;

      // Type-only `import type { X } from "./types.js"` is fine — still a `./` path.
      const spec = moduleSpecifier(line);
      if (spec === null) continue; // not actually importing a module (e.g. `import.meta`)

      // Allowlist: only intra-engine relative paths are permitted.
      if (!spec.startsWith("./")) {
        violations.push(`${file}: imports "${spec}" (only ./ intra-engine imports allowed)\n    ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(violations, [], `engine decoupling violated:\n${violations.join("\n")}`);
});
