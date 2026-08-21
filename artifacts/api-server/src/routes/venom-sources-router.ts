import { Router, type IRouter, type Request } from "express";
import { createHash } from "node:crypto";
import type { RequestOptions } from "node:https";
import { checkServerIdentity } from "node:tls";
import { publicIpAddress } from "../lib/website-safety";
import type { SourceCitationSnapshot } from "../lib/source-attestations";
import {
  ConnectGitHubSourceBody,
  ConnectGitHubSourceParams,
  ConnectGitHubSourceResponse,
  ConnectWebsiteSourceBody,
  ConnectWebsiteSourceParams,
  ConnectWebsiteSourceResponse,
  GetGitHubRepositoriesResponse,
} from "@workspace/api-zod";

export const MAX_WEBSITE_BYTES = 1_500_000;
export const WEBSITE_TIMEOUT_MS = 10_000;

type GitHubRepo = {
  name?: string;
  full_name?: string;
  html_url?: string;
  description?: string | null;
  updated_at?: string;
  open_issues_count?: number;
};

type GitHubIssue = {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  pull_request?: unknown;
};

type GitHubPullRequest = {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
};

export class SourceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Reads a GitHub REST path through the workspace connector. */
export type GitHubRequest = <T>(path: string) => Promise<T>;

/** Resolves a hostname to every address it points at. */
export type AddressResolver = (
  hostname: string,
) => Promise<Array<{ address: string }>>;

export type WebsiteResponse = {
  status: number;
  contentType: string;
  contentLength: number;
  html: string;
};

/** Fetches a website that has already passed URL and address validation. */
export type WebsiteFetcher = (
  url: URL,
  address: string,
) => Promise<WebsiteResponse>;

export type SourceAttestationSigner = (input: {
  userId: string;
  projectId: string;
  sourceId: string;
  context: string;
  citations: SourceCitationSnapshot[];
}) => string;

type ConnectorResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

export type ConnectorProxy = (
  connector: string,
  path: string,
  init: { method: string },
) => Promise<ConnectorResponse>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type ResponseLike = {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  destroy: (error?: Error) => unknown;
};

