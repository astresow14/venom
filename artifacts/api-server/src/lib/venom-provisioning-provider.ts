/**
 * Venom provisioning provider interface and Replit gateway adapter.
 *
 * Server-only. Defines the narrow contract between provisioning workers and
 * the managed deployment capability gateway.
 *
 * Security invariants:
 * - No credentials, tokens, or API keys may appear in client state, DB, or logs.
 * - REPLIT_PROVISIONING_GATEWAY_URL and REPLIT_PROVISIONING_GATEWAY_TOKEN are
 *   read at call-time from process.env — never stored or logged.
 * - All HTTP requests carry Authorization header only server-side.
 * - Response bodies are never logged. Only structured fields from validated
 *   responses are propagated.
 * - Provider calls receive immutable approved package metadata plus full source
 *   version reference (object path, checksum, metadata) — never credentials.
 * - Client-visible errors are generic; internal details stay server-side only.
 * - Recovery guidance never asks users to set env vars; always refers to
 *   the managed Replit capability or workspace admin.
 *
 * ─── /v1 Gateway contract ────────────────────────────────────────────────────
 *
 * Every resource-creating call carries an idempotency key so the gateway can
 * de-duplicate across Venom timeouts, restarts, and retries. Repeating a call
 * with the same key returns the same resource rather than creating a new one.
 *
 *   GET  /v1/capability
 *        Response: { health, summary, recoveryGuidance, supportedTargetTypes,
 *                    rollbackSupported, publishSupported }
 *        health: "healthy" | "degraded" | "unavailable" | "unconfigured"
 *
 *   POST /v1/permissions/validate
 *        Body: { requestedIntegrations: string[] }
 *        Response: { allowed: string[], denied: Array<{integration,reason}> }
 *
 *   POST /v1/projects
 *        Body: { ownerId, targetName, targetType, existingProviderProjectId?,
 *                provisioningRunId, idempotencyKey }
 *        Idempotent by (ownerId, targetName) or existingProviderProjectId.
 *        Response: { providerProjectId, created }
 *
 *   POST /v1/projects/:projectId/handoff
 *        Body: { handoff: ProvisioningPackageHandoff }  (never logged)
 *        Idempotent by (provisioningRunId, approvedRevisionId,
 *          packageChecksumSha256) carried inside the handoff.
 *        Response: {} (204)
 *
 *   POST /v1/projects/:projectId/builds
 *        Body: { buildRunId, provisioningRunId, idempotencyKey }
 *        Idempotent by idempotencyKey (a stable per-attempt operation key,
 *          NOT regenerated on plain resume). Returns the existing build when
 *          the same key repeats.
 *        Response: { providerBuildId, status }
 *
 *   GET  /v1/projects/:projectId/builds/:buildId/status
 *        Response: { providerBuildId, status, progress, message }
 *
 *   POST /v1/projects/:projectId/builds/:buildId/tests
 *        Response: { passed, message }
 *
 *   POST /v1/projects/:projectId/candidates
 *        Body: { providerBuildId, provisioningRunId, idempotencyKey }
 *        Idempotent by (provisioningRunId, providerBuildId).
 *        Response: { providerCandidateId, launchUrl, rollbackSupported }
 *
 *   GET  /v1/projects/:projectId/candidates/:candidateId/status
 *        Response: { healthy, launchUrl }
 *
 *   POST /v1/projects/:projectId/candidates/:candidateId/publish
 *        Body: { idempotencyKey }
 *        Response: { providerReleaseId, launchUrl, healthy }
 *
 *   POST /v1/projects/:projectId/cancel
 *        Body: { providerBuildId? }
 *        Response: {} (204)
 *
 *   POST /v1/projects/:projectId/releases/:releaseId/rollback
 *        Body: { idempotencyKey }
 *        Response: { providerReleaseId, launchUrl, healthy }
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProvisioningCapabilityHealth =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unconfigured";

export type ProvisioningCapabilitySummary = {
  health: ProvisioningCapabilityHealth;
  /** Safe description for clients. No internal details. */
  summary: string;
  /** Safe recovery guidance for clients. Never mentions env var names. */
  recoveryGuidance: string | null;
  /** Supported target types. */
  supportedTargetTypes: ("app" | "website")[];
  /** Whether rollback is supported by this provider. */
  rollbackSupported: boolean;
  /** Whether publish is available (not just candidate). */
  publishSupported: boolean;
};

