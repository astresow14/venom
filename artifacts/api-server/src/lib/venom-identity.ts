/**
 * Per-user identity records: who Venom recognizes each authenticated
 * account as, resolved from the auth provider (Clerk) into the
 * `venom_identities` table.
 *
 * Lifecycle: a record is created on first authenticated use, reused while
 * fresh, refreshed when stale, and deleted as soon as the auth provider
 * reports the user gone (the lazy equivalent of "remove personal data when
 * the user is deleted" — the next resolve attempt performs the cleanup).
 *
 * PII discipline: display name and email are personal data. They are
 * bounded before writing, returned only to the account they belong to (or
 * joined onto that account's own evidence), and NEVER logged. This module
 * intentionally performs no logging at all; keep it that way.
 */
import { clerkClient } from "@clerk/express";
import { eq, inArray } from "drizzle-orm";
import { db, venomIdentitiesTable, type VenomIdentityRow } from "@workspace/db";

export const VENOM_IDENTITY_BOUNDS = {
  userId: 120,
  displayName: 200,
  email: 320,
  provider: 60,
} as const;

/** How long a resolved identity stays fresh before the next use re-checks. */
export const VENOM_IDENTITY_REFRESH_MS = 6 * 60 * 60 * 1000;

export type VenomIdentity = {
  userId: string;
  displayName: string | null;
  email: string | null;
  provider: string | null;
};

/**
 * A profile as reported by the auth provider; `null` means the provider no
 * longer knows the user (deleted account).
 */
export type AuthProfile = {
  displayName: string | null;
  email: string | null;
  provider: string | null;
} | null;

export type AuthProfileFetcher = (userId: string) => Promise<AuthProfile>;

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emptyIdentity(userId: string): VenomIdentity {
  return { userId, displayName: null, email: null, provider: null };
}

function identityFromRow(userId: string, row: VenomIdentityRow): VenomIdentity {
  return {
    userId,
    displayName: bounded(row.displayName, VENOM_IDENTITY_BOUNDS.displayName),
    email: bounded(row.email, VENOM_IDENTITY_BOUNDS.email),
    provider: bounded(row.provider, VENOM_IDENTITY_BOUNDS.provider),
  };
}

/** Default fetcher: the Clerk backend API. */
async function fetchClerkProfile(userId: string): Promise<AuthProfile> {
  try {
    const user = await clerkClient.users.getUser(userId);
    const displayName = [user.firstName, user.lastName]
      .filter(
        (part): part is string =>
          typeof part === "string" && part.trim().length > 0,
      )
      .join(" ");
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses?.[0]?.emailAddress ??
      null;
    const externalProvider = user.externalAccounts?.[0]?.provider;
    const provider =
      typeof externalProvider === "string" && externalProvider.length > 0
        ? externalProvider.replace(/^oauth_/, "")
        : user.passwordEnabled
          ? "password"
          : null;
    return { displayName: displayName || null, email, provider };
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    if (status === 404) return null; // the account no longer exists upstream
    throw error;
  }
}

export type ResolveIdentityOptions = {
  /** Injectable for tests; defaults to the Clerk backend API. */
  fetchProfile?: AuthProfileFetcher;
  now?: number;
};

