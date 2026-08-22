/**
 * Whitelabeled app AI: credential lifecycle, spend controls, and the
 * canonical usage ledger.
 *
 * Credentials authenticate provisioned apps against Venom's AI gateway.
 * The plaintext token exists only transiently — in the mint result that is
 * handed to the provisioning provider boundary — and is stored as a SHA-256
 * hash plus a short display prefix. Rotation revokes the old credential in
 * the same transaction that mints the new one, so a leaked token dies the
 * moment the owner rotates. Mint, rotate, and revoke all serialize on one
 * per-app advisory lock (with a partial unique active-credential index as
 * the DB backstop), so concurrent lifecycle calls have a defined order and
 * at most one credential is ever live.
 *
 * The usage ledger is canonical (owner, app, alias, token counts, cost basis
 * in micro-dollars) and cap enforcement is concurrency-safe: the spend gate
 * reserves headroom inside a per-app locked transaction BEFORE the provider
 * is dispatched, and settlement releases the reservation in the same
 * transaction that writes the ledger row — so parallel calls can never all
 * pass one below-cap read. Settlement is fire-and-forget for the observed
 * call; reservations leaked by a crash are reaped by the next gate. Money
 * leaves this module only as aggregated dollar numbers; per-token rates stay
 * in venom-usage-pricing.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  db,
  venomAiLedgerEntriesTable,
  venomAppAiCredentialsTable,
  venomAppAiReservationsTable,
  venomAppAiSettingsTable,
  venomCandidateReleasesTable,
  venomProvisioningRunsTable,
  type VenomAppAiCredential,
  type VenomAppAiSettings,
} from "@workspace/db";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import { buildVenomCatalog } from "./venom-models";
import { computeCostMicros, microsToUsd } from "./venom-usage-pricing";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Gateway token prefix. `vak` = Venom app key. */
export const APP_AI_TOKEN_PREFIX = "vak_";

/** Characters of the token shown to owners (prefix + 8 hex). */
const DISPLAY_PREFIX_LENGTH = APP_AI_TOKEN_PREFIX.length + 8;

/**
 * Global per-app monthly safety cap (USD). Protects Venom even when the
 * owner sets no cap. Env-tunable, never client-tunable.
 */
const DEFAULT_SAFETY_CAP_USD = 25;

/** Env var names delivered into the provisioned app's secret storage. */
export const APP_AI_GATEWAY_URL_ENV = "VENOM_AI_GATEWAY_URL";
export const APP_AI_GATEWAY_KEY_ENV = "VENOM_AI_GATEWAY_KEY";

/** Gateway mount path (see app.ts) + OpenAI-compatible version segment. */
export const APP_AI_GATEWAY_BASE_PATH = "/api/app-gateway/v1";

export function appAiSafetyCapMicros(): number {
  const raw = Number(process.env.VENOM_APP_AI_SAFETY_CAP_USD);
  const usd = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SAFETY_CAP_USD;
  return Math.round(usd * 1_000_000);
}

/**
 * Public base URL hosted apps call the gateway on. Env override first, then
 * the deployment domains this server is reachable at.
 */
export function appAiGatewayBaseUrl(): string {
  const explicit = process.env.VENOM_AI_GATEWAY_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain =
    process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN?.trim();
  const origin = domain
    ? domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`
    : "http://localhost:5000";
  return `${origin.replace(/\/+$/, "")}${APP_AI_GATEWAY_BASE_PATH}`;
}

// ─── Credential lifecycle ─────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
  return `${APP_AI_TOKEN_PREFIX}${randomBytes(20).toString("hex")}`;
}

export type MintedAppAiCredential = {
  credential: VenomAppAiCredential;
  /** Plaintext token. Transient — hand to the provider boundary, never store or log. */
  secret: string;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialize writers touching one app's credential or spend state. The lock
 * is transaction-scoped (released at commit/rollback) and keyed on
 * scope + app, so credential rotation and spend gating never contend with
 * each other — only with themselves. Exported so tests can hold a scope
 * lock and prove the writers that claim to serialize actually do.
 */
export async function lockAppScope(
  tx: DbTransaction,
  scope: "credential" | "spend",
  appId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`venom-app-ai:${scope}:${appId}`}))`,
  );
}

