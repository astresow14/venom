/**
 * Ledger for automatic knowledge moves.
 *
 * Every automatic decision that files or re-files a user's knowledge across
 * the personal/workspace boundary leaves a row here, author-scoped:
 *
 * - `auto_file`  — extraction filed clusters straight into a workspace.
 *   The row carries everything undo needs to put the workspace store back
 *   exactly as it was and re-file the clusters into the author's personal
 *   Unsorted area instead.
 * - `refile`     — the re-filing pass moved a concept between stores after
 *   new knowledge clarified it (unsorted → workspace, or workspace →
 *   personal). Undo restores both stores.
 * - `suggestion` — a personal concept looks like workspace material. It
 *   NEVER moves silently, because accepting widens visibility to teammates:
 *   the row waits for the author's explicit accept (or dismiss).
 *
 * Rows are the author's private notices — they are only ever listed for
 * `userId`, and undo/accept/dismiss all re-verify ownership. Undo does not
 * require a live membership: retracting your own knowledge from a workspace
 * you since left must still work.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { db, venomKnowledgeMovesTable } from "@workspace/db";
import type {
  InsightCandidate,
  OntologyConcept,
} from "./venom-ontology-core";
import {
  fileExtractedKnowledge,
  moveOntologyConceptBetweenOwners,
  recreateConceptFromSnapshot,
  restoreConceptStates,
  userOwner,
  workspaceOwner,
  type OntologyDbTx,
  type OntologyOwner,
} from "./venom-ontology-store";

export type KnowledgeMoveKind = "auto_file" | "refile" | "suggestion";

export type KnowledgeMoveStatus =
  | "active"
  | "undone"
  | "expired"
  | "pending"
  | "accepted"
  | "dismissed";

/**
 * How long an automatic move stays undoable. Past this window the notice is
 * retired (lazily, on list/undo) instead of offering an undo whose snapshot
 * restore could erase everything that happened since.
 */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

type ConversationRef = { id: string; title: string; projectId: string | null };

/** Snapshot payload for an extraction that filed straight into a workspace. */
export type AutoFilePayload = {
  conversation: ConversationRef;
  candidates: InsightCandidate[];
  touched: Array<{ id: string; before: OntologyConcept | null }>;
  /**
   * Post-filing fingerprints of the workspace records the filing wrote.
   * Undo refuses unless every one still matches, so restoring the `touched`
   * snapshots can never erase a later edit, merge, or deletion — the
   * author's own or a teammate's. Rows without fingerprints refuse undo.
   */
  touchedAfter?: Array<{ id: string; lastUpdatedAt: number }>;
  /**
   * Ids of the personal-store records an undo created, written back onto
   * the row at undo time so the re-filing pass's recent-move window covers
   * them — otherwise the very next extraction could move a just-undone
   * concept straight back (ping-pong).
   */
  restoredConceptIds?: string[];
};

/** Snapshot payload for an automatic cross-store re-file. */
export type RefilePayload = {
  // "unsorted_to_workspace" survives only for legacy rows: since the
  // suggestion-gating of every personal-store exit, no producer writes it.
  direction: "unsorted_to_workspace" | "workspace_to_personal";
  movedConceptId: string;
  merged: boolean;
  sourceBefore: OntologyConcept;
  targetBefore: OntologyConcept | null;
  /** Post-move fingerprint of the target-store record; see `touchedAfter`. */
  afterUpdatedAt?: number;
  /** Project the moved copy landed under (personal targets only). */
  targetProjectId: string | null;
  /** See AutoFilePayload.restoredConceptIds. */
  restoredConceptIds?: string[];
};

/** Payload for a pending personal → workspace suggestion. */
export type SuggestionPayload = {
  conceptId: string;
  /** Project scope of the personal concept, for display/context. */
  projectId: string | null;
};

export type KnowledgeMoveRecord = {
  id: string;
  userId: string;
  kind: KnowledgeMoveKind;
  status: KnowledgeMoveStatus;
  fromOwner: OntologyOwner;
  toOwner: OntologyOwner;
  workspaceId: string | null;
  workspaceName: string | null;
  labels: string[];
  payload: AutoFilePayload | RefilePayload | SuggestionPayload;
  createdAt: Date;
  resolvedAt: Date | null;
};

function ownerFrom(ownerType: string, ownerId: string): OntologyOwner {
  return { ownerType, ownerId };
}

