import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import express from "express";
import {
  createGitHubRequest,
  createVenomSourcesRouter,
  createWebsiteFetcher,
  MAX_WEBSITE_BYTES,
  type ConnectorProxy,
  type GitHubRequest,
  type HttpsRequestFn,
  type WebsiteFetcher,
} from "./venom-sources-router";
import {
  authorizeAttestedCitationIds,
  createSourceAttestation,
} from "../lib/source-attestations";

process.env.SOURCE_ATTESTATION_SECRET =
  process.env.SOURCE_ATTESTATION_SECRET ?? "venom-source-router-test-secret";

const MEMBER_USER_ID = "user_workspaceMember";
const OUTSIDE_USER_ID = "user_outsider";
const PUBLIC_ADDRESS = "93.184.216.34";

/** `fetch` responses are typed as `unknown`; tests assert on the parsed body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(response: Response): Promise<any> {
  return await response.json();
}

type ConnectorRoutes = Record<string, unknown>;

type WebsitePlan = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Array<string | Buffer>;
};

type ServerHarness = {
  baseUrl: string;
  githubPaths: string[];
  websiteRequests: Array<{ hostname?: string; host?: string; path?: string }>;
};

/** Records every connector path and answers from a fixture table. */
function connectorProxy(routes: ConnectorRoutes, calls: string[]): ConnectorProxy {
  return async (connector, path) => {
    assert.equal(connector, "github");
    calls.push(path);
    const payload = routes[path];
    if (payload === undefined) {
      return {
        ok: false,
        status: 404,
        text: async () => "Not Found",
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
}

/**
 * Drives `createWebsiteFetcher` without opening a socket so the real
 * redirect, size, and content-type handling is exercised.
 */
function fakeHttpsRequest(
  plans: WebsitePlan[],
  requests: ServerHarness["websiteRequests"],
): HttpsRequestFn {
  let attempt = 0;
  return (options, callback) => {
    const plan = plans[Math.min(attempt, plans.length - 1)] ?? {};
    attempt += 1;
    requests.push({
      hostname: String(options.hostname ?? ""),
      host: String(
        (options.headers as Record<string, string> | undefined)?.Host ?? "",
      ),
      path: String(options.path ?? ""),
    });

    const errorListeners: Array<(error: Error) => void> = [];
    const clientRequest = {
      setTimeout: () => clientRequest,
      on: (event: string, listener: (error: Error) => void) => {
        if (event === "error") errorListeners.push(listener);
        return clientRequest;
      },
      destroy: (error?: Error) => {
        if (error) for (const listener of errorListeners) listener(error);
        return clientRequest;
      },
      end: () => {
        setImmediate(() => {
          const response = new PassThrough() as PassThrough & {
            statusCode?: number;
            headers: Record<string, string>;
          };
          response.statusCode = plan.status ?? 200;
          response.headers = plan.headers ?? { "content-type": "text/html" };
          callback(response);
          for (const chunk of plan.chunks ?? []) {
            response.write(Buffer.from(chunk));
          }
          response.end();
        });
        return clientRequest;
      },
    };
    return clientRequest;
  };
}

async function withSourcesServer(
  {
    connectorRoutes = {},
    githubRequest,
    addresses = [{ address: PUBLIC_ADDRESS }],
    resolveAddresses,
    websitePlans = [],
    fetchWebsite,
  }: {
    connectorRoutes?: ConnectorRoutes;
    githubRequest?: GitHubRequest;
    addresses?: Array<{ address: string }>;
    resolveAddresses?: () => Promise<Array<{ address: string }>>;
    websitePlans?: WebsitePlan[];
    fetchWebsite?: WebsiteFetcher;
  },
  run: (harness: ServerHarness) => Promise<void>,
) {
  const githubPaths: string[] = [];
  const websiteRequests: ServerHarness["websiteRequests"] = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createVenomSourcesRouter({
      resolveUserId: (request) => request.header("x-test-user") || null,
      isWorkspaceMember: (userId) => userId === MEMBER_USER_ID,
      githubRequest:
        githubRequest ?? createGitHubRequest(connectorProxy(connectorRoutes, githubPaths)),
      resolveAddresses: resolveAddresses ?? (async () => addresses),
      fetchWebsite:
        fetchWebsite ??
        createWebsiteFetcher(fakeHttpsRequest(websitePlans, websiteRequests)),
      createAttestation: (input) => createSourceAttestation(input),
    }),
  );

  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/api`,
      githubPaths,
      websiteRequests,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
}

function repositoryFixtures() {
  return {
    "/user/repos?sort=pushed&per_page=100": [
      {
        name: "venom",
        full_name: "acme/venom",
        html_url: "https://github.com/acme/venom",
        description: "Mobile intelligence workspace",
        updated_at: "2026-08-01T10:00:00.000Z",
      },
      {
        // Missing html_url: the connector record is unusable for the client.
        name: "ghost",
        full_name: "acme/ghost",
        description: "Half-synced repository",
      },
      {
        name: "symbiote",
        full_name: "acme/symbiote",
        html_url: "https://github.com/acme/symbiote",
        description: null,
        updated_at: "2026-07-30T08:30:00.000Z",
      },
    ],
  };
}

function repositorySyncFixtures() {
  return {
    "/repos/acme/venom": {
      name: "venom",
      full_name: "acme/venom",
      html_url: "https://github.com/acme/venom",
      description: "Mobile intelligence workspace",
      open_issues_count: 7,
    },
    "/repos/acme/venom/issues?state=open&per_page=20": [
      {
        number: 12,
        title: "Sources drop after reconnect",
        body: "Reconnecting a repository clears its citations.",
        html_url: "https://github.com/acme/venom/issues/12",
      },
      {
        // GitHub returns pull requests inside the issues collection.
        number: 13,
        title: "Add citation filter",
        body: "Pull request masquerading as an issue",
        html_url: "https://github.com/acme/venom/pull/13",
        pull_request: { url: "https://api.github.com/repos/acme/venom/pulls/13" },
      },
    ],
    "/repos/acme/venom/pulls?state=open&per_page=10": [
      {
        number: 13,
        title: "Add citation filter",
        body: "Filters unattested citation markers out of the stream.",
        html_url: "https://github.com/acme/venom/pull/13",
      },
    ],
  };
}

function connectGitHub(
  baseUrl: string,
  repository: string,
  user: string | null = MEMBER_USER_ID,
) {
  return fetch(`${baseUrl}/venom/projects/project-1/sources/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
    },
    body: JSON.stringify({ repository }),
  });
}