export type ProvisioningPermissionSummary = {
  /** Requested integrations that are allowed. */
  allowed: string[];
  /** Requested integrations that are denied (and why). */
  denied: Array<{ integration: string; reason: string }>;
};

/**
 * Full source version reference handed to the trusted gateway.
 *
 * The gateway cannot read Venom's private App Storage by object path, so a
 * short-lived signed GET URL is generated at handoff time and passed here. The
 * signed URL is transient: it is never persisted, returned to clients, or
 * logged. The managed objectPath is intentionally NOT part of this type — it
 * must never leave the server. The gateway downloads via downloadUrl and
 * verifies checksumSha256 before building.
 */
export type ProvisioningSourceRef = {
  /** Owning app id (pin). */
  appId: string;
  /** Source version id (pin). */
  sourceVersionId: string;
  /** Exact version number (pin). */
  versionNumber: number;
  /** SHA-256 checksum the gateway must verify after download. */
  checksumSha256: string;
  archiveFilename: string;
  archiveBytes: number;
  sourceType: string;
  /**
   * Short-lived signed GET URL (≈15 min TTL). Transient — never persisted,
   * returned, or logged. Present only in the outbound provider call.
   */
  downloadUrl: string;
};

/** Full approved package handoff — trusted server-to-server, never stored or logged. */
export type ProvisioningPackageHandoff = {
  /** Build run ID for correlation. */
  buildRunId: string;
  /** Provisioning run id — part of the handoff idempotency identity. */
  provisioningRunId: string;
  approvedRevisionId: string;
  /** Revision checksum for provider integrity verification. Never logged. */
  packageChecksumSha256: string;
  /** Full approved package object. Trusted server-to-server. Never stored or logged. */
  approvedPackage: unknown;
  targetType: "app" | "website";
  targetName: string;
  /**
   * Full source version reference including a transient signed download URL.
   * Never stored or logged. Absent when the package pins no source.
   */
  sourceRef: ProvisioningSourceRef | null;
};

export type ProviderProjectResult = {
  providerProjectId: string;
  /** Whether the project was newly created or already existed. */
  created: boolean;
};

export type ProviderBuildResult = {
  providerBuildId: string;
  status: "started" | "pending";
};

export type ProviderBuildStatus = {
  providerBuildId: string;
  status: "pending" | "building" | "success" | "failed" | "cancelled";
  progress: number;
  message: string;
};

export type ProviderTestResult = {
  passed: boolean;
  message: string;
};

export type ProviderCandidateResult = {
  providerCandidateId: string;
  /** Safe launch URL for the candidate, if available. */
  launchUrl: string | null;
  rollbackSupported: boolean;
};

export type ProviderPublishResult = {
  providerReleaseId: string;
  launchUrl: string;
  /** Provider confirms the release is healthy. */
  healthy: boolean;
};

