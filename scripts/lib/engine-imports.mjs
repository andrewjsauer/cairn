/**
 * Shared TypeScript-compiler-API scanner enforcing the engine boundary that
 * DESIGN.md claims is "enforced, not just asserted". Consumed by BOTH
 * tests/decoupling.test.ts and scripts/verify.mjs so there is exactly one
 * definition of the rule.
 *
 * Unlike the line-regex approach this replaces, the AST walk cannot be fooled
 * by multi-line/wrapped imports, `./../store` path tricks, re-exports, or
 * non-literal dynamic imports (which fail closed), and it also denies the
 * ambient escape hatches (process / fetch / globalThis) the regex never saw.
 */
import ts from "typescript";
import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const AMBIENT_DENYLIST = new Set(["process", "fetch", "globalThis"]);

/** Recursively list *.ts files under dir. */
export function tsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Collect every module specifier in a source file via the AST:
 *   - import declarations (including type-only and side-effect imports)
 *   - export ... from declarations (re-exports)
 *   - dynamic import(...) calls
 *   - require(...) calls
 * Non-literal dynamic import / require arguments cannot be verified, so they
 * are reported as violations in their own right — the check fails closed.
 */
function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];
  const nonLiteral = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          specifiers.push(arg.text);
        } else {
          nonLiteral.push(
            `non-literal ${isDynamicImport ? "dynamic import" : "require"}() — specifier cannot be verified: ${node.getText(sourceFile)}`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return { specifiers, nonLiteral };
}

/**
 * True when a module specifier is relative AND stays inside the engine:
 * it must start with "./" as written, and after path.posix.normalize it must
 * not contain any ".." segment (catches "./../store/index.js", which the old
 * startsWith("./") allowlist accepted). Absolute paths, bare packages, and
 * node: builtins all fail the startsWith check.
 */
function isIntraEngineSpecifier(spec) {
  if (!spec.startsWith("./")) return false;
  const normalized = path.posix.normalize(spec);
  return !normalized.split("/").includes("..");
}

/**
 * Scan one engine source text. Returns an array of violation strings
 * (empty = clean).
 *
 * Ambient-global heuristic: any Identifier token whose text is `process`,
 * `fetch`, or `globalThis` is flagged, EXCEPT when it is the `.name` of a
 * property access (`x.process` is someone else's property, not the global).
 * This is deliberately pragmatic — it would also flag a local variable that
 * shadows one of these names, but the engine has no reason to name anything
 * `process`/`fetch`/`globalThis`, so a false positive there is acceptable
 * friction in exchange for never missing a real ambient escape.
 */
export function scanEngineSource(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];

  const { specifiers, nonLiteral } = collectModuleSpecifiers(sourceFile);
  for (const detail of nonLiteral) violations.push(`${fileName}: ${detail}`);
  for (const spec of specifiers) {
    if (!isIntraEngineSpecifier(spec)) {
      violations.push(
        `${fileName}: imports "${spec}" (only ./ intra-engine imports allowed)`,
      );
    }
  }

  function visit(node) {
    if (ts.isIdentifier(node) && AMBIENT_DENYLIST.has(node.text)) {
      const isPropertyName =
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      if (!isPropertyName) {
        violations.push(
          `${fileName}: uses ambient global "${node.text}" (engine must be pure — injected dependencies only)`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  return violations;
}

/**
 * Scan every *.ts file under engineDir. Returns [{ file, violations }]
 * entries only for files with non-empty violations (empty array = clean tree).
 */
export function scanEngineDir(engineDir) {
  return tsFiles(engineDir)
    .map((file) => ({ file, violations: scanEngineSource(file, readFileSync(file, "utf8")) }))
    .filter((entry) => entry.violations.length > 0);
}

/**
 * Per-file child_process check (exported so tests can run it on fixture
 * strings without writing into src/): returns violations if this file imports
 * child_process / node:child_process and is not the allowed file (compared by
 * posix path suffix, e.g. "store/git.ts").
 */
export function childProcessViolations(fileName, sourceText, allowedFile) {
  const posixName = fileName.split(path.sep).join("/");
  if (posixName.endsWith(allowedFile)) return [];
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const { specifiers, nonLiteral } = collectModuleSpecifiers(sourceFile);
  const violations = nonLiteral.map((detail) => `${fileName}: ${detail}`);
  for (const spec of specifiers) {
    if (spec === "child_process" || spec === "node:child_process") {
      violations.push(
        `${fileName}: imports "${spec}" (child_process is confined to ${allowedFile})`,
      );
    }
  }
  return violations;
}

/**
 * Assert child_process is imported by exactly one file: scans every *.ts file
 * under srcDir and returns violation strings for any file other than allowedFile that
 * imports child_process or node:child_process (empty array = confined).
 */
export function assertChildProcessConfinedTo(srcDir, allowedFile) {
  return tsFiles(srcDir).flatMap((file) =>
    childProcessViolations(file, readFileSync(file, "utf8"), allowedFile),
  );
}