function connectWebsite(
  baseUrl: string,
  url: string,
  user: string | null = MEMBER_USER_ID,
  name?: string,
) {
  return fetch(`${baseUrl}/venom/projects/project-1/sources/website`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
    },
    body: JSON.stringify(name ? { url, name } : { url }),
  });
}

// ─── GitHub repository discovery ──────────────────────────────────────────────

test("lists connected repositories and drops incomplete connector records", async () => {
  await withSourcesServer(
    { connectorRoutes: repositoryFixtures() },
    async ({ baseUrl, githubPaths }) => {
      const response = await fetch(`${baseUrl}/venom/github/repositories`, {
        headers: { "x-test-user": MEMBER_USER_ID },
      });

      assert.equal(response.status, 200);
      const repositories = await readJson(response);
      assert.deepEqual(
        repositories.map((repository: { fullName: string }) => repository.fullName),
        ["acme/venom", "acme/symbiote"],
      );
      assert.equal(repositories[0].url, "https://github.com/acme/venom");
      assert.equal(repositories[0].description, "Mobile intelligence workspace");
      assert.equal(repositories[1].description, null);
      assert.deepEqual(githubPaths, ["/user/repos?sort=pushed&per_page=100"]);
    },
  );
});

test("keeps the workspace connector away from unauthorized accounts", async () => {
  await withSourcesServer(
    { connectorRoutes: repositoryFixtures() },
    async ({ baseUrl, githubPaths }) => {
      const anonymous = await fetch(`${baseUrl}/venom/github/repositories`);
      assert.equal(anonymous.status, 401);

      const outsider = await fetch(`${baseUrl}/venom/github/repositories`, {
        headers: { "x-test-user": OUTSIDE_USER_ID },
      });
      assert.equal(outsider.status, 403);
      assert.match((await readJson(outsider)).error, /not authorized/i);

      const sync = await connectGitHub(baseUrl, "acme/venom", OUTSIDE_USER_ID);
      assert.equal(sync.status, 403);

      // No connector traffic may leave the server for these requests.
      assert.deepEqual(githubPaths, []);
    },
  );
});

