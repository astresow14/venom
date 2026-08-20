/**
 * Sync this Replit checkout to the GitHub mirror as a pull request.
 *
 * The branch ruleset on `main` has no bypass actors, so nothing may be pushed
 * straight to `main`. This script pushes the current commit to a sync branch and
 * opens (or refreshes) a pull request against the default branch instead.
 *
 * Credentials come from the Replit GitHub connector, which refreshes its own
 * OAuth token, so the routine does not depend on a hand-pasted personal access
 * token. The token is held in memory only: it is passed to git through
 * `GIT_CONFIG_COUNT` + `http.extraheader`, never written to `.git/config`, never
 * placed in a remote URL, and redacted from any output this script prints.
 *
 * Usage:
 *   pnpm run sync:github                 open/refresh the pull request
 *   pnpm run sync:github -- --dry-run    report what would be pushed
 *   pnpm run sync:github -- --branch my-sync --title "..." --body "..."
 */

import { spawnSync } from "node:child_process";

const DEFAULT_REPO = "astresow14/venom";
const DEFAULT_BRANCH = "replit-sync";
const WORKFLOW_PREFIX = ".github/workflows/";
const GITHUB_API = "https://api.github.com";

type TokenSource = "replit-connector" | "GITHUB_TOKEN";

interface Credential {
  token: string;
  source: TokenSource;
  /** Classic/OAuth scopes, or `null` when the token does not report any. */
  scopes: string[] | null;
}

interface Options {
  repo: string;
  branch: string;
  title: string | null;
  body: string | null;
  dryRun: boolean;
}

class SyncError extends Error {}

/** Every credential seen this run, so nothing secret can reach stdout. */
const secrets: string[] = [];

function parseArgs(argv: string[]): Options {
  const options: Options = {
    repo: process.env.VENOM_GITHUB_REPO?.trim() || DEFAULT_REPO,
    branch: process.env.VENOM_GITHUB_SYNC_BRANCH?.trim() || DEFAULT_BRANCH,
    title: null,
    body: null,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SyncError(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      // pnpm forwards its own separator when flags are passed through `--`.
      case "--":
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--repo":
        options.repo = readValue();
        break;
      case "--branch":
        options.branch = readValue();
        break;
      case "--title":
        options.title = readValue();
        break;
      case "--body":
        options.body = readValue();
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: pnpm run sync:github [-- options]",
            "",
            "  --branch <name>  sync branch to push (default: " + DEFAULT_BRANCH + ")",
            "  --repo <o/n>     target repository (default: " + DEFAULT_REPO + ")",
            "  --title <text>   pull request title (new pull requests only)",
            "  --body <text>    pull request body (new pull requests only)",
            "  --dry-run        report what would be pushed, change nothing",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new SyncError(`Unknown argument: ${arg}`);
    }
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
    throw new SyncError(`--repo must look like "owner/name", got "${options.repo}"`);
  }

  return options;
}

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new SyncError(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new SyncError(`git ${args.join(" ")} failed:\n${detail}`);
  }

  return (result.stdout ?? "").trim();
}

function gitStatus(args: string[], env?: NodeJS.ProcessEnv): number {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status ?? 1;
}

/** Strip every known credential out of anything that could reach stdout or a log. */
function redact(text: string): string {
  return secrets.reduce(
    (accumulator, secret) =>
      secret ? accumulator.split(secret).join("***redacted***") : accumulator,
    text,
  );
}

