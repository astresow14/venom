/**
 * GitHub credential resolution and REST access for the sync routine.
 *
 * Credentials are chosen automatically, so nothing is pasted at run time:
 *
 *   1. Replit GitHub connector — refreshes its own OAuth token, so ordinary
 *      syncs never need a stored secret. Its scopes do not include `workflow`.
 *   2. GitHub App installation — when `GITHUB_APP_ID` and
 *      `GITHUB_APP_PRIVATE_KEY` are set, a fresh one-hour installation token is
 *      minted per run. The private key does not expire, so a change under
 *      `.github/workflows/` lands without anyone pasting a credential.
 *   3. `GITHUB_TOKEN` — a stored fine-grained or classic token, used when it is
 *      the only credential that can write workflow files.
 *
 * A push that touches `.github/workflows/` uses whichever credential can write
 * workflow files; everything else keeps using the connector.
 */

import { createSign } from "node:crypto";

import { SyncError } from "./git";

export const GITHUB_API = "https://api.github.com";

export const APP_ID_ENV = "GITHUB_APP_ID";
export const APP_KEY_ENV = "GITHUB_APP_PRIVATE_KEY";
export const APP_INSTALLATION_ENV = "GITHUB_APP_INSTALLATION_ID";

/** Warn this many days before a stored token expires, so it can be rotated in time. */
export const EXPIRY_WARNING_DAYS = 14;

export type TokenSource = "replit-connector" | "github-app" | "GITHUB_TOKEN";

/** Whether a credential may push changes under `.github/workflows/`. */
export type WorkflowAccess = "yes" | "no" | "unknown";

export interface Credential {
  token: string;
  source: TokenSource;
  /** Classic/OAuth scopes, or `null` when the token does not report any. */
  scopes: string[] | null;
  workflows: WorkflowAccess;
  /** When the credential stops working, when GitHub reports it. */
  expiresAt: Date | null;
  /** Extra context for logs, such as the installation the token came from. */
  detail: string | null;
}

/** Every credential seen this run, so nothing secret can reach stdout. */
const secrets: string[] = [];

export function rememberSecret(secret: string): void {
  if (secret) {
    secrets.push(secret);
  }
}

/** Strip every known credential out of anything that could reach stdout or a log. */
export function redact(text: string): string {
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
  return (
    settings?.access_token ?? settings?.oauth?.credentials?.access_token ?? null
  );
}

/** Ask GitHub what a token can do. Installation tokens are not accepted here. */
async function inspectToken(
  token: string,
  source: TokenSource,
): Promise<{ scopes: string[] | null; expiresAt: Date | null }> {
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new SyncError(
      `GitHub rejected the ${source} credential (HTTP ${response.status}). Reconnect the GitHub integration, or refresh ${source}, and retry.`,
    );
  }

  const scopeHeader = response.headers.get("x-oauth-scopes");
  const scopes =
    scopeHeader === null
      ? null
      : scopeHeader
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean);

  // GitHub reports expiry as "2026-09-19 16:42:41 UTC".
  const expiryHeader = response.headers.get(
    "github-authentication-token-expiration",
  );
  const parsed = expiryHeader
    ? new Date(expiryHeader.replace(" UTC", "Z").replace(" ", "T"))
    : null;
  const expiresAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  return { scopes, expiresAt };
}

/**
 * A classic/OAuth token states its scopes, so workflow access is knowable up
 * front. A fine-grained token reports none, so the answer stays "unknown" and
 * the push itself is the test.
 */
function workflowAccessFromScopes(scopes: string[] | null): WorkflowAccess {
  if (scopes === null) {
    return "unknown";
  }
  return scopes.includes("workflow") ? "yes" : "no";
}

/**
 * Accept a PEM directly, with escaped newlines, or base64-encoded.
 *
 * Exported so the tests can prove every accepted form normalizes to the same
 * signable key without touching the network.
 */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();

  // GitHub shows a "SHA256:..." fingerprint next to the key on the app page.
  // It looks like a credential but is only a checksum of one.
  if (trimmed.startsWith("SHA256:")) {
    throw new SyncError(
      [
        `${APP_KEY_ENV} holds a key fingerprint ("SHA256:..."), not a key.`,
        "The value must be the contents of the .pem file GitHub downloaded when you clicked",
        '"Generate a private key" — open that file in a text editor and copy all of it, starting',
        'with "-----BEGIN RSA PRIVATE KEY-----".',
      ].join("\n"),
    );
  }

  const pem = trimmed.includes("-----BEGIN")
    ? trimmed.replace(/\\n/g, "\n")
    : Buffer.from(trimmed, "base64").toString("utf8").trim();

  if (!pem.includes("-----BEGIN")) {
    throw new SyncError(
      `${APP_KEY_ENV} is not a PEM private key. Store the contents of the .pem file GitHub generated for the app, exactly as downloaded.`,
    );
  }

  return pem;
}