test("surfaces connector failures with their status and message", async () => {
  const proxy: ConnectorProxy = async () => ({
    ok: false,
    status: 502,
    text: async () => "GitHub connector is not reachable",
    json: async () => ({}),
  });

  await withSourcesServer(
    { githubRequest: createGitHubRequest(proxy) },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/venom/github/repositories`, {
        headers: { "x-test-user": MEMBER_USER_ID },
      });

      assert.equal(response.status, 502);
      assert.equal(
        (await readJson(response)).error,
        "GitHub connector is not reachable",
      );
    },
  );
});

test("reports unexpected connector payloads instead of forwarding them", async () => {
  await withSourcesServer(
    {
      githubRequest: (async () => [{ full_name: 5, name: 5, html_url: 5 }]) as GitHubRequest,
    },
    async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/venom/github/repositories`, {
        headers: { "x-test-user": MEMBER_USER_ID },
      });

      assert.equal(response.status, 502);
      assert.equal((await readJson(response)).error, "GitHub returned unexpected data");
    },
  );
});

// ─── GitHub source synchronization ────────────────────────────────────────────

test("synchronizes a repository into citations and clusters", async () => {
  await withSourcesServer(
    { connectorRoutes: repositorySyncFixtures() },
    async ({ baseUrl, githubPaths }) => {
      const response = await connectGitHub(baseUrl, "acme/venom");
      assert.equal(response.status, 200);
      const source = await readJson(response);

      assert.deepEqual(githubPaths, [
        "/repos/acme/venom",
        "/repos/acme/venom/issues?state=open&per_page=20",
        "/repos/acme/venom/pulls?state=open&per_page=10",
      ]);

      assert.equal(source.provider, "github");
      assert.equal(source.projectId, "project-1");
      assert.equal(source.name, "acme/venom");
      assert.equal(source.status, "connected");
      assert.match(source.summary, /7 open items/);
      assert.match(source.summary, /1 active pull requests/);

      const kinds = source.citations.map(
        (citation: { kind: string }) => citation.kind,
      );
      // The pull request returned inside the issues collection is not an issue.
      assert.deepEqual(kinds, ["repository", "issue", "pull_request"]);
      assert.equal(
        source.citations[1].title,
        "#12 Sources drop after reconnect",
      );
      assert.equal(source.citations[1].reference, "acme/venom#12");

      assert.deepEqual(
        source.clusters.map((cluster: { label: string }) => cluster.label),
        ["acme/venom", "1 open issues", "1 open pull requests"],
      );
      for (const citation of source.citations) {
        assert.ok(
          source.context.includes(`[source:${citation.id}]`),
          `context is missing a marker for ${citation.id}`,
        );
      }
    },
  );
});

test("connects the same repository to a stable source identity", async () => {
  await withSourcesServer(
    { connectorRoutes: repositorySyncFixtures() },
    async ({ baseUrl }) => {
      const first = await readJson(await connectGitHub(baseUrl, "acme/venom"));
      const second = await readJson(await connectGitHub(baseUrl, "acme/venom"));

      assert.equal(first.id, second.id);
      assert.deepEqual(
        first.citations.map((citation: { id: string }) => citation.id),
        second.citations.map((citation: { id: string }) => citation.id),
      );
    },
  );
});

test("attests a synchronized source so chat can cite it", async () => {
  await withSourcesServer(
    { connectorRoutes: repositorySyncFixtures() },
    async ({ baseUrl }) => {
      const source = await readJson(await connectGitHub(baseUrl, "acme/venom"));
      const snapshot = {
        id: source.id,
        context: source.context,
        citations: source.citations,
        attestation: source.attestation,
      };
      const citationIds = source.citations.map(
        (citation: { id: string }) => citation.id,
      );

      const authorized = authorizeAttestedCitationIds({
        userId: MEMBER_USER_ID,
        projectId: "project-1",
        projectContext: source.context,
        requestedCitationIds: citationIds,
        sourceSnapshots: [snapshot],
      });
      assert.deepEqual([...authorized].sort(), [...citationIds].sort());

      // The same snapshot must not authorize another account's chat request.
      const stolen = authorizeAttestedCitationIds({
        userId: OUTSIDE_USER_ID,
        projectId: "project-1",
        projectContext: source.context,
        requestedCitationIds: citationIds,
        sourceSnapshots: [snapshot],
      });
      assert.equal(stolen.size, 0);
    },
  );
});

