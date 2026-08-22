/**
 * Platform super admins: the trusted humans allowed to teach Venom's canon.
 *
 * The `venom_super_admins` table is the single source of truth. Every
 * privileged request re-checks it live — clients only ever receive a derived
 * boolean on their own identity, and nothing a client sends can claim the
 * role. Designation is durable and by account id: the bootstrap resolves the
 * configured owner email to its auth-provider account exactly once and
 * stores the id, so a later email change on either side never grants or
 * strips the role at request time.
 *
 * Refusals are opaque on purpose (same pattern as workspace membership):
 * one 403 body for every canon endpoint regardless of whether the caller is
 * signed in but unprivileged, probing an unknown id, or sending malformed
 * params — the canon surface is invisible to anyone outside it.
 */

import { clerkClient } from "@clerk/express";
import { count, eq } from "drizzle-orm";
import { db, venomSuperAdminsTable, type VenomSuperAdminRow } from "@workspace/db";

export const CANON_ACCESS_DENIED_CODE = "canon_access_denied";

/** The one opaque refusal body every canon endpoint returns. */
export function canonAccessDeniedBody(): {
  error: string;
  code: typeof CANON_ACCESS_DENIED_CODE;
} {
  return {
    error: "You do not have access to this.",
    code: CANON_ACCESS_DENIED_CODE,
  };
}

/**
 * The bootstrap email comes exclusively from deployment configuration
 * (VENOM_SUPER_ADMIN_BOOTSTRAP_EMAIL). Deliberately no in-code default: an
 * unconfigured deployment must designate nobody (fail closed) rather than
 * hand a committed external address the global canon-admin role.
 */
export function superAdminBootstrapEmail(): string | null {
  const configured = process.env.VENOM_SUPER_ADMIN_BOOTSTRAP_EMAIL?.trim();
  return configured && configured.length > 0 ? configured : null;
}

// ─── Auth-provider directory (injectable for tests) ─────────────────────────

export type SuperAdminDirectoryAccount = {
  userId: string;
  /** Whether THIS email address is verified on the account. */
  verified: boolean;
  /** Whether this email is the account's primary address. */
  primary: boolean;
};

export type SuperAdminDirectory = {
  getAccountsByEmail(email: string): Promise<SuperAdminDirectoryAccount[]>;
};

const clerkDirectory: SuperAdminDirectory = {
  async getAccountsByEmail(email) {
    const { data } = await clerkClient.users.getUserList({
      emailAddress: [email],
      limit: 10,
    });
    const wanted = email.toLowerCase();
    return data.map((user) => {
      const entry = user.emailAddresses?.find(
        (candidate) => candidate.emailAddress?.toLowerCase() === wanted,
      );
      return {
        userId: user.id,
        verified: entry?.verification?.status === "verified",
        primary:
          user.primaryEmailAddress?.emailAddress?.toLowerCase() === wanted,
      };
    });
  },
};

let directory: SuperAdminDirectory = clerkDirectory;

export function overrideSuperAdminDirectoryForTests(
  next: SuperAdminDirectory,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Super admin directory overrides are available only in tests");
  }
  const previous = directory;
  directory = next;
  return () => {
    directory = previous;
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

export type SuperAdminBootstrapOutcome =
  | "designated"
  | "already_bootstrapped"
  | "unconfigured"
  | "unresolved"
  | "failed";

type MinimalLog = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

const BOOTSTRAP_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

// In-process bootstrap state: dedup concurrent runs, avoid hammering the
// auth provider from the lazy fallback, and stop probing entirely once the
// table is known non-empty (grant/revoke invariants keep it that way).
let bootstrapKnownDone = false;
let lastBootstrapAttemptAt = 0;
let bootstrapInFlight: Promise<SuperAdminBootstrapOutcome> | null = null;

/** Test-only reset so bootstrap scenarios start from a cold process. */
export function resetSuperAdminBootstrapForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Super admin bootstrap reset is available only in tests");
  }
  bootstrapKnownDone = false;
  lastBootstrapAttemptAt = 0;
  bootstrapInFlight = null;
}

/**
 * Designate the first super admin without requiring any pre-existing admin:
 * resolve the configured owner email to its auth-provider account (the email
 * must be verified on that account) and durably store the account id. Safe
 * to call repeatedly — an already-populated table is left untouched, and the
 * email itself is configuration, never matched at request time.
 *
 * The email is deliberately absent from every log line (identity PII rule).
 */