/**
 * Sign the short-lived JWT that authenticates as the GitHub App itself.
 *
 * Exported so the tests can verify the signature against the matching public
 * key instead of trusting that GitHub would have accepted it.
 */
export function appJwt(appId: string, privateKeyPem: string): string {
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: issuedAt,
    exp: issuedAt + 540,
    iss: appId,
  })}`;

  try {
    const signature = createSign("RSA-SHA256")
      .update(payload)
      .sign(privateKeyPem, "base64url");
    return `${payload}.${signature}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SyncError(
      `Could not sign a GitHub App JWT with ${APP_KEY_ENV}: ${message}`,
    );
  }
}

async function connectorCredential(): Promise<Credential | null> {
  const token = await connectorToken();
  if (!token) {
    return null;
  }
  rememberSecret(token);

  const { scopes, expiresAt } = await inspectToken(token, "replit-connector");
  return {
    token,
    source: "replit-connector",
    scopes,
    workflows: workflowAccessFromScopes(scopes),
    expiresAt,
    detail: null,
  };
}

/**
 * Mint an installation token from the GitHub App credentials. The private key
 * never expires, so this needs no human in the loop; the minted token lasts an
 * hour and is thrown away when the process ends.
 */
async function appCredential(repo: string): Promise<Credential | null> {
  const appId = process.env[APP_ID_ENV]?.trim();
  const privateKey = process.env[APP_KEY_ENV]?.trim();

  if (!appId && !privateKey) {
    return null;
  }
  if (!appId || !privateKey) {
    throw new SyncError(
      `A GitHub App is half-configured: set both ${APP_ID_ENV} and ${APP_KEY_ENV}, or neither.`,
    );
  }
  if (!/^\d+$/.test(appId)) {
    throw new SyncError(
      `${APP_ID_ENV} must be the numeric App ID from the app's General page (6-7 digits), not the client id, slug, or key fingerprint.`,
    );
  }

  const jwt = appJwt(appId, normalizePrivateKey(privateKey));
  rememberSecret(jwt);

  let installationId = process.env[APP_INSTALLATION_ENV]?.trim();
  if (!installationId) {
    const found = await github<{ id?: number; message?: string }>(
      `/repos/${repo}/installation`,
      jwt,
    );
    if (found.status !== 200 || !found.data.id) {
      throw new SyncError(
        [
          `GitHub App ${appId} is not installed on ${repo} (HTTP ${found.status}): ${found.data.message ?? "unknown error"}.`,
          `Install the app on that repository, or set ${APP_INSTALLATION_ENV} to the installation id.`,
        ].join("\n"),
      );
    }
    installationId = String(found.data.id);
  }

  const [, name] = repo.split("/");
  const minted = await github<{
    token?: string;
    expires_at?: string;
    permissions?: Record<string, string>;
    message?: string;
  }>(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
    body: { repositories: [name] },
  });

  if (minted.status !== 201 || !minted.data.token) {
    throw new SyncError(
      `Could not mint an installation token for GitHub App ${appId} (HTTP ${minted.status}): ${minted.data.message ?? "unknown error"}`,
    );
  }
  rememberSecret(minted.data.token);

  const permissions = minted.data.permissions ?? {};
  const expires = minted.data.expires_at
    ? new Date(minted.data.expires_at)
    : null;
  return {
    token: minted.data.token,
    source: "github-app",
    scopes: null,
    workflows: permissions.workflows === "write" ? "yes" : "no",
    expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
    detail: `app ${appId}, installation ${installationId}`,
  };
}

async function storedTokenCredential(): Promise<Credential | null> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    return null;
  }
  rememberSecret(token);

  const { scopes, expiresAt } = await inspectToken(token, "GITHUB_TOKEN");
  return {
    token,
    source: "GITHUB_TOKEN",
    scopes,
    workflows: workflowAccessFromScopes(scopes),
    expiresAt,
    detail: expiresAt
      ? `expires ${expiresAt.toISOString().slice(0, 10)}`
      : "no expiry reported",
  };
}

export function describeCredential(credential: Credential): string {
  return credential.detail
    ? `${credential.source} (${credential.detail})`
    : credential.source;
}

function daysUntil(moment: Date): number {
  return Math.floor((moment.getTime() - Date.now()) / 86_400_000);
}

/** Credentials already warned about, so a run says it at most once. */
const expiryWarned = new Set<TokenSource>();