function isUniqueViolation(error: unknown): boolean {
  for (
    let cause: unknown = error;
    typeof cause === "object" && cause !== null;
    cause = (cause as { cause?: unknown }).cause
  ) {
    if ((cause as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * Mint a fresh active credential for an app, revoking any previous active
 * one in the same transaction. Rotations are serialized per app by an
 * advisory lock, and the partial unique index on active credentials is the
 * DB backstop — a racing writer that somehow slips past the lock fails
 * instead of leaving two live tokens. One retry absorbs that backstop
 * firing, re-running the revoke+insert against the settled state.
 */
export async function mintAppAiCredential(
  userId: string,
  appId: string,
): Promise<MintedAppAiCredential> {
  try {
    return await mintAppAiCredentialOnce(userId, appId);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return await mintAppAiCredentialOnce(userId, appId);
  }
}

async function mintAppAiCredentialOnce(
  userId: string,
  appId: string,
): Promise<MintedAppAiCredential> {
  const secret = generateToken();
  const now = new Date();
  const credential = await db.transaction(async (tx) => {
    await lockAppScope(tx, "credential", appId);
    await tx
      .update(venomAppAiCredentialsTable)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(venomAppAiCredentialsTable.appId, appId),
          eq(venomAppAiCredentialsTable.status, "active"),
        ),
      );
    const [created] = await tx
      .insert(venomAppAiCredentialsTable)
      .values({
        appId,
        clerkUserId: userId,
        tokenHash: hashToken(secret),
        displayPrefix: secret.slice(0, DISPLAY_PREFIX_LENGTH),
        status: "active",
      })
      .returning();
    return created;
  });
  return { credential, secret };
}

export async function getActiveAppAiCredential(
  appId: string,
): Promise<VenomAppAiCredential | null> {
  const [credential] = await db
    .select()
    .from(venomAppAiCredentialsTable)
    .where(
      and(
        eq(venomAppAiCredentialsTable.appId, appId),
        eq(venomAppAiCredentialsTable.status, "active"),
      ),
    )
    .limit(1);
  return credential ?? null;
}

/**
 * Revoke the app's active credential (server-side kill; idempotent).
 * Serialized with mint/rotate under the same per-app credential lock, so a
 * revoke racing a rotation has a defined order: whichever runs second acts
 * on the other's settled state, and the credential that was active when the
 * owner pressed revoke is dead in every interleaving — never silently
 * outlived by a token the revoke response implied was gone.
 */
export async function revokeAppAiCredential(
  userId: string,
  appId: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockAppScope(tx, "credential", appId);
    await tx
      .update(venomAppAiCredentialsTable)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(venomAppAiCredentialsTable.appId, appId),
          eq(venomAppAiCredentialsTable.clerkUserId, userId),
          eq(venomAppAiCredentialsTable.status, "active"),
        ),
      );
  });
}

/**
 * Resolve a presented gateway token to its active credential, or null.
 * Missing, malformed, revoked, and unknown tokens are indistinguishable to
 * callers by design.
 */
export async function resolveAppAiCredentialByToken(
  token: string,
): Promise<VenomAppAiCredential | null> {
  if (!token.startsWith(APP_AI_TOKEN_PREFIX) || token.length > 128) {
    return null;
  }
  const [credential] = await db
    .select()
    .from(venomAppAiCredentialsTable)
    .where(eq(venomAppAiCredentialsTable.tokenHash, hashToken(token)))
    .limit(1);
  if (!credential || credential.status !== "active") return null;
  return credential;
}

/** Fire-and-forget last-used stamp; freshness is cosmetic, never blocking. */
export function touchAppAiCredentialUse(credentialId: string): void {
  void db
    .update(venomAppAiCredentialsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(venomAppAiCredentialsTable.id, credentialId))
    .catch(() => {
      // Cosmetic timestamp only.
    });
}

export type AppAiCredentialDeliveryOutcome =
  | { delivered: true }
  | { delivered: false; reason: "superseded" };

/**
 * Run a provider secret write serialized with the credential lifecycle.
 * The `deliver` callback executes inside the same per-app credential lock
 * that mint, rotate, and revoke take, after re-checking that the credential
 * being delivered is still the app's active one:
 *
 * - A rotation cannot mint a successor while a delivery is in flight — it
 *   waits, then performs its own delivery afterwards, so the LAST secret
 *   written to the provider project always belongs to the newest credential.
 * - A delayed delivery whose credential was superseded or revoked while it
 *   queued observes the stale status and skips the provider write entirely,
 *   instead of clobbering the newer key the deployed app should be using.
 *
 * The delivered stamp rides the same transaction, so `deliveredAt` never
 * describes a secret the provider project doesn't actually hold.
 */