async function connectorToken(): Promise<string | null> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const identity = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;

  if (!hostname || !identity) {
    return null;
  }

  const response = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=github`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: identity } },
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    items?: Array<{
      settings?: {
        access_token?: string;
        oauth?: { credentials?: { access_token?: string } };
      };
    }>;
  };

  const settings = payload.items?.[0]?.settings;
  return settings?.access_token ?? settings?.oauth?.credentials?.access_token ?? null;
}

async function resolveCredential(): Promise<Credential> {
  const fromConnector = await connectorToken();
  const token = fromConnector ?? process.env.GITHUB_TOKEN?.trim() ?? null;
  if (token) {
    secrets.push(token);
  }

  if (!token) {
    throw new SyncError(
      [
        "No GitHub credential available.",
        "Expected the Replit GitHub connector to be connected for this workspace.",
        "Reconnect it from the Integrations pane, or set GITHUB_TOKEN as a fallback.",
      ].join("\n"),
    );
  }

  const source: TokenSource = fromConnector ? "replit-connector" : "GITHUB_TOKEN";
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new SyncError(
      `GitHub rejected the ${source} credential (HTTP ${response.status}). Reconnect the GitHub integration and retry.`,
    );
  }

  const header = response.headers.get("x-oauth-scopes");
  const scopes =
    header === null
      ? null
      : header
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean);

  return { token, source, scopes };
}

async function github<T>(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: response.status, data };
}

function gitEnvWithToken(token: string): NodeJS.ProcessEnv {
  const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const credential = await resolveCredential();
  const authEnv = gitEnvWithToken(credential.token);
  const remoteUrl = `https://github.com/${options.repo}.git`;

  console.log(`Repository:  ${options.repo}`);
  console.log(`Credential:  ${credential.source}`);

  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    throw new SyncError(
      [
        "The working tree has uncommitted changes, so there is nothing stable to sync.",
        "Commit (or stash) them first, then run the sync again:",
        dirty
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n"),
      ].join("\n"),
    );
  }

  const repository = await github<{ default_branch?: string; message?: string }>(
    `/repos/${options.repo}`,
    credential.token,
  );
  if (repository.status !== 200 || !repository.data.default_branch) {
    throw new SyncError(
      `Cannot read ${options.repo} (HTTP ${repository.status}): ${repository.data.message ?? "unknown error"}`,
    );
  }
  const baseBranch = repository.data.default_branch;

  const baseRef = `refs/venom-sync/${baseBranch}`;
  git(["fetch", "--no-tags", "--force", remoteUrl, `${baseBranch}:${baseRef}`], authEnv);

  const headSha = git(["rev-parse", "HEAD"]);
  const baseSha = git(["rev-parse", baseRef]);
  const [behind, ahead] = git(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`])
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));

  console.log(`Base:        ${baseBranch} @ ${baseSha.slice(0, 8)}`);
  console.log(`Local HEAD:  ${headSha.slice(0, 8)} (${ahead} ahead, ${behind} behind)`);

  if (ahead === 0) {
    console.log(`\nGitHub already has every local commit. Nothing to sync.`);
    return;
  }

  const changedPaths = git(["diff", "--name-only", `${baseRef}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const workflowPaths = changedPaths.filter((path) => path.startsWith(WORKFLOW_PREFIX));

  console.log(`Changes:     ${changedPaths.length} file(s) versus ${baseBranch}`);

  // An OAuth token without the `workflow` scope has its push rejected outright
  // when the push carries a change under .github/workflows.
  if (workflowPaths.length > 0 && credential.scopes !== null && !credential.scopes.includes("workflow")) {
    throw new SyncError(
      [
        "This sync changes GitHub Actions workflow files:",
        ...workflowPaths.map((path) => `  ${path}`),
        "",
        `The ${credential.source} credential does not carry the "workflow" scope, so GitHub will refuse the push.`,
        "Push workflow changes with a credential that has workflow write access, for example a short-lived",
        'fine-grained token in GITHUB_TOKEN with "Workflows: Read and write" for this repository.',
      ].join("\n"),
    );
  }

  const conflicts = gitStatus(["merge-tree", "--write-tree", "HEAD", baseRef]) !== 0;
  if (conflicts) {
    console.log(
      `\nWarning: HEAD and ${baseBranch} conflict. The pull request will need a manual merge before it can land.`,
    );
  }

  if (options.dryRun) {
    console.log(`\nDry run: would force-push ${headSha.slice(0, 8)} to ${options.branch} and open a pull request.`);
    return;
  }

  git(["push", "--force", remoteUrl, `HEAD:refs/heads/${options.branch}`], authEnv);
  console.log(`Pushed:      ${headSha.slice(0, 8)} -> ${options.branch}`);

  const [owner] = options.repo.split("/");
  const existing = await github<Array<{ number: number; html_url: string }>>(
    `/repos/${options.repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${owner}:${options.branch}`)}`,
    credential.token,
  );

  if (existing.status !== 200) {
    throw new SyncError(`Could not list pull requests (HTTP ${existing.status}).`);
  }

  let pullNumber: number;
  let pullUrl: string;

  if (existing.data.length > 0) {
    pullNumber = existing.data[0].number;
    pullUrl = existing.data[0].html_url;
    console.log(`Updated:     pull request #${pullNumber}`);
  } else {
    const subject = git(["log", "-1", "--pretty=%s"]);
    const created = await github<{ number?: number; html_url?: string; message?: string }>(
      `/repos/${options.repo}/pulls`,
      credential.token,
      {
        method: "POST",
        body: {
          title: options.title ?? `Sync Replit workspace: ${subject}`,
          head: options.branch,
          base: baseBranch,
          body:
            options.body ??
            [
              "Automated sync of the Replit workspace checkout.",
              "",
              `Head commit: \`${headSha}\``,
              `Files changed versus \`${baseBranch}\`: ${changedPaths.length}`,
              "",
              "Opened by `pnpm run sync:github`.",
            ].join("\n"),
        },
      },
    );

    if (created.status !== 201 || !created.data.number || !created.data.html_url) {
      throw new SyncError(
        `Could not open a pull request (HTTP ${created.status}): ${created.data.message ?? "unknown error"}`,
      );
    }

    pullNumber = created.data.number;
    pullUrl = created.data.html_url;
    console.log(`Opened:      pull request #${pullNumber}`);
  }

  const detail = await github<{ mergeable_state?: string }>(
    `/repos/${options.repo}/pulls/${pullNumber}`,
    credential.token,
  );

  console.log(`\nPull request: ${pullUrl}`);
  if (detail.data.mergeable_state) {
    console.log(`Merge state:  ${detail.data.mergeable_state}`);
  }
  console.log(`Merge it on GitHub once the required check reports success; main refuses direct pushes by design.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nSync failed.\n${redact(message)}`);
  process.exitCode = 1;
});
