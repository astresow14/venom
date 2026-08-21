/**
 * The credential rules that decide which secret carries a sync to GitHub.
 *
 * A wrong pick here stays invisible until GitHub refuses a CI change after a
 * merge, so every selection rule is pinned down against fakes. No test in this
 * file may reach the network: the fetch installed for each test refuses any
 * request the test did not explicitly allow, and the file fails if one slips
 * through.
 */

import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";

import { SyncError } from "./git";
import {
  APP_ID_ENV,
  APP_INSTALLATION_ENV,
  APP_KEY_ENV,
  appJwt,
  CredentialPool,
  GITHUB_API,
  normalizePrivateKey,
} from "./github";

const REPO = "astresow14/venom";
const WORKFLOW_CHANGE = [".github/workflows/ci.yml"];

/** Real RSA keys, generated fresh per run so no key material sits in the repo. */
function rsaKeyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privatePem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const APP_KEY = rsaKeyPair();
const OTHER_KEY = rsaKeyPair();

/** PEM banners assembled at runtime, so this file never reads as key material. */
const BEGIN_BANNER = `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`;
const END_BANNER = `${"-".repeat(5)}END RSA PRIVATE KEY${"-".repeat(5)}`;
/** Structurally a PEM, but its body decodes to bytes that are not a key. */
const MANGLED_PEM = `${BEGIN_BANNER}\nbm90IGEga2V5\n${END_BANNER}`;

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

interface Route {
  method: string;
  url: string;
  matches?: (request: RecordedRequest) => boolean;
  reply: (request: RecordedRequest) => {
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
}

/** Every variable the pool reads; cleared per test so the real repl leaks nothing in. */
const CREDENTIAL_ENV = [
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
  APP_ID_ENV,
  APP_KEY_ENV,
  APP_INSTALLATION_ENV,
  "GITHUB_TOKEN",
] as const;

let savedEnv: Array<[string, string | undefined]>;
let savedFetch: typeof globalThis.fetch;
let routes: Route[];
let requests: RecordedRequest[];
let unexpected: string[];

beforeEach(() => {
  savedEnv = CREDENTIAL_ENV.map((key) => [key, process.env[key]]);
  for (const key of CREDENTIAL_ENV) {
    delete process.env[key];
  }

  routes = [];
  requests = [];
  unexpected = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      method,
      url,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    };
    requests.push(request);

    const route = routes.find(
      (candidate) =>
        candidate.method === method &&
        candidate.url === url &&
        (candidate.matches?.(request) ?? true),
    );
    if (!route) {
      unexpected.push(`${method} ${url}`);
      throw new Error(`This test allows no request to ${method} ${url}`);
    }

    const reply = route.reply(request);
    return new Response(
      reply.body === undefined ? "" : JSON.stringify(reply.body),
      { status: reply.status, headers: reply.headers },
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  assert.deepEqual(unexpected, [], "no test in this file may reach the network");
});

const CONNECTOR_HOST = "connectors.test.invalid";
const CONNECTOR_URL = `https://${CONNECTOR_HOST}/api/v2/connection?include_secrets=true&connector_names=github`;

/** The Replit connector, holding the given OAuth token. */
function stubConnector(token: string): void {
  process.env.REPLIT_CONNECTORS_HOSTNAME = CONNECTOR_HOST;
  process.env.REPL_IDENTITY = "test-identity";
  routes.push({
    method: "GET",
    url: CONNECTOR_URL,
    reply: () => ({
      status: 200,
      body: { items: [{ settings: { access_token: token } }] },
    }),
  });
}

/** GitHub's `/user` answer for this exact token; any other bearer stays refused. */
function stubUser(
  token: string,
  reply: { status?: number; headers?: Record<string, string> } = {},
): void {
  const status = reply.status ?? 200;
  routes.push({
    method: "GET",
    url: `${GITHUB_API}/user`,
    matches: (request) => request.authorization === `Bearer ${token}`,
    reply: () => ({
      status,
      headers: reply.headers,
      body: status === 200 ? {} : { message: "Bad credentials" },
    }),
  });
}

/** True when the request carries a JWT that verifies against the app's public key. */
function signedByAppKey(request: RecordedRequest): boolean {
  const token = request.authorization?.replace(/^Bearer /, "") ?? "";
  const segments = token.split(".");
  if (segments.length !== 3) {
    return false;
  }
  return createVerify("RSA-SHA256")
    .update(`${segments[0]}.${segments[1]}`)
    .verify(APP_KEY.publicPem, segments[2], "base64url");
}

/**
 * A GitHub App installation that mints tokens only for a JWT it can verify,
 * exactly as GitHub would. A JWT signed with the wrong key gets a 401, so a
 * broken signature fails the selection instead of passing unnoticed.
 */
function stubAppInstallation(options: {
  installationId: number;
  discoverable: boolean;
  permissions: Record<string, string>;
}): void {
  if (options.discoverable) {
    routes.push({
      method: "GET",
      url: `${GITHUB_API}/repos/${REPO}/installation`,
      reply: (request) =>
        signedByAppKey(request)
          ? { status: 200, body: { id: options.installationId } }
          : { status: 401, body: { message: "JWT signature does not verify" } },
    });
  }
  routes.push({
    method: "POST",
    url: `${GITHUB_API}/app/installations/${options.installationId}/access_tokens`,
    reply: (request) =>
      signedByAppKey(request)
        ? {
            status: 201,
            body: {
              token: "ghs_minted-installation-token",
              expires_at: "2026-08-21T23:59:00Z",
              permissions: options.permissions,
            },
          }
        : { status: 401, body: { message: "JWT signature does not verify" } },
  });
}

test("a private key is accepted as raw PEM, escaped newlines, or base64", () => {
  const pem = APP_KEY.privatePem.trim();

  assert.equal(normalizePrivateKey(`\n${APP_KEY.privatePem}\n`), pem);
  assert.equal(normalizePrivateKey(pem.replace(/\n/g, "\\n")), pem);
  assert.equal(
    normalizePrivateKey(Buffer.from(APP_KEY.privatePem, "utf8").toString("base64")),
    pem,
  );
});

test("a key fingerprint is named for what it is instead of failing to sign", () => {
  assert.throws(
    () => normalizePrivateKey("SHA256:tHiSiSoNlYaChEcKsUmOfAkEyNoTaKeY0000000000A="),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.match(error.message, /fingerprint/);
      assert.match(error.message, new RegExp(APP_KEY_ENV));
      return true;
    },
  );
});