test("rejects repository identifiers that are not owner/name", async () => {
  await withSourcesServer(
    { connectorRoutes: repositorySyncFixtures() },
    async ({ baseUrl, githubPaths }) => {
      for (const repository of [
        "../../etc/passwd",
        "acme/venom/extra",
        "acme venom",
        "acme/venom?state=all",
      ]) {
        const response = await connectGitHub(baseUrl, repository);
        assert.equal(response.status, 400, repository);
        assert.equal(
          (await readJson(response)).error,
          "Invalid repository identifier",
          repository,
        );
      }

      assert.deepEqual(githubPaths, []);
    },
  );
});

test("passes a missing repository through as a connector failure", async () => {
  await withSourcesServer(
    { connectorRoutes: {} },
    async ({ baseUrl }) => {
      const response = await connectGitHub(baseUrl, "acme/missing");
      assert.equal(response.status, 404);
      assert.equal((await readJson(response)).error, "Not Found");
    },
  );
});

// ─── Website sources ──────────────────────────────────────────────────────────

const WEBSITE_HTML = `<!doctype html><html><head><title>Symbiote Field Notes</title>
<script>window.tracking = true;</script></head>
<body><h1>Symbiote research</h1><p>Symbiote research covers symbiote bonding,
symbiote containment, and containment drills for containment teams.</p></body></html>`;

test("accepts a public HTML website and pins the fetch to its resolved address", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          chunks: [WEBSITE_HTML],
        },
      ],
    },
    async ({ baseUrl, websiteRequests }) => {
      const response = await connectWebsite(
        baseUrl,
        "https://research.example.com/notes?page=2",
      );

      assert.equal(response.status, 200);
      const source = await readJson(response);
      assert.equal(source.provider, "website");
      assert.equal(source.name, "Symbiote Field Notes");
      assert.equal(source.url, "https://research.example.com/notes?page=2");
      assert.equal(source.citations.length, 1);
      assert.equal(source.citations[0].kind, "website");
      assert.ok(
        source.context.includes(`[source:${source.citations[0].id}]`),
        "website context is missing its citation marker",
      );
      // Script contents never become part of the excerpt.
      assert.ok(!source.citations[0].excerpt.includes("window.tracking"));
      assert.ok(source.clusters.length > 1, "expected topic clusters");
      assert.ok(source.attestation, "expected a signed attestation");

      assert.deepEqual(websiteRequests, [
        {
          hostname: PUBLIC_ADDRESS,
          host: "research.example.com",
          path: "/notes?page=2",
        },
      ]);
    },
  );
});

test("prefers an explicit source name over the document title", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 200,
          headers: { "content-type": "text/html" },
          chunks: [WEBSITE_HTML],
        },
      ],
    },
    async ({ baseUrl }) => {
      const source = await readJson(await connectWebsite(
          baseUrl,
          "https://research.example.com/",
          MEMBER_USER_ID,
          "Field research",
        ));

      assert.equal(source.name, "Field research");
    },
  );
});

test("never follows a website redirect on its own", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 302,
          headers: {
            "content-type": "text/html",
            location: "http://169.254.169.254/latest/meta-data/",
          },
          chunks: ["<html><body>Moved</body></html>"],
        },
        {
          status: 200,
          headers: { "content-type": "text/html" },
          chunks: ["<html><title>Metadata</title></html>"],
        },
      ],
    },
    async ({ baseUrl, websiteRequests }) => {
      const response = await connectWebsite(
        baseUrl,
        "https://research.example.com/redirect",
      );

      assert.equal(response.status, 422);
      assert.equal(
        (await readJson(response)).error,
        "Website returned an unexpected response (302).",
      );
      // Exactly one request: the redirect target is never contacted.
      assert.equal(websiteRequests.length, 1);
      assert.equal(websiteRequests[0].hostname, PUBLIC_ADDRESS);
    },
  );
});