export async function deliverAppAiCredentialSerialized(
  appId: string,
  credentialId: string,
  providerProjectId: string,
  deliver: () => Promise<void>,
): Promise<AppAiCredentialDeliveryOutcome> {
  return await db.transaction(
    async (tx): Promise<AppAiCredentialDeliveryOutcome> => {
      await lockAppScope(tx, "credential", appId);
      const [row] = await tx
        .select({ status: venomAppAiCredentialsTable.status })
        .from(venomAppAiCredentialsTable)
        .where(
          and(
            eq(venomAppAiCredentialsTable.id, credentialId),
            eq(venomAppAiCredentialsTable.appId, appId),
          ),
        )
        .limit(1);
      if (!row || row.status !== "active") {
        return { delivered: false, reason: "superseded" };
      }
      await deliver();
      await tx
        .update(venomAppAiCredentialsTable)
        .set({
          deliveredAt: new Date(),
          deliveredProviderProjectId: providerProjectId,
          updatedAt: new Date(),
        })
        .where(eq(venomAppAiCredentialsTable.id, credentialId));
      return { delivered: true };
    },
  );
}

export type RuntimeCredentialPreparation = {
  credentialId: string;
  /** Env vars for the provisioned app's secret storage. Transient — never log. */
  envVars: Record<string, string>;
};

/**
 * Decide what (if anything) must be delivered into an app's secret storage
 * for this provisioning handoff:
 *
 * - Active credential already delivered to THIS provider project → nothing;
 *   the project's secret storage still holds it (plaintext is long gone
 *   server-side, and that is fine).
 * - No active credential, an undelivered one (its plaintext is lost), or one
 *   delivered to a different project → mint fresh (revoking the old) and
 *   deliver. Undelivered credentials serve no deployed app, so replacing
 *   them is always safe.
 */
export async function prepareAppAiCredentialForHandoff(
  userId: string,
  appId: string,
  providerProjectId: string,
): Promise<RuntimeCredentialPreparation | null> {
  const active = await getActiveAppAiCredential(appId);
  if (
    active &&
    active.deliveredAt &&
    active.deliveredProviderProjectId === providerProjectId
  ) {
    return null;
  }
  const minted = await mintAppAiCredential(userId, appId);
  return {
    credentialId: minted.credential.id,
    envVars: {
      [APP_AI_GATEWAY_URL_ENV]: appAiGatewayBaseUrl(),
      [APP_AI_GATEWAY_KEY_ENV]: minted.secret,
    },
  };
}

/**
 * Provider project currently associated with an app — the newest candidate
 * release's project, falling back to the newest provisioning run that got
 * far enough to have one. Null when the app has never been provisioned.
 */
