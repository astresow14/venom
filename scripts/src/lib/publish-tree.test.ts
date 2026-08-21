import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  isWorkflowPath,
  pathsDiffering,
  treeOf,
  treeWithPrefixFromBase,
  WORKFLOW_PREFIX,
} from "./publish-tree";

/** Isolated from the developer's own git config, like the other repo fixtures. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function run(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

function commitAll(root: string, message: string): string {
  run(root, "add", "--all");
  execFileSync("git", ["-C", root, "commit", "--quiet", "--no-verify", "-m", message], {
    env: GIT_ENV,
    stdio: "ignore",
  });
  return run(root, "rev-parse", "HEAD");
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "publish-tree-"));
  run(root, "init", "--quiet", "--initial-branch=main");
  run(root, "config", "user.email", "sync@example.test");
  run(root, "config", "user.name", "Sync Test");
  run(root, "config", "commit.gpgsign", "false");
  return root;
}

test("workflow paths are recognised by prefix, not by substring", () => {
  assert.ok(isWorkflowPath(".github/workflows/ci.yml"));
  assert.ok(isWorkflowPath(".github/workflows/nested/dir.yml"));
  assert.ok(!isWorkflowPath(".github/workflows"));
  assert.ok(!isWorkflowPath(".github/dependabot.yml"));
  assert.ok(!isWorkflowPath("docs/.github/workflows/ci.yml"));
});

test("pathsDiffering compares trees two-dot, from any working directory", () => {
  const root = repo();
  write(root, { "app.txt": "one", "docs.md": "hello" });
  const base = commitAll(root, "base");
  write(root, { "app.txt": "two", "extra.txt": "new" });
  const head = commitAll(root, "head");

  assert.deepEqual(pathsDiffering(root, base, head).sort(), ["app.txt", "extra.txt"]);
  assert.deepEqual(pathsDiffering(root, head, head), []);
});

test("the pinned tree resets workflow paths to the base version and touches nothing else", () => {
  const root = repo();
  write(root, {
    "app.txt": "one",
    ".github/workflows/ci.yml": "old ci",
    ".github/workflows/gone.yml": "restore me",
  });
  const base = commitAll(root, "base");

  write(root, {
    "app.txt": "two",
    "docs.md": "hello",
    ".github/workflows/ci.yml": "new ci",
    ".github/workflows/extra.yml": "brand new",
  });
  rmSync(join(root, ".github/workflows/gone.yml"));
  const head = commitAll(root, "head");

  const pinned = treeWithPrefixFromBase(root, head, base, WORKFLOW_PREFIX);
  const listed = run(root, "ls-tree", "-r", "--name-only", pinned).split("\n");

  assert.ok(listed.includes("docs.md"), "non-workflow additions survive");
  assert.equal(run(root, "show", `${pinned}:app.txt`), "two", "non-workflow edits survive");
  assert.equal(run(root, "show", `${pinned}:.github/workflows/ci.yml`), "old ci", "edits revert");
  assert.ok(!listed.includes(".github/workflows/extra.yml"), "additions drop");
  assert.ok(listed.includes(".github/workflows/gone.yml"), "deletions restore");
  assert.equal(run(root, "show", `${pinned}:.github/workflows/gone.yml`), "restore me");

  assert.equal(run(root, "status", "--porcelain"), "", "the real index is untouched");
  assert.notEqual(pinned, treeOf(root, head));
});

test("pinning to a base without the prefix drops the whole directory", () => {
  const root = repo();
  write(root, { "app.txt": "one" });
  const base = commitAll(root, "base");
  write(root, { ".github/workflows/ci.yml": "new ci" });
  const head = commitAll(root, "head");

  const pinned = treeWithPrefixFromBase(root, head, base, WORKFLOW_PREFIX);
  const listed = run(root, "ls-tree", "-r", "--name-only", pinned).split("\n");

  assert.ok(!listed.some((path) => path.startsWith(".github/")));
  assert.equal(pinned, treeOf(root, base), "only workflow paths differed, so the trees now match");
});

test("a pinned tree with no workflow differences equals the head tree", () => {
  const root = repo();
  write(root, { "app.txt": "one", ".github/workflows/ci.yml": "same" });
  const base = commitAll(root, "base");
  write(root, { "app.txt": "two" });
  const head = commitAll(root, "head");

  assert.equal(treeWithPrefixFromBase(root, head, base, WORKFLOW_PREFIX), treeOf(root, head));
});
