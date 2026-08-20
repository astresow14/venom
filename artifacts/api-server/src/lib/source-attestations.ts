import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const ATTESTATION_VERSION = "v1";
const ATTESTATION_DOMAIN = "venom-source-attestation-v1";
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const CITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const CITATION_MARKER_PATTERN = /\[source:([A-Za-z0-9_-]{1,160})\]/g;
const TOKEN_PATTERN =
  /^v1\.([A-Za-z0-9_-]{2,214})\.([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/;
const MAX_SOURCE_CONTEXT_CHARS = 8_000;
const MAX_SOURCE_SNAPSHOTS = 32;
const MAX_CITATIONS_PER_SOURCE = 50;
const MAX_ATTESTATION_CHARS = 2_048;

const SOURCE_PROVIDERS = new Set(["github", "website"]);
const SOURCE_KINDS = new Set([
  "repository",
  "issue",
  "pull_request",
  "website",
]);

export type SourceCitationSnapshot = {
  id: string;
  provider: string;
  kind: string;
  title: string;
  url: string;
  excerpt: string;
  reference: string | null;
};

export type AttestedSourceSnapshot = {
  id: string;
  context: string;
  citations: SourceCitationSnapshot[];
  attestation: string;
};

export class InvalidSourceSnapshotRequest extends Error {}

function attestationSecret(): string {
  const secret =
    process.env.SOURCE_ATTESTATION_SECRET ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "SOURCE_ATTESTATION_SECRET or SESSION_SECRET must be configured securely",
    );
  }
  return secret;
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (!isBoundedString(value, 1, 2_048)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalCitations(
  citations: SourceCitationSnapshot[],
): SourceCitationSnapshot[] | null {
  if (
    !Array.isArray(citations) ||
    citations.length < 1 ||
    citations.length > MAX_CITATIONS_PER_SOURCE
  ) {
    return null;
  }

  const ids = new Set<string>();
  const canonical: SourceCitationSnapshot[] = [];
  for (const citation of citations) {
    if (
      !citation ||
      !CITATION_ID_PATTERN.test(citation.id) ||
      ids.has(citation.id) ||
      !SOURCE_PROVIDERS.has(citation.provider) ||
      !SOURCE_KINDS.has(citation.kind) ||
      (citation.provider === "website" && citation.kind !== "website") ||
      (citation.provider === "github" && citation.kind === "website") ||
      !isBoundedString(citation.title, 1, 300) ||
      !isHttpsUrl(citation.url) ||
      !isBoundedString(citation.excerpt, 1, 1_000) ||
      !(
        citation.reference === null ||
        isBoundedString(citation.reference, 1, 200)
      )
    ) {
      return null;
    }

    ids.add(citation.id);
    canonical.push({
      id: citation.id,
      provider: citation.provider,
      kind: citation.kind,
      title: citation.title,
      url: citation.url,
      excerpt: citation.excerpt,
      reference: citation.reference,
    });
  }

  return canonical.sort((left, right) => left.id.localeCompare(right.id));
}

function snapshotDigest(
  context: string,
  citations: SourceCitationSnapshot[],
): string | null {
  const normalizedContext = context.trim();
  const normalizedCitations = canonicalCitations(citations);
  if (
    !normalizedContext ||
    normalizedContext.length > MAX_SOURCE_CONTEXT_CHARS ||
    !normalizedCitations
  ) {
    return null;
  }

  return createHash("sha256")
    .update(
      JSON.stringify({
        context: normalizedContext,
        citations: normalizedCitations,
      }),
    )
    .digest("hex");
}

function derivedSigningKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(ATTESTATION_DOMAIN).digest();
}

function signingInput(
  userId: string,
  projectId: string,
  sourceId: string,
  digest: string,
): string {
  return [ATTESTATION_VERSION, userId, projectId, sourceId, digest].join("\n");
}

export function createSourceAttestation(
  input: {
    userId: string;
    projectId: string;
    sourceId: string;
    context: string;
    citations: SourceCitationSnapshot[];
  },
  secret = attestationSecret(),
): string {
  if (
    !isBoundedString(input.userId, 1, 160) ||
    !isBoundedString(input.projectId, 1, 160) ||
    !SOURCE_ID_PATTERN.test(input.sourceId)
  ) {
    throw new Error("Source attestation identity is invalid");
  }

  const digest = snapshotDigest(input.context, input.citations);
  if (!digest) {
    throw new Error("Source snapshot is invalid");
  }

  const encodedSourceId = Buffer.from(input.sourceId, "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", derivedSigningKey(secret))
    .update(
      signingInput(
        input.userId,
        input.projectId,
        input.sourceId,
        digest,
      ),
    )
    .digest("base64url");
  return `${ATTESTATION_VERSION}.${encodedSourceId}.${digest}.${signature}`;
}

function verifySourceAttestation(
  input: {
    userId: string;
    projectId: string;
    snapshot: AttestedSourceSnapshot;
  },
  secret: string,
): boolean {
  if (
    !isBoundedString(input.userId, 1, 160) ||
    !isBoundedString(input.projectId, 1, 160) ||
    !SOURCE_ID_PATTERN.test(input.snapshot.id) ||
    !isBoundedString(
      input.snapshot.attestation,
      1,
      MAX_ATTESTATION_CHARS,
    )
  ) {
    return false;
  }

  const token = TOKEN_PATTERN.exec(input.snapshot.attestation);
  if (!token) return false;

  let tokenSourceId: string;
  try {
    tokenSourceId = Buffer.from(token[1], "base64url").toString("utf8");
  } catch {
    return false;
  }
  if (
    tokenSourceId !== input.snapshot.id ||
    Buffer.from(tokenSourceId, "utf8").toString("base64url") !== token[1]
  ) {
    return false;
  }

  const digest = snapshotDigest(
    input.snapshot.context,
    input.snapshot.citations,
  );
  if (!digest || digest !== token[2]) return false;

  const expected = createHmac("sha256", derivedSigningKey(secret))
    .update(
      signingInput(
        input.userId,
        input.projectId,
        input.snapshot.id,
        digest,
      ),
    )
    .digest();
  const provided = Buffer.from(token[3], "base64url");
  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

function wholeContextBlocks(context: string): Set<string> {
  return new Set(
    context
      .split("\n\n")
      .map((block) => block.trim())
      .filter(Boolean),
  );
}

export function authorizeAttestedCitationIds(
  input: {
    userId: string;
    projectId: string;
    projectContext: string;
    requestedCitationIds: string[];
    sourceSnapshots: AttestedSourceSnapshot[];
  },
  secret = attestationSecret(),
): Set<string> {
  if (
    !isBoundedString(input.projectId, 1, 160) ||
    input.projectContext.length > MAX_SOURCE_CONTEXT_CHARS ||
    input.sourceSnapshots.length > MAX_SOURCE_SNAPSHOTS
  ) {
    throw new InvalidSourceSnapshotRequest(
      "Connected source snapshots exceed request limits",
    );
  }

  const sourceBlocks = wholeContextBlocks(input.projectContext);
  const requested = new Set(input.requestedCitationIds);
  const sourceIds = new Set<string>();
  const allowed = new Set<string>();
  let totalSnapshotChars = 0;

  for (const snapshot of input.sourceSnapshots) {
    if (sourceIds.has(snapshot.id)) {
      throw new InvalidSourceSnapshotRequest(
        "Connected source snapshots contain duplicate source IDs",
      );
    }
    sourceIds.add(snapshot.id);
    totalSnapshotChars += snapshot.context.length;
    if (totalSnapshotChars > MAX_SOURCE_CONTEXT_CHARS) {
      throw new InvalidSourceSnapshotRequest(
        "Connected source snapshots exceed the context limit",
      );
    }

    const normalizedContext = snapshot.context.trim();
    if (
      !sourceBlocks.has(normalizedContext) ||
      !verifySourceAttestation(
        {
          userId: input.userId,
          projectId: input.projectId,
          snapshot: { ...snapshot, context: normalizedContext },
        },
        secret,
      )
    ) {
      continue;
    }

    const markers = new Set(
      [...normalizedContext.matchAll(CITATION_MARKER_PATTERN)].map(
        (match) => match[1],
      ),
    );
    for (const citation of snapshot.citations) {
      if (requested.has(citation.id) && markers.has(citation.id)) {
        allowed.add(citation.id);
      }
    }
  }

  return allowed;
}