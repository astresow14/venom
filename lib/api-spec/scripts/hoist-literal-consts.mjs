#!/usr/bin/env node
/**
 * Hoist orval's literal helper constants (`export const fooMax = 200;`,
 * `export const fooRegExp = new RegExp(...);`) to the top of the generated
 * zod module.
 *
 * Orval 8.x occasionally emits one of these constants AFTER the schema that
 * references it (observed with `updateSharedWorkspaceMemberRoleResponseNameMax`),
 * which makes the whole module throw a temporal-dead-zone ReferenceError the
 * moment anything imports it. The constants are dependency-free literals, so
 * hoisting every one of them directly below the imports is always
 * semantics-preserving and makes emission order a non-issue.
 *
 * Runs as part of `pnpm --filter @workspace/api-spec run codegen`; idempotent.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(
  here,
  "..",
  "..",
  "api-zod",
  "src",
  "generated",
  "api.ts",
);
const GENERATED_DIRS = [
  path.resolve(here, "..", "..", "api-zod", "src", "generated"),
  path.resolve(here, "..", "..", "api-client-react", "src", "generated"),
];

/** Orval leaves blank lines at EOF, which `git diff --check` rejects. */
function normalizeEofNewlines() {
  let normalized = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      const content = readFileSync(full, "utf8");
      const clean = content.replace(/\n+$/, "\n");
      if (clean !== content) {
        writeFileSync(full, clean);
        normalized += 1;
      }
    }
  };
  for (const dir of GENERATED_DIRS) walk(dir);
  if (normalized > 0) {
    console.log(`hoist-literal-consts: normalized EOF in ${normalized} files`);
  }
}

const BANNER = [
  "// Literal helper constants hoisted by api-spec/scripts/hoist-literal-consts.mjs",
  "// so no schema declaration can reference one before it is initialized.",
];

/** Literal const starts: numbers, quoted strings, or RegExp constructions. */
const LITERAL_START = /^export const [a-z][A-Za-z0-9_]* = (\d|['"]|new RegExp\()/;

const source = readFileSync(target, "utf8");
const lines = source.split("\n");

const hoisted = [];
const kept = [];
let lastImportIndex = -1;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (/^import\b/.test(line)) {
    lastImportIndex = kept.length;
    kept.push(line);
    continue;
  }
  if (line.startsWith(BANNER[0])) {
    // A previous run's banner; drop it (re-added below with the constants).
    while (i + 1 < lines.length && lines[i + 1].startsWith("//")) i += 1;
    continue;
  }
  if (LITERAL_START.test(line)) {
    const statement = [line];
    while (!statement[statement.length - 1].trimEnd().endsWith(";")) {
      i += 1;
      if (i >= lines.length) {
        throw new Error(`Unterminated literal const near: ${line}`);
      }
      statement.push(lines[i]);
    }
    hoisted.push(statement.join("\n"));
    // Swallow one trailing blank line so removals don't stack blanks.
    if (i + 1 < lines.length && lines[i + 1] === "") i += 1;
    continue;
  }
  kept.push(line);
}

if (lastImportIndex === -1) {
  throw new Error("hoist-literal-consts: no import lines found in api.ts");
}
if (hoisted.length > 0) {
  kept.splice(lastImportIndex + 1, 0, "", ...BANNER, ...hoisted);
  writeFileSync(target, kept.join("\n"));
  console.log(
    `hoist-literal-consts: hoisted ${hoisted.length} literal constants in ${path.relative(process.cwd(), target)}`,
  );
} else {
  console.log("hoist-literal-consts: nothing to hoist");
}

normalizeEofNewlines();