test("rejects a website that declares more bytes than the limit", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "content-length": String(MAX_WEBSITE_BYTES + 1),
          },
          chunks: [WEBSITE_HTML],
        },
      ],
    },
    async ({ baseUrl }) => {
      const response = await connectWebsite(baseUrl, "https://huge.example.com/");

      assert.equal(response.status, 422);
      assert.equal(
        (await readJson(response)).error,
        "This website is too large to add as a source.",
      );
    },
  );
});

test("stops reading a website that streams past the limit", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 200,
          headers: { "content-type": "text/html" },
          chunks: [
            Buffer.alloc(MAX_WEBSITE_BYTES - 10, "a"),
            Buffer.alloc(1_000, "b"),
          ],
        },
      ],
    },
    async ({ baseUrl }) => {
      const response = await connectWebsite(
        baseUrl,
        "https://streaming.example.com/",
      );

      assert.equal(response.status, 422);
      assert.equal(
        (await readJson(response)).error,
        "This website is too large to add as a source.",
      );
    },
  );
});

test("rejects hostnames that resolve into private address space", async () => {
  for (const addresses of [
    [{ address: "169.254.169.254" }],
    [{ address: "127.0.0.1" }],
    [{ address: "10.1.2.3" }],
    [{ address: "::1" }],
    // DNS rebinding: one public answer is not enough.
    [{ address: PUBLIC_ADDRESS }, { address: "192.168.1.10" }],
    [],
  ]) {
    await withSourcesServer({ addresses }, async ({ baseUrl, websiteRequests }) => {
      const response = await connectWebsite(
        baseUrl,
        "https://metadata.example.com/",
      );

      assert.equal(response.status, 400, JSON.stringify(addresses));
      assert.equal(
        (await readJson(response)).error,
        "This website address is not publicly reachable.",
      );
      assert.equal(websiteRequests.length, 0, "no fetch may be attempted");
    });
  }
});

test("rejects URLs that cannot be a public HTTPS website", async () => {
  await withSourcesServer({}, async ({ baseUrl, websiteRequests }) => {
    for (const url of [
      "http://research.example.com/",
      "https://localhost/",
      "https://admin.localhost/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://user:secret@research.example.com/",
      "https://research.example.com:8443/",
      "file:///etc/passwd",
      "not-a-url",
    ]) {
      const response = await connectWebsite(baseUrl, url);
      assert.equal(response.status, 400, url);
      assert.match(
        (await readJson(response)).error,
        /public HTTPS websites|valid HTTPS website URL/,
        url,
      );
    }

    assert.equal(websiteRequests.length, 0, "no fetch may be attempted");
  });
});

test("reports domains that cannot be resolved", async () => {
  await withSourcesServer(
    {
      resolveAddresses: async () => {
        throw new Error("ENOTFOUND");
      },
    },
    async ({ baseUrl }) => {
      const response = await connectWebsite(baseUrl, "https://missing.example.com/");

      assert.equal(response.status, 422);
      assert.equal(
        (await readJson(response)).error,
        "The website domain could not be resolved.",
      );
    },
  );
});

test("rejects websites that do not return HTML", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 200,
          headers: { "content-type": "application/pdf" },
          chunks: ["%PDF-1.7"],
        },
      ],
    },
    async ({ baseUrl }) => {
      const response = await connectWebsite(baseUrl, "https://files.example.com/a.pdf");

      assert.equal(response.status, 422);
      assert.equal(
        (await readJson(response)).error,
        "Website returned an unexpected response (200).",
      );
    },
  );
});

test("requires an authenticated account to connect a website", async () => {
  await withSourcesServer(
    {
      websitePlans: [
        {
          status: 200,
          headers: { "content-type": "text/html" },
          chunks: [WEBSITE_HTML],
        },
      ],
    },
    async ({ baseUrl, websiteRequests }) => {
      const response = await connectWebsite(
        baseUrl,
        "https://research.example.com/",
        null,
      );

      assert.equal(response.status, 401);
      assert.equal(websiteRequests.length, 0);
    },
  );
});
