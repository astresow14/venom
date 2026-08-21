import {
  bigint,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { VENOM_ONTOLOGY_OWNER_TYPE_USER } from "./venom-ontology";

/**
 * Venom host profiles: the bonded-persona material for each owner.
 *
 * One bounded row per owner. `profile` holds the validated style-and-attitude
 * profile derived from the host's own chat messages (never long verbatim
 * quotes); the counters track how much material the bond rests on and drive
 * both the refresh cadence and the bonding level. Owner scoping mirrors the
 * ontology tables so organizations can bond later without a new store.
 */
export const venomHostProfilesTable = pgTable(
  "venom_host_profiles",
  {
    ownerType: text("owner_type")
      .notNull()
      .default(VENOM_ONTOLOGY_OWNER_TYPE_USER),
    ownerId: text("owner_id").notNull(),
    /** Validated HostStyleProfile JSON; null until the first derivation. */
    profile: jsonb("profile"),
    /** Host chat messages absorbed since the account first spoke. */
    absorbedMessageCount: integer("absorbed_message_count")
      .notNull()
      .default(0),
    /** Characters across absorbed messages (per-message contribution capped). */
    absorbedCharCount: bigint("absorbed_char_count", { mode: "number" })
      .notNull()
      .default(0),
    /** absorbedMessageCount at the last successful profile refresh. */
    profiledMessageCount: integer("profiled_message_count")
      .notNull()
      .default(0),
    /** ms epoch of the last refresh attempt claim; doubles as the cooldown gate. */
    lastRefreshAt: bigint("last_refresh_at", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerType, table.ownerId] }),
  ],
);

export type VenomHostProfileRow = typeof venomHostProfilesTable.$inferSelect;