test("text that is a key in no form is refused with the secret's name", () => {
  assert.throws(
    () => normalizePrivateKey("definitely not a private key"),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.match(error.message, /not a PEM private key/);
      assert.match(error.message, new RegExp(APP_KEY_ENV));
      return true;
    },
  );
});

test("the app JWT carries the app's claims and verifies only with the matching key", () => {
  const before = Math.floor(Date.now() / 1000);
  const jwt = appJwt("314159", APP_KEY.privatePem);
  const after = Math.floor(Date.now() / 1000);

  // Three base64url segments; GitHub rejects padded or non-url alphabets.
  assert.match(jwt, /^[\w-]+\.[\w-]+\.[\w-]+$/);

  const [header, payload, signature] = jwt.split(".");
  const decode = (segment: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;

  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });

  const claims = decode(payload) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, "314159");
  assert.equal(claims.exp - claims.iat, 540);
  assert.ok(
    claims.iat >= before - 60 && claims.iat <= after - 60,
    "iat is backdated a minute to absorb clock skew",
  );

  const verifies = (publicPem: string, signed: string, sig: string): boolean =>
    createVerify("RSA-SHA256").update(signed).verify(publicPem, sig, "base64url");

  assert.equal(verifies(APP_KEY.publicPem, `${header}.${payload}`, signature), true);
  assert.equal(verifies(OTHER_KEY.publicPem, `${header}.${payload}`, signature), false);

  // A signature must not survive a payload swap.
  const [, otherPayload] = appJwt("999999", APP_KEY.privatePem).split(".");
  assert.equal(
    verifies(APP_KEY.publicPem, `${header}.${otherPayload}`, signature),
    false,
  );
});

test("a PEM whose body is not a key fails as a sync error naming the secret", () => {
  assert.throws(
    () => appJwt("314159", MANGLED_PEM),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.match(error.message, /Could not sign a GitHub App JWT/);
      assert.match(error.message, new RegExp(APP_KEY_ENV));
      return true;
    },
  );
});

test("connector-only: ordinary syncs ride the connector", async () => {
  stubConnector("gho_connector-token");
  stubUser("gho_connector-token", {
    headers: { "x-oauth-scopes": "repo, read:org" },
  });

  const credential = await new CredentialPool(REPO).base();

  assert.equal(credential.source, "replit-connector");
  assert.equal(credential.token, "gho_connector-token");
  assert.equal(credential.workflows, "no");
});