export type ProviderRollbackResult = {
  providerReleaseId: string;
  launchUrl: string;
  healthy: boolean;
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when no managed provider is configured. Fails closed. */
export class ProvisioningCapabilityUnavailableError extends Error {
  constructor(message = "No managed provisioning provider is available") {
    super(message);
    this.name = "ProvisioningCapabilityUnavailableError";
  }
}

/** Thrown when the provider reports a client-safe error. */
export class ProvisioningProviderError extends Error {
  constructor(
    /** Client-safe message. */
    readonly clientMessage: string,
    readonly code: string,
    readonly retryable: boolean = false,
  ) {
    super(clientMessage);
    this.name = "ProvisioningProviderError";
  }
}

/** Thrown when an operation times out. */
export class ProvisioningTimeoutError extends Error {
  constructor(readonly stage: string) {
    super(`Provisioning timed out at stage: ${stage}`);
    this.name = "ProvisioningTimeoutError";
  }
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface ProvisioningProvider {
  /**
   * Check capability health. Never throws — returns unconfigured on failure.
   * Must not log credentials or response bodies.
   */
  checkCapability(): Promise<ProvisioningCapabilitySummary>;

  /**
   * Validate requested integrations against allowed list.
   * Returns allowed/denied breakdown.
   */
  validatePermissions(
    requestedIntegrations: string[],
  ): Promise<ProvisioningPermissionSummary>;

  /**
   * Create or link a provider project for this owner + target name.
   * Idempotent by (ownerId, targetName) or existingProviderProjectId.
   */
  createOrLinkProject(opts: {
    ownerId: string;
    targetName: string;
    targetType: "app" | "website";
    /** Existing provider project ID if relinking. */
    existingProviderProjectId?: string;
    /** Provisioning run id for correlation and idempotency. */
    provisioningRunId: string;
    /** Stable idempotency key so repeats do not create duplicate projects. */
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderProjectResult>;

  /**
   * Hand off the full approved immutable package + full source version reference.
   * Provider is trusted server-side. Payload must NEVER be stored on DB records
   * or included in any log line.
   */
  handOffPackage(opts: {
    providerProjectId: string;
    handoff: ProvisioningPackageHandoff;
    signal?: AbortSignal;
  }): Promise<void>;

  /**
   * Start a build for the handed-off package.
   * Idempotent by idempotencyKey (a stable per-attempt operation key that is
   * NOT regenerated on a plain resume) so a resumed run reuses the build.
   */
  startBuild(opts: {
    providerProjectId: string;
    buildRunId: string;
    provisioningRunId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderBuildResult>;

  /**
   * Poll build status. Should be called periodically.
   */
  getBuildStatus(opts: {
    providerProjectId: string;
    providerBuildId: string;
    signal?: AbortSignal;
  }): Promise<ProviderBuildStatus>;

  /**
   * Run acceptance tests for the built artifact.
   */
  runTests(opts: {
    providerProjectId: string;
    providerBuildId: string;
    signal?: AbortSignal;
  }): Promise<ProviderTestResult>;

  /**
   * Create a candidate release from the successful build.
   * Idempotent by (provisioningRunId, providerBuildId).
   */
  createCandidate(opts: {
    providerProjectId: string;
    providerBuildId: string;
    provisioningRunId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderCandidateResult>;

  /**
   * Get candidate status (health check before publish).
   */
  getCandidateStatus(opts: {
    providerProjectId: string;
    providerCandidateId: string;
    signal?: AbortSignal;
  }): Promise<{ healthy: boolean; launchUrl: string | null }>;

  /**
   * Publish the candidate as the primary deployment.
   * Only called after provider reports healthy success.
   * Failed publish MUST NOT replace a healthy deployment.
   * idempotencyKey prevents double-invocation on retry.
   */
  publishCandidate(opts: {
    providerProjectId: string;
    providerCandidateId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderPublishResult>;

  /**
   * Cancel an in-progress provisioning operation.
   * Must be called when provider refs exist (providerProjectId set).
   */
  cancelOperation(opts: {
    providerProjectId: string;
    providerBuildId?: string;
    signal?: AbortSignal;
  }): Promise<void>;

  /**
   * Roll back to a previous healthy release.
   * Only valid when rollbackSupported is true and provider confirms health.
   * idempotencyKey prevents double-invocation on retry.
   */
  rollback(opts: {
    providerProjectId: string;
    providerReleaseId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderRollbackResult>;
}

// ─── Gateway HTTP helpers ────────────────────────────────────────────────────

/** Read gateway config at call-time — never stored. */
function gatewayConfig(): { url: string; token: string | null } | null {
  const rawUrl = process.env.REPLIT_PROVISIONING_GATEWAY_URL;
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }
  parsed.search = "";
  parsed.hash = "";
  const url = parsed.toString().replace(/\/$/, "");
  const token = process.env.REPLIT_PROVISIONING_GATEWAY_TOKEN ?? null;
  return { url, token };
}

function authHeaders(token: string | null): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Perform a gateway JSON request. Throws ProvisioningProviderError on
 * non-2xx. Never logs the URL (may contain routing info), token, or body.
 */
async function gatewayRequest<T>(
  method: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  validateFn: (data: unknown) => T,
): Promise<T> {
  const cfg = gatewayConfig();
  if (!cfg) {
    throw new ProvisioningCapabilityUnavailableError(
      "Managed Replit provisioning capability is not connected",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...authHeaders(cfg.token),
  };

  let response: Response;
  try {
    response = await fetch(`${cfg.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ProvisioningProviderError(
      "Provisioning capability is temporarily unreachable. Please try again.",
      "gateway_unreachable",
      true,
    );
  }

  if (!response.ok) {
    // Read status code — never log the body
    const statusCode = response.status;
    if (statusCode === 401 || statusCode === 403) {
      throw new ProvisioningProviderError(
        "Provisioning capability access was denied. Please reconnect the managed Replit capability or ask your workspace admin.",
        "gateway_auth_denied",
        false,
      );
    }
    if (statusCode === 404) {
      throw new ProvisioningProviderError(
        "Provisioning resource not found",
        "gateway_not_found",
        false,
      );
    }
    if (statusCode === 409) {
      throw new ProvisioningProviderError(
        "Provisioning operation conflict. The request may have already been processed.",
        "gateway_conflict",
        false,
      );
    }
    if (statusCode >= 500) {
      throw new ProvisioningProviderError(
        "Provisioning service is experiencing issues. Please try again later.",
        "gateway_server_error",
        true,
      );
    }
    throw new ProvisioningProviderError(
      "Provisioning request failed. Please try again.",
      `gateway_http_${statusCode}`,
      statusCode >= 500,
    );
  }

  if (response.status === 204) {
    return validateFn(null);
  }

  let rawJson: unknown;
  try {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
      throw new Error("response_too_large");
    }
    const rawText = await response.text();
    if (rawText.length > 65_536) {
      throw new Error("response_too_large");
    }
    rawJson = JSON.parse(rawText);
  } catch {
    throw new ProvisioningProviderError(
      "Provisioning service returned an unexpected response",
      "gateway_invalid_response",
      true,
    );
  }

  try {
    return validateFn(rawJson);
  } catch {
    throw new ProvisioningProviderError(
      "Provisioning service returned an unexpected response",
      "gateway_invalid_response",
      true,
    );
  }
}

// ─── Safe value validators ────────────────────────────────────────────────────

/**
 * Validate a provider-supplied launch URL before it is ever persisted or
 * exposed to clients. Only absolute http/https URLs with no embedded
 * credentials are accepted. Rejects javascript:, data:, mailto:, relative,
 * over-long, and userinfo-bearing URLs. Returns null when invalid.
 */
export function sanitizeLaunchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // Reject embedded credentials (user:pass@host).
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

/**
 * Bound and validate a provider-supplied identifier (project/build/candidate/
 * release id). Must be a non-empty printable single-line string within a safe
 * length. Returns null when invalid.
 */
export function sanitizeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;
  // Disallow control characters / newlines.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/** Bound and sanitize a provider-supplied human message. */
function sanitizeMessage(value: unknown, max = 300): string {
  if (typeof value !== "string") return "";
  // Strip control chars except common whitespace, then bound length.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
}

// ─── Response type guards ─────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseCapabilityResponse(data: unknown): ProvisioningCapabilitySummary {
  if (!isRecord(data)) throw new Error("invalid");
  const health = data["health"] as ProvisioningCapabilityHealth;
  if (!["healthy", "degraded", "unavailable", "unconfigured"].includes(health)) throw new Error("invalid");
  const supportedTargetTypes = isStringArray(data["supportedTargetTypes"])
    ? (data["supportedTargetTypes"] as ("app" | "website")[]).filter(
        (t) => t === "app" || t === "website",
      )
    : [];
  const clientSafeText: Record<
    ProvisioningCapabilityHealth,
    { summary: string; recoveryGuidance: string | null }
  > = {
    healthy: {
      summary: "Managed Replit provisioning capability is ready.",
      recoveryGuidance: null,
    },
    degraded: {
      summary: "Managed Replit provisioning capability is degraded.",
      recoveryGuidance:
        "Try again later. If this persists, ask your workspace admin to check the managed capability.",
    },
    unavailable: {
      summary: "Managed Replit provisioning capability is unavailable.",
      recoveryGuidance:
        "Try again later. If this persists, ask your workspace admin to check the managed capability.",
    },
    unconfigured: {
      summary: "Managed Replit provisioning capability is not connected.",
      recoveryGuidance:
        "Ask your workspace admin to connect the managed Replit provisioning capability.",
    },
  };
  return {
    health,
    ...clientSafeText[health],
    supportedTargetTypes,
    rollbackSupported: isBoolean(data["rollbackSupported"]) ? data["rollbackSupported"] : false,
    publishSupported: isBoolean(data["publishSupported"]) ? data["publishSupported"] : false,
  };
}

function parsePermissionSummary(data: unknown): ProvisioningPermissionSummary {
  if (!isRecord(data)) throw new Error("invalid");
  const allowed = isStringArray(data["allowed"])
    ? data["allowed"]
        .slice(0, 100)
        .map((value) => sanitizeMessage(value, 200).trim())
        .filter(Boolean)
    : [];
  const denied: Array<{ integration: string; reason: string }> = [];
  if (Array.isArray(data["denied"])) {
    for (const item of data["denied"].slice(0, 100)) {
      if (isRecord(item) && isString(item["integration"]) && isString(item["reason"])) {
        const integration = sanitizeMessage(item["integration"], 200).trim();
        if (!integration) continue;
        denied.push({
          integration,
          reason: "Required managed capability permission is unavailable.",
        });
      }
    }
  }
  return { allowed, denied };
}

function parseProjectResult(data: unknown): ProviderProjectResult {
  if (!isRecord(data)) throw new Error("invalid");
  const providerProjectId = sanitizeProviderId(data["providerProjectId"]);
  if (!providerProjectId) throw new Error("invalid");
  return {
    providerProjectId,
    created: isBoolean(data["created"]) ? data["created"] : false,
  };
}

function parseBuildResult(data: unknown): ProviderBuildResult {
  if (!isRecord(data)) throw new Error("invalid");
  const providerBuildId = sanitizeProviderId(data["providerBuildId"]);
  if (!providerBuildId) throw new Error("invalid");
  return {
    providerBuildId,
    status: data["status"] === "pending" ? "pending" : "started",
  };
}

function parseBuildStatus(data: unknown): ProviderBuildStatus {
  if (!isRecord(data)) throw new Error("invalid");
  const providerBuildId = sanitizeProviderId(data["providerBuildId"]);
  if (!providerBuildId) throw new Error("invalid");
  const validStatuses = ["pending", "building", "success", "failed", "cancelled"] as const;
  const status = validStatuses.includes(data["status"] as never)
    ? (data["status"] as ProviderBuildStatus["status"])
    : "failed";
  return {
    providerBuildId,
    status,
    progress: typeof data["progress"] === "number" ? Math.min(100, Math.max(0, data["progress"])) : 0,
    message:
      status === "success"
        ? "Build completed."
        : status === "failed"
          ? "Build failed."
          : status === "cancelled"
            ? "Build cancelled."
            : status === "building"
              ? "Build in progress."
              : "Build queued.",
  };
}

function parseTestResult(data: unknown): ProviderTestResult {
  if (!isRecord(data)) throw new Error("invalid");
  const passed = isBoolean(data["passed"]) ? data["passed"] : false;
  return {
    passed,
    message: passed
      ? "Acceptance tests passed."
      : "Acceptance tests failed.",
  };
}

function parseCandidateResult(data: unknown): ProviderCandidateResult {
  if (!isRecord(data)) throw new Error("invalid");
  const providerCandidateId = sanitizeProviderId(data["providerCandidateId"]);
  if (!providerCandidateId) throw new Error("invalid");
  return {
    providerCandidateId,
    launchUrl: sanitizeLaunchUrl(data["launchUrl"]),
    rollbackSupported: isBoolean(data["rollbackSupported"]) ? data["rollbackSupported"] : false,
  };
}

function parseCandidateStatus(data: unknown): { healthy: boolean; launchUrl: string | null } {
  if (!isRecord(data)) throw new Error("invalid");
  return {
    healthy: isBoolean(data["healthy"]) ? data["healthy"] : false,
    launchUrl: sanitizeLaunchUrl(data["launchUrl"]),
  };
}

function parsePublishResult(data: unknown): ProviderPublishResult {
  if (!isRecord(data)) throw new Error("invalid");
  const providerReleaseId = sanitizeProviderId(data["providerReleaseId"]);
  if (!providerReleaseId) throw new Error("invalid");
  // A successful publish must expose a valid absolute launch URL. When the
  // provider reports unhealthy, the URL is not used, so tolerate its absence.
  const launchUrl = sanitizeLaunchUrl(data["launchUrl"]);
  const healthy = isBoolean(data["healthy"]) ? data["healthy"] : false;
  if (healthy && !launchUrl) throw new Error("invalid");
  return {
    providerReleaseId,
    launchUrl: launchUrl ?? "",
    healthy,
  };
}

function parseRollbackResult(data: unknown): ProviderRollbackResult {
  if (!isRecord(data)) throw new Error("invalid");
  const providerReleaseId = sanitizeProviderId(data["providerReleaseId"]);
  if (!providerReleaseId) throw new Error("invalid");
  const launchUrl = sanitizeLaunchUrl(data["launchUrl"]);
  const healthy = isBoolean(data["healthy"]) ? data["healthy"] : false;
  if (healthy && !launchUrl) throw new Error("invalid");
  return {
    providerReleaseId,
    launchUrl: launchUrl ?? "",
    healthy,
  };
}

// ─── Real Replit Gateway Provider ─────────────────────────────────────────────

/**
 * Production Replit provisioning gateway adapter.
 *
 * Reads REPLIT_PROVISIONING_GATEWAY_URL and optional
 * REPLIT_PROVISIONING_GATEWAY_TOKEN at call-time from process.env.
 * Never stores credentials. Never logs URL, token, or response bodies.
 *
 * When unconfigured (URL absent), checkCapability returns "unconfigured"
 * and all other methods throw ProvisioningCapabilityUnavailableError.
 *
 * Recovery guidance always refers to the managed Replit capability or
 * workspace admin — never to setting env vars.
 */
class ReplitGatewayProvider implements ProvisioningProvider {
  async checkCapability(): Promise<ProvisioningCapabilitySummary> {
    const cfg = gatewayConfig();
    if (!cfg) {
      return {
        health: "unconfigured",
        summary: "Managed Replit provisioning capability is not connected",
        recoveryGuidance:
          "Reconnect the managed Replit capability or ask your workspace admin to enable provisioning.",
        supportedTargetTypes: [],
        rollbackSupported: false,
        publishSupported: false,
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        return await gatewayRequest(
          "GET",
          "/v1/capability",
          undefined,
          controller.signal,
          parseCapabilityResponse,
        );
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (err instanceof ProvisioningCapabilityUnavailableError) {
        return {
          health: "unconfigured",
          summary: "Managed Replit provisioning capability is not connected",
          recoveryGuidance:
            "Reconnect the managed Replit capability or ask your workspace admin to enable provisioning.",
          supportedTargetTypes: [],
          rollbackSupported: false,
          publishSupported: false,
        };
      }
      if (err instanceof ProvisioningProviderError) {
        const isAuth = err.code === "gateway_auth_denied";
        return {
          health: isAuth ? "unavailable" : "degraded",
          summary: isAuth
            ? "Provisioning capability access was denied"
            : "Provisioning capability is temporarily degraded",
          recoveryGuidance: isAuth
            ? "Please reconnect the managed Replit capability or ask your workspace admin."
            : "Please try again in a few minutes. If this persists, ask your workspace admin.",
          supportedTargetTypes: [],
          rollbackSupported: false,
          publishSupported: false,
        };
      }
      // Unexpected error — treat as degraded, not unconfigured
      return {
        health: "degraded",
        summary: "Provisioning capability check failed",
        recoveryGuidance: "Please try again in a few minutes. If this persists, ask your workspace admin.",
        supportedTargetTypes: [],
        rollbackSupported: false,
        publishSupported: false,
      };
    }
  }

  async validatePermissions(
    requestedIntegrations: string[],
  ): Promise<ProvisioningPermissionSummary> {
    const cfg = gatewayConfig();
    if (!cfg) {
      // Unconfigured — deny everything safely
      return {
        allowed: [],
        denied: requestedIntegrations.map((i) => ({
          integration: i,
          reason: "Provisioning capability is not connected",
        })),
      };
    }
    const providerSummary = await gatewayRequest(
      "POST",
      "/v1/permissions/validate",
      { requestedIntegrations },
      undefined,
      parsePermissionSummary,
    );
    const requested = Array.from(new Set(requestedIntegrations));
    const requestedSet = new Set(requested);
    const providerNames = [
      ...providerSummary.allowed,
      ...providerSummary.denied.map((item) => item.integration),
    ];
    if (providerNames.some((name) => !requestedSet.has(name))) {
      throw new ProvisioningProviderError(
        "Provisioning service returned an unexpected permission response",
        "gateway_invalid_permission_response",
        true,
      );
    }
    const allowedByProvider = new Set(providerSummary.allowed);
    const deniedByProvider = new Set(
      providerSummary.denied.map((item) => item.integration),
    );
    const denied = requested.filter(
      (name) => deniedByProvider.has(name) || !allowedByProvider.has(name),
    );
    return {
      allowed: requested.filter((name) => !denied.includes(name)),
      denied: denied.map((integration) => ({
        integration,
        reason: "Required managed capability permission is unavailable.",
      })),
    };
  }

  async createOrLinkProject(opts: {
    ownerId: string;
    targetName: string;
    targetType: "app" | "website";
    existingProviderProjectId?: string;
    provisioningRunId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderProjectResult> {
    return gatewayRequest(
      "POST",
      "/v1/projects",
      {
        ownerId: opts.ownerId,
        targetName: opts.targetName,
        targetType: opts.targetType,
        existingProviderProjectId: opts.existingProviderProjectId,
        provisioningRunId: opts.provisioningRunId,
        idempotencyKey: opts.idempotencyKey,
      },
      opts.signal,
      parseProjectResult,
    );
  }

  async handOffPackage(opts: {
    providerProjectId: string;
    handoff: ProvisioningPackageHandoff;
    signal?: AbortSignal;
  }): Promise<void> {
    // handoff contains an approved package checksum, the approved package, and
    // optionally a short-lived signed source URL — these are sent to the trusted
    // server-to-server gateway only. No managed object path is included.
    // NEVER log handoff or the request body.
    await gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/handoff`,
      { handoff: opts.handoff },
      opts.signal,
      () => undefined,
    );
  }

  async startBuild(opts: {
    providerProjectId: string;
    buildRunId: string;
    provisioningRunId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderBuildResult> {
    return gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/builds`,
      {
        buildRunId: opts.buildRunId,
        provisioningRunId: opts.provisioningRunId,
        idempotencyKey: opts.idempotencyKey,
      },
      opts.signal,
      parseBuildResult,
    );
  }

  async getBuildStatus(opts: {
    providerProjectId: string;
    providerBuildId: string;
    signal?: AbortSignal;
  }): Promise<ProviderBuildStatus> {
    return gatewayRequest(
      "GET",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/builds/${encodeURIComponent(opts.providerBuildId)}/status`,
      undefined,
      opts.signal,
      parseBuildStatus,
    );
  }

  async runTests(opts: {
    providerProjectId: string;
    providerBuildId: string;
    signal?: AbortSignal;
  }): Promise<ProviderTestResult> {
    return gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/builds/${encodeURIComponent(opts.providerBuildId)}/tests`,
      {},
      opts.signal,
      parseTestResult,
    );
  }

  async createCandidate(opts: {
    providerProjectId: string;
    providerBuildId: string;
    provisioningRunId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderCandidateResult> {
    return gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/candidates`,
      {
        providerBuildId: opts.providerBuildId,
        provisioningRunId: opts.provisioningRunId,
        idempotencyKey: opts.idempotencyKey,
      },
      opts.signal,
      parseCandidateResult,
    );
  }

  async getCandidateStatus(opts: {
    providerProjectId: string;
    providerCandidateId: string;
    signal?: AbortSignal;
  }): Promise<{ healthy: boolean; launchUrl: string | null }> {
    return gatewayRequest(
      "GET",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/candidates/${encodeURIComponent(opts.providerCandidateId)}/status`,
      undefined,
      opts.signal,
      parseCandidateStatus,
    );
  }

  async publishCandidate(opts: {
    providerProjectId: string;
    providerCandidateId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderPublishResult> {
    return gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/candidates/${encodeURIComponent(opts.providerCandidateId)}/publish`,
      { idempotencyKey: opts.idempotencyKey },
      opts.signal,
      parsePublishResult,
    );
  }

  async cancelOperation(opts: {
    providerProjectId: string;
    providerBuildId?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/cancel`,
      { providerBuildId: opts.providerBuildId },
      opts.signal,
      () => undefined,
    );
  }

  async rollback(opts: {
    providerProjectId: string;
    providerReleaseId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ProviderRollbackResult> {
    return gatewayRequest(
      "POST",
      `/v1/projects/${encodeURIComponent(opts.providerProjectId)}/releases/${encodeURIComponent(opts.providerReleaseId)}/rollback`,
      { idempotencyKey: opts.idempotencyKey },
      opts.signal,
      parseRollbackResult,
    );
  }
}

// ─── Provider Registry (with test injection) ──────────────────────────────────

let activeProvider: ProvisioningProvider = new ReplitGatewayProvider();

/**
 * Get the active provisioning provider. Server-only.
 */
export function getProvisioningProvider(): ProvisioningProvider {
  return activeProvider;
}

/**
 * Override the provisioning provider for tests. Returns a restore function.
 * Must never be called from client code.
 */
export function overrideProvisioningProviderForTests(
  provider: ProvisioningProvider,
): () => void {
  const previous = activeProvider;
  activeProvider = provider;
  return () => {
    activeProvider = previous;
  };
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

/**
 * Wrap a provider call with a timeout, and optionally an outer cancellation
 * signal.
 *
 * A timeout throws ProvisioningTimeoutError. Outer cancellation (the worker's
 * cancel controller) throws a DOMException-like AbortError so callers can
 * distinguish an explicit cancel from a timeout and never report a cancel as a
 * timeout. The outer abort listener is always removed in finally to avoid
 * leaking a listener on every poll.
 */
export async function withProviderTimeout<T>(
  stage: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  // If the outer signal is already aborted, this is a cancellation, not a
  // timeout — surface an AbortError so the worker finalizes as cancelled.
  if (outerSignal?.aborted) {
    const err = new Error("Operation was cancelled");
    err.name = "AbortError";
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);

  try {
    return await fn(controller.signal);
  } catch (err) {
    // Outer cancellation takes precedence and is reported as an AbortError.
    if (outerSignal?.aborted) {
      const abortErr = new Error("Operation was cancelled");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    // Our own timer fired (not an outer cancel) → this is a timeout.
    if (controller.signal.aborted) {
      throw new ProvisioningTimeoutError(stage);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

// ─── Dangerous integration detection ─────────────────────────────────────────

/** Patterns that suggest credential-like or dangerous integration strings. */
const DANGEROUS_INTEGRATION_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /auth/i,
  /bearer/i,
  /access[_-]?key/i,
  /client[_-]?secret/i,
];

export function hasDangerousIntegrationStrings(integrations: string[]): boolean {
  return integrations.some((integration) =>
    DANGEROUS_INTEGRATION_PATTERNS.some((pattern) => pattern.test(integration)),
  );
}

// ─── Permission request validation ───────────────────────────────────────────

/** Capabilities that are not allowed in provisioning permission requests. */
const UNSUPPORTED_CAPABILITIES = new Set([
  "admin",
  "root",
  "sudo",
  "superuser",
  "database_write",
  "execute_arbitrary_code",
]);

export function hasUnsupportedPermissionRequests(
  permissionRequests: Array<{ capability: string; reason: string; required: boolean }>,
): boolean {
  return permissionRequests.some((req) =>
    UNSUPPORTED_CAPABILITIES.has(req.capability.toLowerCase()),
  );
}
