/**
 * A failed sync must never leak a live credential into the console or the
 * sync-state file.
 *
 * The failure path has exactly two sinks: `main().catch` in `sync-github.ts`
 * prints the message, and `record()` persists `firstLine(redact(detail))` to
 * the state file. Both must stay behind `redact()`, and `record()` must redact
 * BEFORE collapsing to one line — the 200-character truncation would otherwise
 * cut a token in half and leave a fragment `redact()` can no longer match.
 *
 * The end-to-end test runs the real `sync-github.ts` in a child process with
 * `fetch` replaced by a preload stub that refuses every request the failing
 * sync does not need, from a scratch git repository: fully offline, real catch
 * handler, real state file on disk.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { redact, rememberSecret } from "./github";
import { firstLine, readSyncState } from "./sync-state";

const SYNC_SCRIPT = fileURLToPath(new URL("../sync-github.ts", import.meta.url));
const REPO = "example/mirror";

/**
 * Token-shaped, but assembled at runtime so nothing in the tracked source
 * reads as a credential to the sync's own key-material scan.
 */
const LEAKED_TOKEN = ["gho", "e2e_redaction_audit_0123456789abcdef0123456789abcdef"].join("_");

/** Isolated from the developer's own git config, like the other repo fixtures. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function run(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

/** A clean one-commit repository: the sync's pre-flight checks all pass. */
function scratchRepo(root: string): void {
  run(root, "init", "--quiet", "--initial-branch=main");
  run(root, "config", "user.email", "sync@example.test");
  run(root, "config", "user.name", "Sync Test");
  run(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "readme.md"), "an ordinary tracked file\n");
  run(root, "add", "--all");
  execFileSync("git", ["-C", root, "commit", "--quiet", "--no-verify", "-m", "base"], {
    env: GIT_ENV,
    stdio: "ignore",
  });
}

/**
 * A `fetch` stub installed before the sync starts. It hands out the leaked
 * token as the connector credential, then fails the first repository read
 * with a multi-line message that echoes the bearer token it received — twice
 * on the first line, once on each later line — the way a proxy or git remote
 * error sometimes quotes what was sent. Every other request is refused, so
 * the test can never touch the network.
 */
function preloadSource(token: string, repo: string): string {
  return [
    `const TOKEN = ${JSON.stringify(token)};`,
    `const REPO = ${JSON.stringify(repo)};`,
    'const CONNECTOR_URL = "https://connectors.test.invalid/api/v2/connection?include_secrets=true&connector_names=github";',
    "globalThis.fetch = async (input, init) => {",
    '  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;',
    '  const bearer = (new Headers(init && init.headers).get("authorization") || "").replace(/^Bearer /, "");',
    "  if (url === CONNECTOR_URL) {",
    "    return new Response(JSON.stringify({ items: [{ settings: { access_token: TOKEN } }] }), { status: 200 });",
    "  }",
    '  if (url === "https://api.github.com/user" && bearer === TOKEN) {',
    '    return new Response("{}", { status: 200, headers: { "x-oauth-scopes": "repo" } });',
    "  }",
    "  if (url === `https://api.github.com/repos/${REPO}` && bearer === TOKEN) {",
    "    const message = [",
    '      "remote rejected " + bearer + " (" + bearer + " again) " + "x".repeat(120),',
    '      "hint: the extraheader carried " + bearer,',
    '      "remote: " + bearer,',
    '    ].join("\\n");',
    "    return new Response(JSON.stringify({ message }), { status: 403 });",
    "  }",
    '  throw new Error("this test allows no request to " + url);',
    "};",
    "",
  ].join("\n");
}

test("record's composition redacts before collapsing, so truncation cannot split a token", () => {
  const token = ["ghp", "boundary_audit_0123456789012345678901234"].join("_");
  rememberSecret(token);

  // The token sits inside a first line that runs past the marker's
  // 200-character cap. Collapsing first would truncate mid-token and leave a
  // prefix that redact() can no longer recognise.
  const inside = `${"x".repeat(150)}${token} ${"y".repeat(60)}\nsecond line ${token}`;
  const insideDetail = firstLine(redact(inside));
  assert.ok(!insideDetail.includes(token.slice(0, 12)), "a token fragment leaked");
  assert.ok(insideDetail.includes("***redacted***"));
  assert.ok(!insideDetail.includes("\n"));
  assert.ok(insideDetail.length <= 200);

  // Here the raw token itself straddles the 200-character boundary.
  const straddling = `${"x".repeat(180)}${token}`;
  assert.equal(firstLine(redact(straddling)), `${"x".repeat(180)}***redacted***`);
});

test("a failing sync redacts the token from the console and the recorded state file", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sync-github-redaction-"));
  const repoRoot = join(scratch, "repo");
  mkdirSync(repoRoot);
  scratchRepo(repoRoot);

  const statePath = join(scratch, "state", "github-sync.json");
  const preloadPath = join(scratch, "preload.mjs");
  writeFileSync(preloadPath, preloadSource(LEAKED_TOKEN, REPO));

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Only the stubbed connector may supply a credential.
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_APP_ID;
  delete env.GITHUB_APP_PRIVATE_KEY;
  delete env.GITHUB_APP_INSTALLATION_ID;
  delete env.WEB_REPL_RENEWAL;
  delete env.VENOM_GITHUB_SYNC_BRANCH;
  Object.assign(env, {
    REPLIT_CONNECTORS_HOSTNAME: "connectors.test.invalid",
    REPL_IDENTITY: "test-identity",
    VENOM_GITHUB_REPO: REPO,
    VENOM_GITHUB_SYNC_STATE: statePath,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  });

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--import",
      pathToFileURL(preloadPath).href,
      SYNC_SCRIPT,
    ],
    { cwd: repoRoot, env, encoding: "utf8", timeout: 120_000 },
  );

  // The run got exactly as far as intended: credentials resolved, then the
  // repository read failed with the poisoned message, and the failure was
  // recorded rather than rethrown.
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Credential: {2}replit-connector/);
  assert.match(result.stderr, /Sync failed\./);
  assert.match(result.stderr, /Cannot read example\/mirror \(HTTP 403\)/);
  assert.match(result.stderr, /Recorded the failure\./);

  // No fragment of the token reaches the console; all four occurrences in the
  // multi-line message come out as markers.
  const consoleOutput = `${result.stdout}${result.stderr}`;
  assert.ok(!consoleOutput.includes(LEAKED_TOKEN.slice(0, 12)), "a token fragment reached the console");
  assert.equal(result.stderr.split("***redacted***").length - 1, 4);

  // Nor does one reach any field of the state file on disk — scan the raw
  // bytes, not just the parsed detail.
  const rawState = readFileSync(statePath, "utf8");
  assert.ok(!rawState.includes(LEAKED_TOKEN.slice(0, 12)), "a token fragment reached the state file");

  const state = readSyncState(statePath);
  assert.equal(state.lastAttempt?.outcome, "failed");
  assert.equal(state.lastSuccess, null);
  const detail = state.lastAttempt?.detail ?? "";
  assert.equal(detail.split("***redacted***").length - 1, 2, "both first-line occurrences are scrubbed");
  assert.ok(!detail.includes("\n"));
  assert.ok(detail.length <= 200);

  rmSync(scratch, { recursive: true, force: true });
});