test("connector-only: a workflow change is refused loudly, never pushed to fail", async () => {
  stubConnector("gho_connector-token");
  stubUser("gho_connector-token", { headers: { "x-oauth-scopes": "repo" } });

  const pool = new CredentialPool(REPO);
  const base = await pool.base();

  await assert.rejects(
    pool.forWorkflows(base, WORKFLOW_CHANGE),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.match(error.message, /\.github\/workflows\/ci\.yml/);
      assert.match(error.message, /No available credential can write them/);
      assert.match(error.message, /replit-connector — no workflow access/);
      // The refusal teaches both permanent setups instead of dead-ending.
      assert.match(error.message, new RegExp(APP_ID_ENV));
      assert.match(error.message, /GITHUB_TOKEN secret/);
      return true;
    },
  );
});

test("a connector that can write workflows is kept for the workflow push", async () => {
  stubConnector("gho_connector-token");
  stubUser("gho_connector-token", {
    headers: { "x-oauth-scopes": "repo, workflow" },
  });

  const pool = new CredentialPool(REPO);
  const base = await pool.base();

  assert.equal(base.workflows, "yes");
  assert.equal(await pool.forWorkflows(base, WORKFLOW_CHANGE), base);
});

test("stored-token-only: a classic token with the workflow scope does everything", async () => {
  process.env.GITHUB_TOKEN = "ghp_stored-classic";
  stubUser("ghp_stored-classic", {
    headers: {
      "x-oauth-scopes": "repo, workflow",
      "github-authentication-token-expiration": "2026-11-30 08:00:00 UTC",
    },
  });

  const pool = new CredentialPool(REPO);
  const credential = await pool.base();

  assert.equal(credential.source, "GITHUB_TOKEN");
  assert.equal(credential.workflows, "yes");
  assert.equal(credential.expiresAt?.toISOString(), "2026-11-30T08:00:00.000Z");
  assert.equal(credential.detail, "expires 2026-11-30");
  assert.equal(await pool.forWorkflows(credential, WORKFLOW_CHANGE), credential);
});

test("stored-token-only: a fine-grained token reports no scopes and is still tried", async () => {
  process.env.GITHUB_TOKEN = "github_pat_fine-grained";
  stubUser("github_pat_fine-grained");

  const pool = new CredentialPool(REPO);
  const credential = await pool.base();

  assert.equal(credential.source, "GITHUB_TOKEN");
  assert.equal(credential.scopes, null);
  // Fine-grained tokens reveal workflow access only at push time, so the
  // selection must still put one forward rather than refusing.
  assert.equal(credential.workflows, "unknown");
  assert.equal(credential.detail, "no expiry reported");
  assert.equal(await pool.forWorkflows(credential, WORKFLOW_CHANGE), credential);
});

test("app-configured: the workflow push switches to a minted installation token", async () => {
  stubConnector("gho_connector-token");
  stubUser("gho_connector-token", { headers: { "x-oauth-scopes": "repo" } });
  process.env[APP_ID_ENV] = "271828";
  // The base64 form, to prove the whole flow accepts it, not just the normalizer.
  process.env[APP_KEY_ENV] = Buffer.from(APP_KEY.privatePem, "utf8").toString(
    "base64",
  );
  stubAppInstallation({
    installationId: 4242,
    discoverable: true,
    permissions: { contents: "write", pull_requests: "write", workflows: "write" },
  });

  const pool = new CredentialPool(REPO);
  const base = await pool.base();
  assert.equal(base.source, "replit-connector");

  const chosen = await pool.forWorkflows(base, WORKFLOW_CHANGE);

  assert.equal(chosen.source, "github-app");
  assert.equal(chosen.token, "ghs_minted-installation-token");
  assert.equal(chosen.workflows, "yes");
  assert.equal(chosen.detail, "app 271828, installation 4242");

  // The mint was scoped to this one repository.
  const mint = requests.find((request) => request.url.endsWith("/access_tokens"));
  assert.deepEqual(mint?.body, { repositories: ["venom"] });

  // The pool remembers lookups: one connector exchange, one token inspection.
  assert.equal(requests.filter((request) => request.url === CONNECTOR_URL).length, 1);
  assert.equal(
    requests.filter((request) => request.url === `${GITHUB_API}/user`).length,
    1,
  );
});