async function refreshIdentity(
  userId: string,
  staleRow: VenomIdentityRow | undefined,
  options: ResolveIdentityOptions,
): Promise<VenomIdentity> {
  const fetchProfile = options.fetchProfile ?? fetchClerkProfile;
  const now = options.now ?? Date.now();

  let profile: AuthProfile;
  try {
    profile = await fetchProfile(userId);
  } catch {
    // Auth provider unavailable. Serve the stale record when there is one;
    // otherwise an all-null identity. Nothing personal may reach a log, so
    // the error itself is deliberately dropped.
    return staleRow ? identityFromRow(userId, staleRow) : emptyIdentity(userId);
  }

  if (profile === null) {
    // The user was deleted upstream: remove their personal data.
    await db
      .delete(venomIdentitiesTable)
      .where(eq(venomIdentitiesTable.clerkUserId, userId));
    return emptyIdentity(userId);
  }

  const displayName = bounded(
    profile.displayName,
    VENOM_IDENTITY_BOUNDS.displayName,
  );
  const email = bounded(profile.email, VENOM_IDENTITY_BOUNDS.email);
  const provider = bounded(profile.provider, VENOM_IDENTITY_BOUNDS.provider);
  const refreshedAt = new Date(now);

  await db
    .insert(venomIdentitiesTable)
    .values({ clerkUserId: userId, displayName, email, provider, refreshedAt })
    .onConflictDoUpdate({
      target: venomIdentitiesTable.clerkUserId,
      set: { displayName, email, provider, refreshedAt },
    });

  return { userId, displayName, email, provider };
}

/**
 * Resolve who Venom recognizes an authenticated account as. Creates the
 * identity record on first authenticated use, reuses it while fresh, and
 * refreshes it when stale. Never throws on auth-provider failure — the
 * stale record (or an all-null identity) is served instead.
 */
export async function resolveVenomIdentity(
  userId: string,
  options: ResolveIdentityOptions = {},
): Promise<VenomIdentity> {
  const now = options.now ?? Date.now();
  const [row] = await db
    .select()
    .from(venomIdentitiesTable)
    .where(eq(venomIdentitiesTable.clerkUserId, userId))
    .limit(1);

  if (row && now - row.refreshedAt.getTime() < VENOM_IDENTITY_REFRESH_MS) {
    return identityFromRow(userId, row);
  }
  return refreshIdentity(userId, row, options);
}

/**
 * Resolve several identities at once (evidence rendering: at most the
 * bounded evidence list plus the owner). Fresh rows are answered from one
 * query; stale or missing ones go through the same refresh path as
 * resolveVenomIdentity.
 */
export async function resolveVenomIdentities(
  userIds: Iterable<string>,
  options: ResolveIdentityOptions = {},
): Promise<Map<string, VenomIdentity>> {
  const now = options.now ?? Date.now();
  const unique = [...new Set(userIds)].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  const identities = new Map<string, VenomIdentity>();
  if (unique.length === 0) return identities;

  const rows = await db
    .select()
    .from(venomIdentitiesTable)
    .where(inArray(venomIdentitiesTable.clerkUserId, unique));
  const rowById = new Map(rows.map((row) => [row.clerkUserId, row]));

  await Promise.all(
    unique.map(async (userId) => {
      const row = rowById.get(userId);
      if (row && now - row.refreshedAt.getTime() < VENOM_IDENTITY_REFRESH_MS) {
        identities.set(userId, identityFromRow(userId, row));
        return;
      }
      identities.set(userId, await refreshIdentity(userId, row, options));
    }),
  );

  return identities;
}

/**
 * The label a person is shown under in Brain evidence: name first, email
 * as fallback, null when the identity record has neither.
 */
export function identityDisplayLabel(
  identity: VenomIdentity | undefined,
): string | null {
  if (!identity) return null;
  return identity.displayName ?? identity.email ?? null;
}

/**
 * Presentation-time attribution defaulting: evidence captured before
 * attribution existed belongs to the ontology owner. Applied when
 * composing responses, never hardened into storage, so pre-attribution
 * rows stay recognizable as such.
 */
export function defaultEvidenceAttribution<
  T extends { capturedByUserId: string | null },
>(sources: T[], ownerUserId: string): T[] {
  return sources.map((evidence) =>
    evidence.capturedByUserId === null
      ? { ...evidence, capturedByUserId: ownerUserId }
      : evidence,
  );
}

/** Distinct person ids referenced by (already-defaulted) evidence. */
export function collectEvidencePersonIds(
  sources: { capturedByUserId: string | null }[],
  max: number,
): string[] {
  const ids: string[] = [];
  for (const evidence of sources) {
    const id = evidence.capturedByUserId;
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}
