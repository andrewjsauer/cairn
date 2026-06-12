import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  scanEngineDir,
  scanEngineSource,
  assertChildProcessConfinedTo,
  childProcessViolations,
  // The scanner is plain ESM JavaScript shared with scripts/verify.mjs so the
  // test and the verify gate enforce the exact same rule.
  // @ts-ignore — no type declarations for the .mjs module
} from "../scripts/lib/engine-imports.mjs";

/**
 * The hard requirement (Section 8 / acceptance criteria, and DESIGN.md's claim
 * that the engine boundary is "enforced, not just asserted"): nothing under
 * src/engine/ may import git, Claude Code, the store, the Anthropic SDK, or any
 * other Cairn layer. The engine takes an injected complete() and nothing else.
 *
 * This is enforced as an ALLOWLIST over the TypeScript AST, not a line regex:
 * every module specifier in the engine must be a relative `./` import that
 * stays inside the engine after normalization. Anything else — an npm package,
 * a `node:` builtin, a `../` escape (even disguised as `./../`), a wrapped
 * multi-line import, or a dynamic import whose specifier can't be verified —
 * fails. Ambient globals (process / fetch / globalThis) are denied too, so the
 * guarantee can't silently regress when new code is added.
 */

const ENGINE_DIR = fileURLToPath(new URL("../src/engine", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

test("the engine imports nothing but its own relative modules (no git/CC/store/SDK)", () => {
  const offenders: { file: string; violations: string[] }[] = scanEngineDir(ENGINE_DIR);
  assert.deepEqual(
    offenders,
    [],
    `engine decoupling violated:\n${offenders
      .map((o) => o.violations.join("\n"))
      .join("\n")}`,
  );
});

test("the enforcer catches what it claims to catch (negative self-test)", () => {
  const fixtures: Record<string, string> = {
    "multi-line node: import":
      'import {\n  execFileSync,\n} from "node:child_process";\n',
    '"./../" escape disguised as a ./ import':
      'import { x } from "./../store/index.js";\n',
    "non-literal dynamic import (fails closed)":
      'const m = "node:fs";\nawait import(m);\n',
    "ambient global (process.env)": "const x = process.env.HOME;\n",
    "re-export escape to another layer":
      'export { y } from "../store/index.js";\n',
  };

  for (const [name, source] of Object.entries(fixtures)) {
    const violations: string[] = scanEngineSource("fixture.ts", source);
    assert.ok(
      violations.length >= 1,
      `expected the scanner to flag ${name}, got none`,
    );
  }

  // Positive fixture: clean intra-engine imports (incl. type-only re-export)
  // must produce zero violations.
  const clean: string[] = scanEngineSource(
    "fixture.ts",
    'import { foo } from "./types.js";\nexport type { Atom } from "./types.js";\n',
  );
  assert.deepEqual(clean, []);
});

test("child_process is confined to store/git.ts across all of src/", () => {
  const violations: string[] = assertChildProcessConfinedTo(SRC_DIR, "store/git.ts");
  assert.deepEqual(
    violations,
    [],
    `child_process escaped the store layer:\n${violations.join("\n")}`,
  );

  // Negative self-test: the same per-file check flags a fixture scanned as if
  // it were some other file...
  const flagged: string[] = childProcessViolations(
    "src/capture/evil.ts",
    'import { spawn } from "node:child_process";\n',
    "store/git.ts",
  );
  assert.ok(flagged.length >= 1, "expected child_process import to be flagged");

  // ...while the allowed file itself is exempt.
  const allowed: string[] = childProcessViolations(
    "src/store/git.ts",
    'import { execFileSync } from "node:child_process";\n',
    "store/git.ts",
  );
  assert.deepEqual(allowed, []);
});