export async function ensureSuperAdminBootstrap(
  log?: MinimalLog,
): Promise<SuperAdminBootstrapOutcome> {
  if (bootstrapKnownDone) return "already_bootstrapped";
  if (bootstrapInFlight) return bootstrapInFlight;
  lastBootstrapAttemptAt = Date.now();
  bootstrapInFlight = (async (): Promise<SuperAdminBootstrapOutcome> => {
    try {
      const [existing] = await db
        .select({ total: count() })
        .from(venomSuperAdminsTable);
      if ((existing?.total ?? 0) > 0) {
        bootstrapKnownDone = true;
        return "already_bootstrapped";
      }

      const email = superAdminBootstrapEmail();
      if (!email) {
        // Fail closed: no configured email means nobody is designated and
        // the directory is never consulted. The log names the variable,
        // never any address.
        log?.warn(
          { configured: false },
          "Super admin bootstrap skipped: VENOM_SUPER_ADMIN_BOOTSTRAP_EMAIL is not set",
        );
        return "unconfigured";
      }

      const accounts = await directory.getAccountsByEmail(email);
      const verified = accounts.filter((account) => account.verified);
      const chosen =
        verified.find((account) => account.primary) ?? verified[0] ?? null;
      if (!chosen) {
        log?.warn(
          { candidates: accounts.length, verified: verified.length },
          "Super admin bootstrap found no verified account for the configured email",
        );
        return "unresolved";
      }

      await db
        .insert(venomSuperAdminsTable)
        .values({ clerkUserId: chosen.userId, grantedByClerkUserId: null })
        .onConflictDoNothing();
      bootstrapKnownDone = true;
      log?.info({}, "Super admin bootstrap designated the configured owner account");
      return "designated";
    } catch (error) {
      log?.warn({ err: error }, "Super admin bootstrap failed");
      return "failed";
    } finally {
      bootstrapInFlight = null;
    }
  })();
  return bootstrapInFlight;
}

// ─── Role checks ─────────────────────────────────────────────────────────────

/**
 * Live role check, used by every privileged request. When the table has
 * never been populated (e.g. the auth provider was unreachable at boot),
 * this lazily retries the bootstrap under a cooldown so the owner account
 * still resolves to super admin without any manual step.
 */
export async function isSuperAdmin(clerkUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ clerkUserId: venomSuperAdminsTable.clerkUserId })
    .from(venomSuperAdminsTable)
    .where(eq(venomSuperAdminsTable.clerkUserId, clerkUserId))
    .limit(1);
  if (row) return true;
  if (
    !bootstrapKnownDone &&
    Date.now() - lastBootstrapAttemptAt >= BOOTSTRAP_RETRY_COOLDOWN_MS
  ) {
    const outcome = await ensureSuperAdminBootstrap();
    if (outcome === "designated") {
      const [retry] = await db
        .select({ clerkUserId: venomSuperAdminsTable.clerkUserId })
        .from(venomSuperAdminsTable)
        .where(eq(venomSuperAdminsTable.clerkUserId, clerkUserId))
        .limit(1);
      return Boolean(retry);
    }
  }
  return false;
}

export async function listSuperAdmins(): Promise<VenomSuperAdminRow[]> {
  return db
    .select()
    .from(venomSuperAdminsTable)
    .orderBy(venomSuperAdminsTable.createdAt)
    .limit(200);
}

export type GrantSuperAdminResult =
  | { outcome: "granted"; row: VenomSuperAdminRow }
  | { outcome: "already_admin" };

export async function grantSuperAdmin(input: {
  targetUserId: string;
  grantedByUserId: string;
}): Promise<GrantSuperAdminResult> {
  const [row] = await db
    .insert(venomSuperAdminsTable)
    .values({
      clerkUserId: input.targetUserId,
      grantedByClerkUserId: input.grantedByUserId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return { outcome: "already_admin" };
  bootstrapKnownDone = true;
  return { outcome: "granted", row };
}

export type RevokeSuperAdminOutcome =
  | "revoked"
  | "self_revocation"
  | "not_admin"
  | "last_admin";

/**
 * Revoke another admin's role. Two invariants keep the canon stewarded:
 * nobody removes themselves, and the last remaining admin can never be
 * removed (checked inside one transaction so concurrent revokes cannot
 * race the table to empty).
 */
export async function revokeSuperAdmin(input: {
  targetUserId: string;
  actorUserId: string;
}): Promise<RevokeSuperAdminOutcome> {
  if (input.targetUserId === input.actorUserId) return "self_revocation";
  return db.transaction(async (tx) => {
    // Lock every designation row for the transaction. The guard below is a
    // count-then-delete pair; without the locks two admins revoking two
    // different targets could each observe a safe count and together empty
    // the table. FOR UPDATE serializes racing revokes, so the loser re-reads
    // the survivor set and hits the last-admin guard instead.
    const rows = await tx
      .select({ clerkUserId: venomSuperAdminsTable.clerkUserId })
      .from(venomSuperAdminsTable)
      .for("update");
    if (!rows.some((row) => row.clerkUserId === input.targetUserId)) {
      return "not_admin";
    }
    if (rows.length <= 1) return "last_admin";
    await tx
      .delete(venomSuperAdminsTable)
      .where(eq(venomSuperAdminsTable.clerkUserId, input.targetUserId));
    return "revoked";
  });
}