test("app-configured alone: the app carries the sync with no lookup round trip", async () => {
  process.env[APP_ID_ENV] = "271828";
  process.env[APP_KEY_ENV] = APP_KEY.privatePem;
  process.env[APP_INSTALLATION_ENV] = "777";
  stubAppInstallation({
    installationId: 777,
    discoverable: false,
    permissions: { contents: "write", workflows: "write" },
  });

  const credential = await new CredentialPool(REPO).base();

  assert.equal(credential.source, "github-app");
  assert.equal(credential.workflows, "yes");
  assert.equal(credential.expiresAt?.toISOString(), "2026-08-21T23:59:00.000Z");
  // The pinned installation id spares the discovery call entirely.
  assert.deepEqual(requests.map((request) => request.method), ["POST"]);
});

test("an app installation without workflow permission is never picked for CI changes", async () => {
  process.env[APP_ID_ENV] = "271828";
  process.env[APP_KEY_ENV] = APP_KEY.privatePem;
  process.env[APP_INSTALLATION_ENV] = "777";
  stubAppInstallation({
    installationId: 777,
    discoverable: false,
    permissions: { contents: "write" },
  });

  const pool = new CredentialPool(REPO);
  const base = await pool.base();
  assert.equal(base.source, "github-app");
  assert.equal(base.workflows, "no");

  await assert.rejects(
    pool.forWorkflows(base, WORKFLOW_CHANGE),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.match(
        error.message,
        /github-app \(app 271828, installation 777\) — no workflow access/,
      );
      return true;
    },
  );
});

test("half-configured app alone: the sync stops with directions, not a guess", async () => {
  process.env[APP_ID_ENV] = "271828";

  await assert.rejects(new CredentialPool(REPO).base(), (error: unknown) => {
    assert.ok(error instanceof SyncError);
    assert.match(error.message, /No GitHub credential available/);
    assert.match(error.message, /half-configured/);
    assert.match(error.message, new RegExp(`${APP_ID_ENV} and ${APP_KEY_ENV}`));
    return true;
  });
});

test("half-configured app: another credential still syncs, and the workflow refusal names the problem", async () => {
  process.env[APP_ID_ENV] = "271828";
  process.env.GITHUB_TOKEN = "ghp_stored-classic";
  stubUser("ghp_stored-classic", { headers: { "x-oauth-scopes": "repo" } });

  const pool = new CredentialPool(REPO);
  const base = await pool.base();
  // One broken secret must not stop a sync another credential can still do.
  assert.equal(base.source, "GITHUB_TOKEN");

  await assert.rejects(
    pool.forWorkflows(base, WORKFLOW_CHANGE),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.match(
        error.message,
        /GITHUB_TOKEN \(no expiry reported\) — no workflow access/,
      );
      assert.match(error.message, /half-configured/);
      return true;
    },
  );
});

test("an unparseable app key is reported by name, and no request is ever made", async () => {
  process.env[APP_ID_ENV] = "271828";
  process.env[APP_KEY_ENV] = "definitely not a private key";

  await assert.rejects(new CredentialPool(REPO).base(), (error: unknown) => {
    assert.ok(error instanceof SyncError);
    assert.match(error.message, /No GitHub credential available/);
    assert.match(error.message, /not a PEM private key/);
    return true;
  });
  assert.deepEqual(requests, []);
});

test("a client id in the app id slot is caught before any signing", async () => {
  process.env[APP_ID_ENV] = "Iv1.not-an-app-id";
  process.env[APP_KEY_ENV] = APP_KEY.privatePem;

  await assert.rejects(new CredentialPool(REPO).base(), (error: unknown) => {
    assert.ok(error instanceof SyncError);
    assert.match(error.message, /numeric App ID/);
    return true;
  });
  assert.deepEqual(requests, []);
});

test("no credential at all: the error teaches every permanent setup", async () => {
  await assert.rejects(new CredentialPool(REPO).base(), (error: unknown) => {
    assert.ok(error instanceof SyncError);
    assert.match(error.message, /No GitHub credential available/);
    assert.match(error.message, /Fine-grained token/);
    assert.match(error.message, /GitHub App/);
    return true;
  });
});

test("a rejected connector token is skipped, not fatal, when a stored token works", async () => {
  stubConnector("gho_revoked-connector");
  stubUser("gho_revoked-connector", { status: 401 });
  process.env.GITHUB_TOKEN = "ghp_backup";
  stubUser("ghp_backup", { headers: { "x-oauth-scopes": "repo, workflow" } });

  const credential = await new CredentialPool(REPO).base();

  assert.equal(credential.source, "GITHUB_TOKEN");
  assert.ok(
    requests.some((request) => request.url === CONNECTOR_URL),
    "the connector was tried first",
  );
});