export async function findAppProviderProjectId(
  userId: string,
  appId: string,
): Promise<string | null> {
  const [release] = await db
    .select({ providerProjectId: venomCandidateReleasesTable.providerProjectId })
    .from(venomCandidateReleasesTable)
    .where(
      and(
        eq(venomCandidateReleasesTable.appId, appId),
        eq(venomCandidateReleasesTable.clerkUserId, userId),
      ),
    )
    .orderBy(desc(venomCandidateReleasesTable.createdAt))
    .limit(1);
  if (release?.providerProjectId) return release.providerProjectId;
  const [run] = await db
    .select({ providerProjectId: venomProvisioningRunsTable.providerProjectId })
    .from(venomProvisioningRunsTable)
    .where(
      and(
        eq(venomProvisioningRunsTable.appId, appId),
        eq(venomProvisioningRunsTable.clerkUserId, userId),
        isNotNull(venomProvisioningRunsTable.providerProjectId),
      ),
    )
    .orderBy(desc(venomProvisioningRunsTable.updatedAt))
    .limit(1);
  return run?.providerProjectId ?? null;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function loadAppAiSettings(
  appId: string,
): Promise<VenomAppAiSettings | null> {
  const [settings] = await db
    .select()
    .from(venomAppAiSettingsTable)
    .where(eq(venomAppAiSettingsTable.appId, appId))
    .limit(1);
  return settings ?? null;
}

export async function upsertAppAiSettings(
  userId: string,
  appId: string,
  update: { monthlyCapMicros: number | null; paused: boolean },
): Promise<VenomAppAiSettings> {
  const [row] = await db
    .insert(venomAppAiSettingsTable)
    .values({
      appId,
      clerkUserId: userId,
      monthlyCapMicros: update.monthlyCapMicros,
      paused: update.paused,
    })
    .onConflictDoUpdate({
      target: venomAppAiSettingsTable.appId,
      set: {
        monthlyCapMicros: update.monthlyCapMicros,
        paused: update.paused,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

// ─── Canonical ledger ─────────────────────────────────────────────────────────

export type AppAiLedgerInput = {
  userId: string;
  appId: string;
  credentialId: string;
  /** Venom-branded alias — never a provider SKU. */
  modelAlias: string;
  promptTokens: number;
  outputTokens: number;
  estimated: boolean;
  occurredAt?: Date;
};

function ledgerRowValues(input: AppAiLedgerInput) {
  const promptTokens = Math.max(0, Math.round(input.promptTokens));
  const outputTokens = Math.max(0, Math.round(input.outputTokens));
  return {
    id: randomUUID(),
    clerkUserId: input.userId,
    appId: input.appId,
    credentialId: input.credentialId,
    occurredAt: input.occurredAt ?? new Date(),
    callKind: "chat_completion",
    modelAlias: input.modelAlias,
    promptTokens,
    outputTokens,
    estimated: input.estimated,
    costMicros: computeCostMicros(input.modelAlias, promptTokens, outputTokens),
  };
}

/** Test seam: awaitable insert. Production paths settle via recordAppAiSettlement. */
export async function insertAppAiLedgerEntry(
  input: AppAiLedgerInput,
): Promise<void> {
  await db.insert(venomAiLedgerEntriesTable).values(ledgerRowValues(input));
}

// ─── Month aggregation ────────────────────────────────────────────────────────

export type AppAiMonthWindow = { periodStart: Date; periodEnd: Date };

export function appAiMonthWindow(now: Date = new Date()): AppAiMonthWindow {
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ),
  };
}

/** Month-to-date gateway spend for one app, in micro-dollars. */
export async function loadAppAiMonthSpendMicros(
  appId: string,
  now: Date = new Date(),
): Promise<number> {
  const { periodStart, periodEnd } = appAiMonthWindow(now);
  const [row] = await db
    .select({
      costMicros: sql<string>`coalesce(sum(${venomAiLedgerEntriesTable.costMicros}), 0)::bigint`,
    })
    .from(venomAiLedgerEntriesTable)
    .where(
      and(
        eq(venomAiLedgerEntriesTable.appId, appId),
        gte(venomAiLedgerEntriesTable.occurredAt, periodStart),
        lt(venomAiLedgerEntriesTable.occurredAt, periodEnd),
      ),
    );
  return Number(row?.costMicros ?? 0);
}

/** Venom-branded display name for a ledger alias. Never a provider SKU. */
function displayNameFor(alias: string): string {
  const entry = buildVenomCatalog().find((model) => model.id === alias);
  return entry?.name ?? alias;
}

export type AppAiUsageSummary = {
  periodStart: string;
  periodEnd: string;
  costUsd: number;
  requests: number;
  promptTokens: number;
  outputTokens: number;
  hasEstimates: boolean;
  models: Array<{
    modelId: string;
    modelName: string;
    costUsd: number;
    requests: number;
  }>;
};

export async function loadAppAiUsageSummary(
  appId: string,
  now: Date = new Date(),
): Promise<AppAiUsageSummary> {
  const { periodStart, periodEnd } = appAiMonthWindow(now);
  const rows = await db
    .select({
      modelAlias: venomAiLedgerEntriesTable.modelAlias,
      requests: sql<number>`count(*)::int`,
      promptTokens: sql<string>`coalesce(sum(${venomAiLedgerEntriesTable.promptTokens}), 0)::bigint`,
      outputTokens: sql<string>`coalesce(sum(${venomAiLedgerEntriesTable.outputTokens}), 0)::bigint`,
      costMicros: sql<string>`coalesce(sum(${venomAiLedgerEntriesTable.costMicros}), 0)::bigint`,
      hasEstimates: sql<boolean>`bool_or(${venomAiLedgerEntriesTable.estimated})`,
    })
    .from(venomAiLedgerEntriesTable)
    .where(
      and(
        eq(venomAiLedgerEntriesTable.appId, appId),
        gte(venomAiLedgerEntriesTable.occurredAt, periodStart),
        lt(venomAiLedgerEntriesTable.occurredAt, periodEnd),
      ),
    )
    .groupBy(venomAiLedgerEntriesTable.modelAlias);

  const models = rows
    .map((row) => ({
      modelId: row.modelAlias,
      modelName: displayNameFor(row.modelAlias),
      costUsd: microsToUsd(Number(row.costMicros)),
      requests: row.requests,
    }))
    .sort(
      (a, b) => b.costUsd - a.costUsd || a.modelName.localeCompare(b.modelName),
    );

  let costMicros = 0;
  let requests = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    costMicros += Number(row.costMicros);
    requests += row.requests;
    promptTokens += Number(row.promptTokens);
    outputTokens += Number(row.outputTokens);
  }

  return {
    periodStart: periodStart.toISOString().slice(0, 10),
    periodEnd: periodEnd.toISOString().slice(0, 10),
    costUsd: microsToUsd(costMicros),
    requests,
    promptTokens,
    outputTokens,
    hasEstimates: rows.some((row) => row.hasEstimates),
    models,
  };
}

/** Month-to-date gateway spend across ALL of an owner's apps, micro-dollars. */
export async function loadOwnerAiMonthSpendMicros(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const { periodStart, periodEnd } = appAiMonthWindow(now);
  const [row] = await db
    .select({
      costMicros: sql<string>`coalesce(sum(${venomAiLedgerEntriesTable.costMicros}), 0)::bigint`,
    })
    .from(venomAiLedgerEntriesTable)
    .where(
      and(
        eq(venomAiLedgerEntriesTable.clerkUserId, userId),
        gte(venomAiLedgerEntriesTable.occurredAt, periodStart),
        lt(venomAiLedgerEntriesTable.occurredAt, periodEnd),
      ),
    );
  return Number(row?.costMicros ?? 0);
}

// ─── Spend gate ───────────────────────────────────────────────────────────────

/** Reservations older than this are leaked (crash / failed settlement). */
const RESERVATION_STALE_MS = 10 * 60 * 1000;

/**
 * Output-token ceiling for gateway calls. The gateway forwards this to the
 * provider AND prices it into the spend reservation, which is what makes a
 * reservation an honest upper bound instead of a flat guess. Default is
 * env-tunable; a request's own max_tokens (already schema-capped) wins.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const PROVIDER_MAX_OUTPUT_TOKENS = 8192;

/**
 * Prompt-side bound: deliberately conservative (3 chars/token vs the ~4 the
 * estimator uses) plus fixed per-request overhead, so real prompt cost sits
 * inside the reservation even for token-dense content.
 */
const PROMPT_BOUND_CHARS_PER_TOKEN = 3;
const PROMPT_BOUND_OVERHEAD_TOKENS = 32;

/** Floor: a mispriced alias must still hold headroom, never reserve $0. */
const MIN_RESERVATION_MICROS = 1_000;

export function appAiMaxOutputTokens(requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested) && requested >= 1) {
    return Math.min(Math.floor(requested), PROVIDER_MAX_OUTPUT_TOKENS);
  }
  const raw = Number(process.env.VENOM_APP_AI_MAX_OUTPUT_TOKENS);
  return Number.isFinite(raw) && raw >= 1
    ? Math.min(Math.floor(raw), PROVIDER_MAX_OUTPUT_TOKENS)
    : DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Price the request's worst case: conservative prompt-token bound plus the
 * output ceiling that is actually forwarded to the provider. The gate admits
 * a call only when this whole bound fits the remaining headroom, so a small
 * cap refuses a large unbounded request outright — and admits the same
 * request once the caller bounds it with a small max_tokens.
 */
export function appAiReservationBoundMicros(
  modelAlias: string,
  promptCharCount: number,
  maxOutputTokens: number,
): number {
  const promptBoundTokens =
    Math.ceil(Math.max(promptCharCount, 0) / PROMPT_BOUND_CHARS_PER_TOKEN) +
    PROMPT_BOUND_OVERHEAD_TOKENS;
  return Math.max(
    computeCostMicros(modelAlias, promptBoundTokens, maxOutputTokens),
    MIN_RESERVATION_MICROS,
  );
}

export type AppAiSpendReservation =
  | { allowed: true; reservationId: string }
  | {
      allowed: false;
      code: "app_ai_paused" | "app_ai_cap_reached" | "app_ai_safety_cap_reached";
    };

/**
 * Server-side pause/cap enforcement, evaluated per request BEFORE any
 * provider call — and concurrency-safe: pause, both caps, and the headroom
 * reservation are checked and written inside one per-app locked transaction.
 * A request is admitted only when its own priced bound fits what remains
 * under the cap (settled + already-reserved + this reservation ≤ cap), so
 * neither parallel calls nor a nearly exhausted cap can admit spend the cap
 * doesn't cover. Owner cap binds first when both are exceeded (it is the
 * owner's own limit); the global safety cap protects Venom when the owner
 * set none — or set one above it.
 *
 * Callers MUST settle an allowed reservation (recordAppAiSettlement) when
 * the observed call finishes, on every path; reservations leaked by a crash
 * are reaped here once they age past RESERVATION_STALE_MS.
 */
export async function reserveAppAiSpend(
  userId: string,
  appId: string,
  reservationMicros: number,
  now: Date = new Date(),
): Promise<AppAiSpendReservation> {
  const { periodStart, periodEnd } = appAiMonthWindow(now);
  return await db.transaction(async (tx): Promise<AppAiSpendReservation> => {
    await lockAppScope(tx, "spend", appId);
    const [settings] = await tx
      .select()
      .from(venomAppAiSettingsTable)
      .where(eq(venomAppAiSettingsTable.appId, appId))
      .limit(1);
    if (settings?.paused) {
      return { allowed: false, code: "app_ai_paused" };
    }
    // Reap leaked reservations so they cannot wedge the app until month end.
    await tx
      .delete(venomAppAiReservationsTable)
      .where(
        and(
          eq(venomAppAiReservationsTable.appId, appId),
          lt(
            venomAppAiReservationsTable.createdAt,
            new Date(now.getTime() - RESERVATION_STALE_MS),
          ),
        ),
      );
    const [spentRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${venomAiLedgerEntriesTable.costMicros}), 0)::bigint`,
      })
      .from(venomAiLedgerEntriesTable)
      .where(
        and(
          eq(venomAiLedgerEntriesTable.appId, appId),
          gte(venomAiLedgerEntriesTable.occurredAt, periodStart),
          lt(venomAiLedgerEntriesTable.occurredAt, periodEnd),
        ),
      );
    const [reservedRow] = await tx
      .select({
        total: sql<string>`coalesce(sum(${venomAppAiReservationsTable.amountMicros}), 0)::bigint`,
      })
      .from(venomAppAiReservationsTable)
      .where(eq(venomAppAiReservationsTable.appId, appId));
    const committed =
      Number(spentRow?.total ?? 0) + Number(reservedRow?.total ?? 0);
    const ownerCap = settings?.monthlyCapMicros ?? null;
    if (ownerCap !== null && committed + reservationMicros > ownerCap) {
      return { allowed: false, code: "app_ai_cap_reached" };
    }
    if (committed + reservationMicros > appAiSafetyCapMicros()) {
      return { allowed: false, code: "app_ai_safety_cap_reached" };
    }
    const [reservation] = await tx
      .insert(venomAppAiReservationsTable)
      .values({
        appId,
        clerkUserId: userId,
        amountMicros: Math.max(Math.round(reservationMicros), 0),
      })
      .returning({ id: venomAppAiReservationsTable.id });
    return { allowed: true, reservationId: reservation.id };
  });
}

/**
 * Release a reservation and write the canonical ledger row in one
 * transaction, under the same per-app spend lock the gate takes. Without
 * the lock a settlement could commit BETWEEN a gate's two aggregate reads
 * (ledger first, reservations second — separate statements see separate
 * snapshots under Read Committed): the gate would count neither the old
 * reservation nor the new ledger row and admit spend the cap doesn't
 * cover. Holding the lock means a settlement lands either wholly before a
 * gate's reads or wholly after them. `usage` null (the attempt consumed no
 * observable tokens) still releases the reservation.
 */
export async function settleAppAiSpend(
  appId: string,
  reservationId: string | null,
  usage: AppAiLedgerInput | null,
): Promise<void> {
  if (!reservationId && !usage) return;
  await db.transaction(async (tx) => {
    await lockAppScope(tx, "spend", appId);
    if (reservationId) {
      await tx
        .delete(venomAppAiReservationsTable)
        .where(eq(venomAppAiReservationsTable.id, reservationId));
    }
    if (usage) {
      await tx.insert(venomAiLedgerEntriesTable).values(ledgerRowValues(usage));
    }
  });
}

/** Fire-and-forget settlement. Never throws, never blocks the observed call. */
export function recordAppAiSettlement(
  appId: string,
  reservationId: string | null,
  usage: AppAiLedgerInput | null,
): void {
  void settleAppAiSpend(appId, reservationId, usage).catch((error) => {
    console.error("[venom-app-ai] failed to settle gateway usage", error);
  });
}
