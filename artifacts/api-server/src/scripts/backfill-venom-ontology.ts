/**
 * One-off backfill: import every existing user's workspace-snapshot
 * knowledge into the ontology store.
 *
 * The workspace routes also migrate lazily on first touch, so this script
 * exists to move everyone at once instead of waiting for each user to next
 * open Venom. Safe to re-run: owners that already migrated are skipped.
 *
 * Run with: pnpm --filter @workspace/api-server run backfill:ontology
 */
import { isNull, eq, and } from "drizzle-orm";
import {
  db,
  pool,
  venomOntologyOwnersTable,
  venomWorkspacesTable,
  VENOM_ONTOLOGY_OWNER_TYPE_USER,
} from "@workspace/db";
import { ensureOntologyOwner, userOwner } from "../lib/venom-ontology-store";

async function main() {
  const pending = await db
    .select({ clerkUserId: venomWorkspacesTable.clerkUserId })
    .from(venomWorkspacesTable)
    .leftJoin(
      venomOntologyOwnersTable,
      and(
        eq(venomOntologyOwnersTable.ownerType, VENOM_ONTOLOGY_OWNER_TYPE_USER),
        eq(venomOntologyOwnersTable.ownerId, venomWorkspacesTable.clerkUserId),
      ),
    )
    .where(isNull(venomOntologyOwnersTable.ownerId));

  console.log(`Backfilling ${pending.length} workspace owner(s)…`);
  let migrated = 0;
  let imported = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const result = await ensureOntologyOwner(userOwner(row.clerkUserId));
      if (result.migrated) {
        migrated += 1;
        imported += result.importedConceptCount;
      }
    } catch (error) {
      failed += 1;
      console.error(`Failed to migrate ${row.clerkUserId}:`, error);
    }
  }

  console.log(
    `Done. Migrated ${migrated} owner(s), imported ${imported} concept(s), ${failed} failure(s).`,
  );
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Backfill crashed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
