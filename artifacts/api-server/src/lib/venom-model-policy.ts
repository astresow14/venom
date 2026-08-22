/**
 * Server-side resolution of the account-level model selection policy.
 *
 * The policy lives in the synced workspace snapshot (modelPreferences), so
 * it follows the account across devices; resolving it here — not in clients —
 * is what makes an auto policy hold on every device and in every mode, and
 * what lets a later task have workspace admins lock it.
 *
 * Only the one JSONB field is read per request; the snapshot itself can be
 * megabytes and never leaves the database here.
 */

import { db, venomWorkspacesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  resolveVenomModelSelectionPolicy,
  type VenomModelSelectionPolicy,
} from "./venom-models";

/**
 * Load the caller's model selection policy. Absent snapshots, absent
 * preferences, and unknown values all mean manual — exactly the behavior
 * before the policy existed. Database failures are the caller's to handle
 * (they fall back to manual and log); this loader never invents a policy.
 */
export async function loadVenomModelSelectionPolicy(
  userId: string,
): Promise<VenomModelSelectionPolicy> {
  const [row] = await db
    .select({
      policy: sql<
        string | null
      >`${venomWorkspacesTable.state} -> 'modelPreferences' ->> 'selectionPolicy'`,
    })
    .from(venomWorkspacesTable)
    .where(eq(venomWorkspacesTable.clerkUserId, userId))
    .limit(1);
  return resolveVenomModelSelectionPolicy(row?.policy);
}