function recordFromRow(row: typeof venomKnowledgeMovesTable.$inferSelect): KnowledgeMoveRecord {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as KnowledgeMoveKind,
    status: row.status as KnowledgeMoveStatus,
    fromOwner: ownerFrom(row.fromOwnerType, row.fromOwnerId),
    toOwner: ownerFrom(row.toOwnerType, row.toOwnerId),
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    labels: Array.isArray(row.labels) ? (row.labels as string[]) : [],
    payload: row.payload as KnowledgeMoveRecord["payload"],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** Record an extraction filing straight into a workspace (undoable). */
export async function recordAutoFileNotice(input: {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  labels: string[];
  payload: AutoFilePayload;
  now?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(venomKnowledgeMovesTable).values({
    id,
    userId: input.userId,
    kind: "auto_file",
    status: "active",
    fromOwnerType: "user",
    fromOwnerId: input.userId,
    toOwnerType: "workspace",
    toOwnerId: input.workspaceId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    labels: input.labels,
    payload: input.payload,
    createdAt: new Date(input.now ?? Date.now()),
  });
  return id;
}

/** Record an automatic cross-store re-file (undoable). */
export async function recordRefileNotice(input: {
  userId: string;
  fromOwner: OntologyOwner;
  toOwner: OntologyOwner;
  workspaceId: string | null;
  workspaceName: string | null;
  label: string;
  payload: RefilePayload;
  now?: number;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(venomKnowledgeMovesTable).values({
    id,
    userId: input.userId,
    kind: "refile",
    status: "active",
    fromOwnerType: input.fromOwner.ownerType,
    fromOwnerId: input.fromOwner.ownerId,
    toOwnerType: input.toOwner.ownerType,
    toOwnerId: input.toOwner.ownerId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    labels: [input.label],
    payload: input.payload,
    createdAt: new Date(input.now ?? Date.now()),
  });
  return id;
}

/** How long a resolved suggestion suppresses re-suggesting the same pair. */
const SUGGESTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Record a personal → workspace suggestion unless the same concept/workspace
 * pair already has one pending, or was accepted/dismissed recently — a
 * dismissed suggestion must not pop straight back on the next filing.
 */
export async function recordSuggestion(input: {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  conceptId: string;
  label: string;
  projectId: string | null;
  now?: number;
}): Promise<string | null> {
  const now = input.now ?? Date.now();
  const existing = await db
    .select()
    .from(venomKnowledgeMovesTable)
    .where(
      and(
        eq(venomKnowledgeMovesTable.userId, input.userId),
        eq(venomKnowledgeMovesTable.kind, "suggestion"),
        eq(venomKnowledgeMovesTable.toOwnerId, input.workspaceId),
      ),
    );
  const duplicate = existing.some((row) => {
    const payload = row.payload as SuggestionPayload;
    if (payload.conceptId !== input.conceptId) return false;
    if (row.status === "pending") return true;
    const resolvedAt = row.resolvedAt?.getTime() ?? row.createdAt.getTime();
    return now - resolvedAt < SUGGESTION_COOLDOWN_MS;
  });
  if (duplicate) return null;

  const id = randomUUID();
  await db.insert(venomKnowledgeMovesTable).values({
    id,
    userId: input.userId,
    kind: "suggestion",
    status: "pending",
    fromOwnerType: "user",
    fromOwnerId: input.userId,
    toOwnerType: "workspace",
    toOwnerId: input.workspaceId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    labels: [input.label],
    payload: {
      conceptId: input.conceptId,
      projectId: input.projectId,
    } satisfies SuggestionPayload,
    createdAt: new Date(now),
  });
  return id;
}

const LIST_LIMIT = 20;

/**
 * The author's open items plus a short tail of recent history: active
 * notices and pending suggestions drive UI affordances (undo / accept), and
 * recently resolved rows let clients show "undone" states without a
 * separate feed.
 */
export async function listKnowledgeMoves(
  userId: string,
  now?: number,
): Promise<{
  notices: KnowledgeMoveRecord[];
  suggestions: KnowledgeMoveRecord[];
}> {
  const at = now ?? Date.now();
  // Lazily retire notices whose undo window has closed, so a client is
  // never shown an undo affordance the server would refuse.
  await db
    .update(venomKnowledgeMovesTable)
    .set({ status: "expired", resolvedAt: new Date(at) })
    .where(
      and(
        eq(venomKnowledgeMovesTable.userId, userId),
        eq(venomKnowledgeMovesTable.status, "active"),
        lt(
          venomKnowledgeMovesTable.createdAt,
          new Date(at - UNDO_WINDOW_MS),
        ),
      ),
    );
  const rows = await db
    .select()
    .from(venomKnowledgeMovesTable)
    .where(
      and(
        eq(venomKnowledgeMovesTable.userId, userId),
        inArray(venomKnowledgeMovesTable.status, [
          "active",
          "pending",
          "undone",
        ]),
      ),
    )
    .orderBy(desc(venomKnowledgeMovesTable.createdAt))
    .limit(LIST_LIMIT * 3);

  const records = rows.map(recordFromRow);
  const notices = records
    .filter((record) => record.kind !== "suggestion")
    .slice(0, LIST_LIMIT);
  const suggestions = records
    .filter(
      (record) => record.kind === "suggestion" && record.status === "pending",
    )
    .slice(0, LIST_LIMIT);
  return { notices, suggestions };
}

export async function getKnowledgeMove(
  userId: string,
  moveId: string,
): Promise<KnowledgeMoveRecord | null> {
  const [row] = await db
    .select()
    .from(venomKnowledgeMovesTable)
    .where(
      and(
        eq(venomKnowledgeMovesTable.id, moveId),
        eq(venomKnowledgeMovesTable.userId, userId),
      ),
    )
    .limit(1);
  return row ? recordFromRow(row) : null;
}

/** CAS one row from an expected status into a new one; false = lost race. */
async function transitionStatus(
  userId: string,
  moveId: string,
  from: KnowledgeMoveStatus,
  to: KnowledgeMoveStatus,
  now: number,
  tx?: OntologyDbTx,
): Promise<boolean> {
  const updated = await (tx ?? db)
    .update(venomKnowledgeMovesTable)
    .set({ status: to, resolvedAt: new Date(now) })
    .where(
      and(
        eq(venomKnowledgeMovesTable.id, moveId),
        eq(venomKnowledgeMovesTable.userId, userId),
        eq(venomKnowledgeMovesTable.status, from),
      ),
    )
    .returning({ id: venomKnowledgeMovesTable.id });
  return updated.length > 0;
}

export type UndoOutcome =
  | { outcome: "not_found" }
  | { outcome: "conflict"; status: KnowledgeMoveStatus }
  | { outcome: "expired" }
  | { outcome: "changed" }
  | {
      outcome: "undone";
      /** Personal-store records the undo created or restored (if any). */
      restored: OntologyConcept[];
    };

/**
 * Test-only failure injection for proving the undo transaction is atomic.
 * Production callers never pass this.
 */
export type UndoFailpoints = {
  /** Runs inside the undo transaction, after the destination-store restore
   * and before the source-side re-creation/filing. Throwing here must roll
   * the whole undo back. */
  afterDestinationRestore?: () => void;
};

/**
 * Reverse an automatic filing or re-file. Ownership is the only gate — no
 * membership check, because retracting your own knowledge from a workspace
 * you were removed from must keep working.
 *
 * Atomicity: the status claim (CAS active → undone, so two devices cannot
 * both restore), the destination-store restore, and the source-side
 * re-creation/filing all run in ONE database transaction. A failure at any
 * point unwinds everything — the stores keep the moved state, the notice
 * stays active, and a plain retry works. Knowledge can never be stranded
 * in neither store by a partial undo.
 *
 * Drift safety: a move is only undoable while the records it wrote are
 * exactly as it left them. The destination-store restore validates the
 * payload's post-move `lastUpdatedAt` fingerprints under row locks inside
 * this same transaction, so a teammate's edit can never slip between the
 * check and the write — it either commits first (undo refuses with
 * `changed` and the notice retires) or lands after the restore as its own
 * write. Legacy rows without fingerprints refuse fail-safe.
 */
export async function undoKnowledgeMove(
  userId: string,
  moveId: string,
  now?: number,
  failpoints?: UndoFailpoints,
): Promise<UndoOutcome> {
  const at = now ?? Date.now();
  const record = await getKnowledgeMove(userId, moveId);
  if (!record || record.kind === "suggestion") return { outcome: "not_found" };
  if (record.status !== "active") {
    return { outcome: "conflict", status: record.status };
  }
  if (at - record.createdAt.getTime() > UNDO_WINDOW_MS) {
    const flipped = await transitionStatus(
      userId,
      moveId,
      "active",
      "expired",
      at,
    );
    if (!flipped) {
      const current = await getKnowledgeMove(userId, moveId);
      if (current && current.status !== "active") {
        return { outcome: "conflict", status: current.status };
      }
    }
    return { outcome: "expired" };
  }
  return db.transaction(async (tx): Promise<UndoOutcome> => {
    const claimed = await transitionStatus(
      userId,
      moveId,
      "active",
      "undone",
      at,
      tx,
    );
    if (!claimed) {
      // Another device's transaction won the row; read the committed
      // status through our own transaction (a fresh db read could still
      // see the pre-claim snapshot).
      const [current] = await tx
        .select({ status: venomKnowledgeMovesTable.status })
        .from(venomKnowledgeMovesTable)
        .where(
          and(
            eq(venomKnowledgeMovesTable.id, moveId),
            eq(venomKnowledgeMovesTable.userId, userId),
          ),
        )
        .limit(1);
      return current
        ? {
            outcome: "conflict",
            status: current.status as KnowledgeMoveStatus,
          }
        : { outcome: "not_found" };
    }
    if (record.kind === "auto_file") {
      const payload = record.payload as AutoFilePayload;
      // Put the workspace store back exactly as it stood, then land the
      // clusters in the author's personal Unsorted area — undo means "that
      // was not workspace material (yet)", not "forget it entirely".
      const expected = payload.touchedAfter;
      const restoredCleanly =
        expected !== undefined &&
        expected.length > 0 &&
        (await restoreConceptStates(
          record.toOwner,
          payload.touched,
          at,
          expected,
          tx,
        ));
      if (!restoredCleanly) {
        // Terminal: the notice stops offering an undo it can no longer
        // honor. Nothing was written, so committing the flip is safe.
        await transitionStatus(userId, moveId, "undone", "expired", at, tx);
        return { outcome: "changed" };
      }
      failpoints?.afterDestinationRestore?.();
      const refiled = await fileExtractedKnowledge(
        {
          owner: userOwner(userId),
          capturedByUserId: userId,
          conversation: payload.conversation,
          candidates: payload.candidates.map((candidate) => ({
            ...candidate,
            unsorted: true,
          })),
          now: at,
        },
        tx,
      );
      await stampRestoredConceptIds(
        moveId,
        { ...payload, restoredConceptIds: refiled.filed.map((c) => c.id) },
        tx,
      );
      return { outcome: "undone", restored: refiled.filed };
    }

    const payload = record.payload as RefilePayload;
    const restoredCleanly =
      typeof payload.afterUpdatedAt === "number" &&
      (await restoreConceptStates(
        record.toOwner,
        [
          {
            id: payload.movedConceptId,
            before: payload.merged ? payload.targetBefore : null,
          },
        ],
        at,
        [
          {
            id: payload.movedConceptId,
            lastUpdatedAt: payload.afterUpdatedAt,
          },
        ],
        tx,
      ));
    if (!restoredCleanly) {
      // Terminal: the notice stops offering an undo it can no longer
      // honor. Nothing was written, so committing the flip is safe.
      await transitionStatus(userId, moveId, "undone", "expired", at, tx);
      return { outcome: "changed" };
    }
    failpoints?.afterDestinationRestore?.();
    const recreated = await recreateConceptFromSnapshot(
      record.fromOwner,
      payload.sourceBefore,
      at,
      tx,
    );
    await stampRestoredConceptIds(
      moveId,
      { ...payload, restoredConceptIds: [recreated.id] },
      tx,
    );
    return {
      outcome: "undone",
      restored: record.fromOwner.ownerType === "user" ? [recreated] : [],
    };
  });
}

export type SuggestionAcceptOutcome =
  | { outcome: "not_found" }
  | { outcome: "conflict"; status: KnowledgeMoveStatus }
  | { outcome: "gone" }
  | { outcome: "accepted"; moved: OntologyConcept; merged: boolean };

/**
 * Perform an accepted personal → workspace suggestion. The route MUST have
 * re-checked the author's live membership in `record.workspaceId` before
 * calling — this is the consent step that widens visibility, and it never
 * proceeds on a stale membership.
 */
export async function acceptKnowledgeSuggestion(
  userId: string,
  record: KnowledgeMoveRecord,
  now?: number,
): Promise<SuggestionAcceptOutcome> {
  const at = now ?? Date.now();
  if (record.kind !== "suggestion" || record.workspaceId === null) {
    return { outcome: "not_found" };
  }
  if (record.status !== "pending") {
    return { outcome: "conflict", status: record.status };
  }
  const claimed = await transitionStatus(
    userId,
    record.id,
    "pending",
    "accepted",
    at,
  );
  if (!claimed) {
    const current = await getKnowledgeMove(userId, record.id);
    return current
      ? { outcome: "conflict", status: current.status }
      : { outcome: "not_found" };
  }

  const payload = record.payload as SuggestionPayload;
  try {
    const moved = await moveOntologyConceptBetweenOwners({
      fromOwner: userOwner(userId),
      toOwner: workspaceOwner(record.workspaceId),
      conceptId: payload.conceptId,
      movedByUserId: userId,
      targetProjectId: null,
      now: at,
    });
    if (!moved) {
      // The personal concept vanished since (deleted on a device): the
      // suggestion is stale, and dismissed is the honest terminal state.
      await transitionStatus(userId, record.id, "accepted", "dismissed", at);
      return { outcome: "gone" };
    }
    return { outcome: "accepted", moved: moved.moved, merged: moved.merged };
  } catch (error) {
    await transitionStatus(userId, record.id, "accepted", "pending", at).catch(
      () => undefined,
    );
    throw error;
  }
}

export type DismissOutcome =
  | { outcome: "not_found" }
  | { outcome: "conflict"; status: KnowledgeMoveStatus }
  | { outcome: "dismissed" };

export async function dismissKnowledgeSuggestion(
  userId: string,
  moveId: string,
  now?: number,
): Promise<DismissOutcome> {
  const at = now ?? Date.now();
  const record = await getKnowledgeMove(userId, moveId);
  if (!record || record.kind !== "suggestion") return { outcome: "not_found" };
  if (record.status !== "pending") {
    return { outcome: "conflict", status: record.status };
  }
  const claimed = await transitionStatus(
    userId,
    moveId,
    "pending",
    "dismissed",
    at,
  );
  if (!claimed) {
    const current = await getKnowledgeMove(userId, moveId);
    return current
      ? { outcome: "conflict", status: current.status }
      : { outcome: "not_found" };
  }
  return { outcome: "dismissed" };
}

/**
 * Retire every open row that points at a workspace — used when a workspace
 * is deleted so stale notices cannot offer undos into a dead store.
 */
export async function dismissMovesForWorkspace(
  workspaceId: string,
  now?: number,
): Promise<void> {
  await db
    .update(venomKnowledgeMovesTable)
    .set({ status: "dismissed", resolvedAt: new Date(now ?? Date.now()) })
    .where(
      and(
        eq(venomKnowledgeMovesTable.workspaceId, workspaceId),
        inArray(venomKnowledgeMovesTable.status, ["active", "pending"]),
      ),
    );
}

/** Write undo-created concept ids back onto the ledger row (dedup fence). */
async function stampRestoredConceptIds(
  moveId: string,
  payload: AutoFilePayload | RefilePayload,
  tx?: OntologyDbTx,
): Promise<void> {
  await (tx ?? db)
    .update(venomKnowledgeMovesTable)
    .set({ payload })
    .where(eq(venomKnowledgeMovesTable.id, moveId));
}

/** Recent auto-file/refile activity used by the re-filing pass for dedup. */
export async function recentMoveConceptIds(
  userId: string,
  since: number,
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(venomKnowledgeMovesTable)
    .where(
      and(
        eq(venomKnowledgeMovesTable.userId, userId),
        gt(venomKnowledgeMovesTable.createdAt, new Date(since)),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    const payload = row.payload as Partial<RefilePayload & SuggestionPayload>;
    if (typeof payload.conceptId === "string") ids.add(payload.conceptId);
    if (payload.sourceBefore?.id) ids.add(payload.sourceBefore.id);
    if (typeof payload.movedConceptId === "string") {
      ids.add(payload.movedConceptId);
    }
    for (const restored of payload.restoredConceptIds ?? []) {
      ids.add(restored);
    }
  }
  return ids;
}
