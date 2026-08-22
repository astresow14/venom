/**
 * Identity directory for Venom company workspaces.
 *
 * Identity lives with the auth provider (Clerk): user ids are Clerk user
 * ids and invite emails are matched against Clerk-verified addresses. The
 * managed Clerk instance cannot enable Clerk-native organizations
 * (organization_not_enabled_in_instance), so org records live in our
 * database while this module remains the single place that talks to the
 * auth provider — swapping to Clerk-native orgs later replaces this
 * directory, not the callers.
 */

import { clerkClient } from "@clerk/express";

export type VenomOrgIdentity = {
  userId: string;
  /** Human display name derived from the auth profile. */
  name: string;
  /**
   * Primary email, lower-cased, when one exists. Display metadata only —
   * it may be unverified and must never serve as invite-matching or
   * acceptance evidence.
   */
  primaryEmail: string | null;
  /**
   * Every Clerk-verified email, lower-cased. Invite matching and
   * acceptance run against these only; an account with no verified
   * address has an empty set and cannot be added to a company, see a
   * pending invite, or accept one.
   */
  emails: string[];
};

export interface VenomOrgDirectory {
  getIdentity(userId: string): Promise<VenomOrgIdentity>;
  /** Users whose verified emails include the given address. */
  findByEmail(email: string): Promise<VenomOrgIdentity[]>;
}

type ClerkEmail = {
  id: string;
  emailAddress: string;
  verification?: { status?: string | null } | null;
};

type ClerkUserLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: ClerkEmail[] | null;
};

export function identityFromClerkUser(user: ClerkUserLike): VenomOrgIdentity {
  const allEmails = Array.isArray(user.emailAddresses)
    ? user.emailAddresses
    : [];
  const verified = allEmails.filter(
    (entry) => entry.verification?.status === "verified",
  );
  // Invite authorization binds to Clerk-verified addresses only. An account
  // whose emails are all unverified gets an empty match set — it cannot be
  // directly added, cannot see a pending invite, and cannot accept one.
  // The primary address survives below strictly as display metadata.
  const primary = allEmails.find(
    (entry) => entry.id === user.primaryEmailAddressId,
  );
  const emails = [
    ...new Set(
      verified
        .map((entry) => entry.emailAddress.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const primaryEmail =
    (primary
      ? primary.emailAddress.trim().toLowerCase()
      : emails[0]) || null;

  const name =
    [user.firstName, user.lastName]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(" ") ||
    (user.username ?? "").trim() ||
    (primaryEmail ? primaryEmail.split("@")[0] : "") ||
    "Teammate";

  return {
    userId: user.id,
    name: name.slice(0, 120),
    primaryEmail,
    emails,
  };
}

const IDENTITY_CACHE_TTL_MS = 60_000;

/**
 * Directory backed by the Clerk Backend API, with a short identity cache so
 * bursts of org requests do not hammer the auth provider.
 */
export function createClerkOrgDirectory(): VenomOrgDirectory {
  const cache = new Map<string, { identity: VenomOrgIdentity; expiresAt: number }>();

  return {
    async getIdentity(userId: string): Promise<VenomOrgIdentity> {
      const cached = cache.get(userId);
      if (cached && cached.expiresAt > Date.now()) return cached.identity;
      const user = await clerkClient.users.getUser(userId);
      const identity = identityFromClerkUser(user as unknown as ClerkUserLike);
      cache.set(userId, {
        identity,
        expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
      });
      return identity;
    },

    async findByEmail(email: string): Promise<VenomOrgIdentity[]> {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return [];
      const response = await clerkClient.users.getUserList({
        emailAddress: [normalized],
        limit: 10,
      });
      const users: ClerkUserLike[] = Array.isArray(response)
        ? (response as ClerkUserLike[])
        : ((response as { data?: ClerkUserLike[] }).data ?? []);
      return users
        .map((user) => identityFromClerkUser(user))
        .filter((identity) => identity.emails.includes(normalized));
    },
  };
}