/**
 * A stored token is the one credential that can lapse — the connector refreshes
 * itself and an installation token is minted per run. Say so while there is
 * still time to rotate it, whether the token is doing the whole sync or only
 * the workflow push.
 */
export function warnIfExpiring(credential: Credential): void {
  if (
    credential.source !== "GITHUB_TOKEN" ||
    !credential.expiresAt ||
    expiryWarned.has(credential.source)
  ) {
    return;
  }

  const remaining = daysUntil(credential.expiresAt);
  if (remaining > EXPIRY_WARNING_DAYS) {
    return;
  }
  expiryWarned.add(credential.source);

  const when =
    remaining <= 0
      ? "expires today or has already lapsed"
      : `expires in ${remaining} day(s)`;
  console.log(
    `Warning:     GITHUB_TOKEN ${when}. Replace it, or switch to the GitHub App setup in replit.md.`,
  );
}

export function workflowSetupHelp(repo: string): string[] {
  return [
    "Set either of these up once and workflow changes sync on their own:",
    `  1. Fine-grained token: create one for ${repo} with "Contents: Read and write",`,
    '     "Pull requests: Read and write" and "Workflows: Read and write", set to No expiration,',
    "     and store it in the GITHUB_TOKEN secret.",
    `  2. GitHub App: install an app on ${repo} with those same three permissions, then store its`,
    `     app id in ${APP_ID_ENV} and its .pem private key in ${APP_KEY_ENV}.`,
    "     This script mints a fresh one-hour installation token on every run.",
  ];
}

/** Resolves credentials on demand and remembers what it already looked up. */
export class CredentialPool {
  private readonly cache = new Map<TokenSource, Credential | null>();

  constructor(private readonly repo: string) {}

  private async load(source: TokenSource): Promise<Credential | null> {
    if (!this.cache.has(source)) {
      const credential =
        source === "replit-connector"
          ? await connectorCredential()
          : source === "github-app"
            ? await appCredential(this.repo)
            : await storedTokenCredential();
      this.cache.set(source, credential);
    }
    return this.cache.get(source) ?? null;
  }

  /**
   * The credential used for reads, fetches and ordinary pushes. The connector
   * comes first because it refreshes itself and stores nothing. A source that
   * is misconfigured or rejected is reported and skipped, so one bad secret
   * cannot stop a sync another credential could still do.
   */
  async base(): Promise<Credential> {
    const order: TokenSource[] = [
      "replit-connector",
      "github-app",
      "GITHUB_TOKEN",
    ];
    const problems: string[] = [];

    for (const source of order) {
      try {
        const credential = await this.load(source);
        if (credential) {
          return credential;
        }
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new SyncError(
      [
        "No GitHub credential available.",
        "Expected the Replit GitHub connector to be connected for this workspace.",
        ...(problems.length > 0
          ? [
              "",
              "Credentials that were configured but unusable:",
              ...problems.flatMap((problem) =>
                problem.split("\n").map((line) => `  ${line}`),
              ),
              "",
            ]
          : []),
        "Reconnect the connector from the Integrations pane, or configure one of these:",
        ...workflowSetupHelp(this.repo),
      ].join("\n"),
    );
  }

  /** The credential to push with when the diff touches `.github/workflows/`. */
  async forWorkflows(
    base: Credential,
    workflowPaths: string[],
  ): Promise<Credential> {
    if (base.workflows === "yes") {
      return base;
    }

    const order: TokenSource[] = [
      "github-app",
      "GITHUB_TOKEN",
      "replit-connector",
    ];
    const candidates: Credential[] = [];
    const problems: string[] = [];

    for (const source of order) {
      try {
        const credential = await this.load(source);
        if (credential) {
          candidates.push(credential);
        }
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }

    const chosen =
      candidates.find((candidate) => candidate.workflows === "yes") ??
      candidates.find((candidate) => candidate.workflows === "unknown");

    if (chosen) {
      return chosen;
    }

    throw new SyncError(
      [
        "This sync changes GitHub Actions workflow files:",
        ...workflowPaths.map((path) => `  ${path}`),
        "",
        "No available credential can write them:",
        ...candidates.map(
          (candidate) =>
            `  ${describeCredential(candidate)} — no workflow access`,
        ),
        ...problems.flatMap((problem) =>
          problem.split("\n").map((line) => `  ${line}`),
        ),
        "",
        ...workflowSetupHelp(this.repo),
      ].join("\n"),
    );
  }
}

/**
 * Single credential for routines that only read (the drift check). It walks the
 * same sources in the same order as a sync, so an App-only setup can still run
 * the live comparison.
 */
export async function resolveCredential(repo: string): Promise<Credential> {
  return new CredentialPool(repo).base();
}

export async function github<T>(
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
