/**
 * The canon store: Venom's curated global teachings.
 *
 * Rows are written only through the super-admin-gated canon routes; reads
 * for answer composition go through `loadActiveCanonTeachings`, which is
 * status-filtered at query time so a retired entry stops influencing
 * answers on the very next request.
 */

import { desc, eq } from "drizzle-orm";
import {
  db,
  venomCanonTeachingsTable,
  type VenomCanonTeachingRow,
  type VenomCanonTeachingStatus,
} from "@workspace/db";

/** Hard cap on stored teachings; commits beyond it are refused loudly. */
export const MAX_CANON_TEACHINGS = 1_000;

export type CanonTeachingRecord = {
  id: string;
  domain: string;
  title: string;
  principles: string[];
  status: VenomCanonTeachingStatus;
  taughtByClerkUserId: string;
  conversationId: string | null;
  conversationTitle: string | null;
  createdAt: number;
  updatedAt: number;
};

function toRecord(row: VenomCanonTeachingRow): CanonTeachingRecord {
  return {
    id: row.id,
    domain: row.domain,
    title: row.title,
    principles: Array.isArray(row.principles)
      ? row.principles.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    status: row.status,
    taughtByClerkUserId: row.taughtByClerkUserId,
    conversationId: row.conversationId,
    conversationTitle: row.conversationTitle,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export class CanonCapacityError extends Error {
  constructor() {
    super("The canon is at capacity.");
    this.name = "CanonCapacityError";
  }
}

export async function insertCanonTeaching(input: {
  domain: string;
  title: string;
  principles: string[];
  taughtByClerkUserId: string;
  conversationId?: string | null;
  conversationTitle?: string | null;
}): Promise<CanonTeachingRecord> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: venomCanonTeachingsTable.id })
      .from(venomCanonTeachingsTable)
      .limit(MAX_CANON_TEACHINGS);
    if (existing.length >= MAX_CANON_TEACHINGS) throw new CanonCapacityError();
    const [row] = await tx
      .insert(venomCanonTeachingsTable)
      .values({
        domain: input.domain,
        title: input.title,
        principles: input.principles,
        status: "active",
        taughtByClerkUserId: input.taughtByClerkUserId,
        conversationId: input.conversationId ?? null,
        conversationTitle: input.conversationTitle ?? null,
      })
      .returning();
    return toRecord(row);
  });
}

/** Every teaching, newest first — the management surface shows both statuses. */
export async function listCanonTeachings(): Promise<CanonTeachingRecord[]> {
  const rows = await db
    .select()
    .from(venomCanonTeachingsTable)
    .orderBy(desc(venomCanonTeachingsTable.createdAt))
    .limit(MAX_CANON_TEACHINGS);
  return rows.map(toRecord);
}

export type CanonTeachingPatch = {
  domain?: string;
  title?: string;
  principles?: string[];
  status?: VenomCanonTeachingStatus;
};

/**
 * Apply an edit or a retire/restore. Retiring stamps who and when; restoring
 * clears both. Every change stamps the editor. Returns null when no teaching
 * with this id exists.
 */
export async function updateCanonTeaching(input: {
  id: string;
  patch: CanonTeachingPatch;
  editorUserId: string;
}): Promise<CanonTeachingRecord | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(venomCanonTeachingsTable)
      .where(eq(venomCanonTeachingsTable.id, input.id))
      .limit(1);
    if (!current) return null;
    const nextStatus = input.patch.status ?? current.status;
    const [row] = await tx
      .update(venomCanonTeachingsTable)
      .set({
        ...(input.patch.domain !== undefined ? { domain: input.patch.domain } : {}),
        ...(input.patch.title !== undefined ? { title: input.patch.title } : {}),
        ...(input.patch.principles !== undefined
          ? { principles: input.patch.principles }
          : {}),
        status: nextStatus,
        lastEditedByClerkUserId: input.editorUserId,
        ...(nextStatus !== current.status
          ? nextStatus === "retired"
            ? {
                retiredAt: new Date(),
                retiredByClerkUserId: input.editorUserId,
              }
            : { retiredAt: null, retiredByClerkUserId: null }
          : {}),
      })
      .where(eq(venomCanonTeachingsTable.id, input.id))
      .returning();
    return row ? toRecord(row) : null;
  });
}

export type ActiveCanonTeaching = {
  domain: string;
  title: string;
  principles: string[];
  updatedAt: number;
};

/**
 * Active teachings only, for answer composition. Retired entries are
 * excluded here — at the query, not in any cache — so retirement takes
 * effect immediately for every user.
 */
export async function loadActiveCanonTeachings(): Promise<
  ActiveCanonTeaching[]
> {
  const rows = await db
    .select({
      domain: venomCanonTeachingsTable.domain,
      title: venomCanonTeachingsTable.title,
      principles: venomCanonTeachingsTable.principles,
      updatedAt: venomCanonTeachingsTable.updatedAt,
    })
    .from(venomCanonTeachingsTable)
    .where(eq(venomCanonTeachingsTable.status, "active"))
    .orderBy(desc(venomCanonTeachingsTable.updatedAt))
    .limit(MAX_CANON_TEACHINGS);
  return rows.map((row) => ({
    domain: row.domain,
    title: row.title,
    principles: Array.isArray(row.principles)
      ? row.principles.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    updatedAt: row.updatedAt.getTime(),
  }));
}