type RequestLike = {
  setTimeout: (timeout: number, listener: () => void) => unknown;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  destroy: (error?: Error) => unknown;
  end: () => unknown;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Minimal `https.request` shape so tests can drive the transfer directly. */
export type HttpsRequestFn = (
  options: RequestOptions,
  callback: (response: ResponseLike) => void,
) => RequestLike;

export type SourcesRouterOptions = {
  resolveUserId: (request: Request) => string | null | undefined;
  isWorkspaceMember: (userId: string) => boolean;
  githubRequest: GitHubRequest;
  resolveAddresses: AddressResolver;
  fetchWebsite: WebsiteFetcher;
  createAttestation: SourceAttestationSigner;
};

export function sourceId(projectId: string, key: string): string {
  const digest = createHash("sha256")
    .update(`${projectId}:${key}`)
    .digest("hex")
    .slice(0, 14);
  return `source_${digest}`;
}

export function citationId(source: string, suffix: string): string {
  return `cite_${createHash("sha256").update(`${source}:${suffix}`).digest("hex").slice(0, 12)}`;
}

function compactText(value: string | null | undefined, maxLength = 420): string {
  const normalized = (value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

export function createGitHubRequest(proxy: ConnectorProxy): GitHubRequest {
  return async function githubRequest<T>(path: string): Promise<T> {
    const response = await proxy("github", path, { method: "GET" });

    if (!response.ok) {
      const details = compactText(await response.text(), 240);
      throw new SourceRequestError(
        details || `GitHub request failed (${response.status})`,
        response.status,
      );
    }

    return (await response.json()) as T;
  };
}

export function asRepositoryPath(repository: string): string | null {
  const parts = repository.trim().split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    return null;
  }

  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export async function parsePublicWebsiteUrl(
  rawUrl: string,
  resolveAddresses: AddressResolver,
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourceRequestError("Enter a valid HTTPS website URL.", 400);
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    Boolean(url.username || url.password) ||
    Boolean(url.port && url.port !== "443") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^[\d.]+$/.test(hostname) ||
    hostname.startsWith("[")
  ) {
    throw new SourceRequestError(
      "Only public HTTPS websites can be added as sources.",
      400,
    );
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolveAddresses(hostname);
  } catch {
    throw new SourceRequestError("The website domain could not be resolved.", 422);
  }

  if (addresses.length === 0 || addresses.some(({ address }) => !publicIpAddress(address))) {
    throw new SourceRequestError(
      "This website address is not publicly reachable.",
      400,
    );
  }

  return { url, address: addresses[0].address };
}

/**
 * Builds a website fetcher that pins the connection to an already validated
 * address, caps the transferred bytes, and never follows redirects on its own.
 */
export function createWebsiteFetcher(
  request: HttpsRequestFn,
  {
    maxBytes = MAX_WEBSITE_BYTES,
    timeoutMs = WEBSITE_TIMEOUT_MS,
  }: {
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): WebsiteFetcher {
  return (url, address) =>
    new Promise<WebsiteResponse>((resolve, reject) => {
      const websiteRequest = request(
        {
          protocol: "https:",
          hostname: address,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: {
            Accept: "text/html,application/xhtml+xml",
            Host: url.hostname,
            "User-Agent": "VenomSourceConnector/1.0",
          },
          servername: url.hostname,
          checkServerIdentity: (_host, certificate) =>
            checkServerIdentity(url.hostname, certificate),
        },
        (response) => {
          const contentLength = Number(response.headers["content-length"] ?? 0);
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            response.destroy();
            reject(new SourceRequestError("This website is too large to add as a source.", 422));
            return;
          }

          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          response.on("data", (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (receivedBytes > maxBytes) {
              response.destroy(
                new SourceRequestError("This website is too large to add as a source.", 422),
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 502,
              contentType: String(response.headers["content-type"] ?? ""),
              contentLength,
              html: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );

      websiteRequest.setTimeout(timeoutMs, () => {
        websiteRequest.destroy(
          new SourceRequestError("The website took too long to respond.", 502),
        );
      });
      websiteRequest.on("error", reject as (...args: never[]) => void);
      websiteRequest.end();
    });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function websiteText(html: string): {
  title: string;
  excerpt: string;
  keywords: string[];
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = compactText(decodeHtml(titleMatch?.[1] ?? ""), 120);
  const text = compactText(
    decodeHtml(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
    4200,
  );
  const ignored = new Set([
    "about", "also", "and", "are", "but", "for", "from", "have", "into",
    "its", "more", "not", "our", "that", "the", "this", "was", "with",
    "you", "your", "www",
  ]);
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (!ignored.has(word)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const keywords = [...counts.entries()]
    .sort(([, left], [, right]) => right - left)
    .slice(0, 3)
    .map(([word]) => word);

  return { title, excerpt: text, keywords };
}

/**
 * Fetches a repository snapshot and builds the connected source for it. The
 * connect route and the server-side scheduled sync share this so a scheduled
 * refresh can never drift from what connecting the source would produce.
 */
export async function fetchGitHubConnectedSource(
  githubRequest: GitHubRequest,
  projectId: string,
  repositoryPath: string,
) {
  const [repository, issueResponse, pullRequests] = await Promise.all([
    githubRequest<GitHubRepo>(`/repos/${repositoryPath}`),
    githubRequest<GitHubIssue[]>(
      `/repos/${repositoryPath}/issues?state=open&per_page=20`,
    ),
    githubRequest<GitHubPullRequest[]>(
      `/repos/${repositoryPath}/pulls?state=open&per_page=10`,
    ),
  ]);

  const issues = issueResponse.filter((issue) => !issue.pull_request);

  return githubSource(projectId, repository, issues, pullRequests);
}

/**
 * Validates, fetches, and builds a website source. Shared by the connect
 * route and the server-side scheduled sync (see fetchGitHubConnectedSource).
 */
export async function fetchWebsiteConnectedSource(
  {
    resolveAddresses,
    fetchWebsite,
  }: Pick<SourcesRouterOptions, "resolveAddresses" | "fetchWebsite">,
  projectId: string,
  rawUrl: string,
  requestedName?: string,
) {
  const { url, address } = await parsePublicWebsiteUrl(rawUrl, resolveAddresses);
  const websiteResponse = await fetchWebsite(url, address);

  const contentType = websiteResponse.contentType;
  if (
    websiteResponse.status < 200 ||
    websiteResponse.status >= 300 ||
    (!contentType.includes("text/html") &&
      !contentType.includes("application/xhtml"))
  ) {
    throw new SourceRequestError(
      `Website returned an unexpected response (${websiteResponse.status}).`,
      422,
    );
  }

  return websiteSource(
    projectId,
    url,
    websiteText(websiteResponse.html),
    requestedName,
  );
}

export function websiteSource(
  projectId: string,
  url: URL,
  content: { title: string; excerpt: string; keywords: string[] },
  requestedName?: string,
) {
  const id = sourceId(projectId, `website:${url.href}`);
  const citation = {
    id: citationId(id, "website"),
    provider: "website" as const,
    kind: "website" as const,
    title: requestedName?.trim() || content.title || url.hostname,
    url: url.href,
    excerpt: compactText(content.excerpt, 800) || "Public website reference",
    reference: null,
  };

  return {
    id,
    projectId,
    provider: "website" as const,
    name: citation.title,
    url: url.href,
    status: "connected" as const,
    syncedAt: new Date(),
    summary: `${citation.title} • public website • ${content.keywords.join(", ") || "reference material"}`,
    context: `[source:${citation.id}] website: ${citation.title}. ${compactText(content.excerpt, 7200)} (${url.href})`,
    citations: [citation],
    clusters: [
      {
        id: `${id}_website`,
        label: citation.title,
        category: "website",
        strength: 0.8,
        citationIds: [citation.id],
      },
      ...content.keywords.map((keyword, index) => ({
        id: `${id}_topic_${keyword}`,
        label: keyword,
        category: "topic",
        strength: Math.max(0.45, 0.68 - index * 0.08),
        citationIds: [citation.id],
      })),
    ],
  };
}

export function githubSource(
  projectId: string,
  repository: GitHubRepo,
  issues: GitHubIssue[],
  pullRequests: GitHubPullRequest[],
) {
  const fullName = repository.full_name ?? "repository";
  const url = repository.html_url ?? `https://github.com/${fullName}`;
  const id = sourceId(projectId, `github:${fullName}`);
  const repoCitationId = citationId(id, "repository");
  const citations = [
    {
      id: repoCitationId,
      provider: "github" as const,
      kind: "repository" as const,
      title: fullName,
      url,
      excerpt: compactText(repository.description) || "GitHub repository",
      reference: fullName,
    },
    ...issues.slice(0, 5).flatMap((issue) =>
      issue.number && issue.title && issue.html_url
        ? [{
            id: citationId(id, `issue:${issue.number}`),
            provider: "github" as const,
            kind: "issue" as const,
            title: `#${issue.number} ${issue.title}`,
            url: issue.html_url,
            excerpt: compactText(issue.body) || "Open GitHub issue",
            reference: `${fullName}#${issue.number}`,
          }]
        : [],
    ),
    ...pullRequests.slice(0, 5).flatMap((pullRequest) =>
      pullRequest.number && pullRequest.title && pullRequest.html_url
        ? [{
            id: citationId(id, `pr:${pullRequest.number}`),
            provider: "github" as const,
            kind: "pull_request" as const,
            title: `PR #${pullRequest.number} ${pullRequest.title}`,
            url: pullRequest.html_url,
            excerpt: compactText(pullRequest.body) || "Open GitHub pull request",
            reference: `${fullName}#${pullRequest.number}`,
          }]
        : [],
    ),
  ];
  const issueCitations = citations.filter((citation) => citation.kind === "issue");
  const pullRequestCitations = citations.filter(
    (citation) => citation.kind === "pull_request",
  );
  const clusters = [
    {
      id: `${id}_repository`,
      label: fullName,
      category: "repository",
      strength: 1,
      citationIds: [repoCitationId],
    },
    ...(issueCitations.length
      ? [{
          id: `${id}_issues`,
          label: `${issueCitations.length} open issues`,
          category: "issues",
          strength: 0.78,
          citationIds: issueCitations.map((citation) => citation.id),
        }]
      : []),
    ...(pullRequestCitations.length
      ? [{
          id: `${id}_pull_requests`,
          label: `${pullRequestCitations.length} open pull requests`,
          category: "delivery",
          strength: 0.7,
          citationIds: pullRequestCitations.map((citation) => citation.id),
        }]
      : []),
  ];
  const context = citations
    .map(
      (citation) =>
        `[source:${citation.id}] ${citation.kind}: ${citation.title}. ${citation.excerpt} (${citation.url})`,
    )
    .join("\n");

  return {
    id,
    projectId,
    provider: "github" as const,
    name: fullName,
    url,
    status: "connected" as const,
    syncedAt: new Date(),
    summary: `${fullName} • ${repository.open_issues_count ?? issueCitations.length} open items • ${pullRequestCitations.length} active pull requests`,
    context: compactText(context, 7600),
    citations,
    clusters,
  };
}

export function sourceErrorResponse(
  req: Request,
  error: unknown,
  fallbackMessage: string,
): { status: number; message: string } {
  if (error instanceof SourceRequestError) {
    req.log?.warn({ err: error }, "Connected source request failed");
    return { status: error.status, message: error.message };
  }

  req.log?.error({ err: error }, "Connected source request failed unexpectedly");
  return { status: 502, message: fallbackMessage };
}

export function createVenomSourcesRouter({
  resolveUserId,
  isWorkspaceMember,
  githubRequest,
  resolveAddresses,
  fetchWebsite,
  createAttestation,
}: SourcesRouterOptions): IRouter {
  const router: IRouter = Router();

  router.get("/venom/github/repositories", async (req, res): Promise<void> => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isWorkspaceMember(userId)) {
      res.status(403).json({
        error:
          "Your account is not authorized to use this workspace GitHub connection.",
      });
      return;
    }

    try {
      const repositories = await githubRequest<GitHubRepo[]>(
        "/user/repos?sort=pushed&per_page=100",
      );

      const response = repositories
        .filter(
          (repository) =>
            Boolean(repository.full_name && repository.name && repository.html_url),
        )
        .map((repository) => ({
          fullName: repository.full_name!,
          name: repository.name!,
          description: repository.description ?? null,
          url: repository.html_url!,
          updatedAt: repository.updated_at ?? new Date().toISOString(),
        }));

      const parsed = GetGitHubRepositoriesResponse.safeParse(response);
      if (!parsed.success) {
        req.log?.warn(
          { validationErrors: parsed.error.issues },
          "GitHub repositories response validation failed",
        );
        res.status(502).json({ error: "GitHub returned unexpected data" });
        return;
      }

      res.json(parsed.data);
    } catch (error) {
      const { status, message } = sourceErrorResponse(
        req,
        error,
        "GitHub repositories could not be loaded.",
      );
      res.status(status).json({ error: message });
    }
  });

  router.post(
    "/venom/projects/:projectId/sources/github",
    async (req, res): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!isWorkspaceMember(userId)) {
        res.status(403).json({
          error:
            "Your account is not authorized to use this workspace GitHub connection.",
        });
        return;
      }

      const params = ConnectGitHubSourceParams.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ error: "Invalid project ID" });
        return;
      }

      const body = ConnectGitHubSourceBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      const repositoryPath = asRepositoryPath(body.data.repository);
      if (!repositoryPath) {
        res.status(400).json({ error: "Invalid repository identifier" });
        return;
      }

      try {
        const connectedSource = await fetchGitHubConnectedSource(
          githubRequest,
          params.data.projectId,
          repositoryPath,
        );
        const source = {
          ...connectedSource,
          attestation: createAttestation({
            userId,
            projectId: connectedSource.projectId,
            sourceId: connectedSource.id,
            context: connectedSource.context,
            citations: connectedSource.citations,
          }),
        };

        const parsed = ConnectGitHubSourceResponse.safeParse(source);
        if (!parsed.success) {
          req.log?.warn(
            { validationErrors: parsed.error.issues },
            "GitHub source response validation failed",
          );
          res.status(502).json({ error: "GitHub returned unexpected data" });
          return;
        }

        res.json(parsed.data);
      } catch (error) {
        const { status, message } = sourceErrorResponse(
          req,
          error,
          "Venom could not connect this GitHub repository.",
        );
        res.status(status).json({ error: message });
      }
    },
  );

  router.post(
    "/venom/projects/:projectId/sources/website",
    async (req, res): Promise<void> => {
      const userId = resolveUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const params = ConnectWebsiteSourceParams.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ error: "Invalid project ID" });
        return;
      }

      const body = ConnectWebsiteSourceBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }

      try {
        const connectedSource = await fetchWebsiteConnectedSource(
          { resolveAddresses, fetchWebsite },
          params.data.projectId,
          body.data.url,
          body.data.name ?? undefined,
        );
        const source = {
          ...connectedSource,
          attestation: createAttestation({
            userId,
            projectId: connectedSource.projectId,
            sourceId: connectedSource.id,
            context: connectedSource.context,
            citations: connectedSource.citations,
          }),
        };

        const parsed = ConnectWebsiteSourceResponse.safeParse(source);
        if (!parsed.success) {
          req.log?.warn(
            { validationErrors: parsed.error.issues },
            "Website source response validation failed",
          );
          res.status(502).json({ error: "Website source data is invalid" });
          return;
        }

        res.json(parsed.data);
      } catch (error) {
        const { status, message } = sourceErrorResponse(
          req,
          error,
          "Venom could not read this website.",
        );
        res.status(status).json({ error: message });
      }
    },
  );

  return router;
}
