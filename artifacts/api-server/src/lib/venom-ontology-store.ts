/**
 * Drizzle-backed persistence for the Venom ontology store.
 *
 * The store is the durable system of record for each owner's knowledge
 * graph. Rows are keyed by an owner scope (individual users, organizations,
 * and shared workspaces) and round-trip losslessly through the client's
 * cluster JSON shape via the pure helpers in venom-ontology-core.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  venomOntologyConceptsTable,
  venomOntologyEvidenceTable,
  venomOntologyLinksTable,
  venomOntologyOwnersTable,
  venomOntologyTombstonesTable,
  venomWorkspacesTable,
  VENOM_ONTOLOGY_OWNER_TYPE_ORG,
  VENOM_ONTOLOGY_OWNER_TYPE_USER,
  VENOM_ONTOLOGY_OWNER_TYPE_WORKSPACE,
  type VenomOntologyConceptRow,
  type VenomOntologyEvidenceRow,
  type VenomOntologyLinkRow,
  type VenomOntologyTombstoneRow,
} from "@workspace/db";
import {
  contributeConceptGraph,
  masterTenantFromOwner,
} from "./venom-master-ontology";
import {
  applyEvidenceHygiene,
  applyInsightCandidates,
  injectKnowledgeIntoState,
  mergeConceptSets,
  mergeTombstoneRecords,
  normalizeLabel,
  ONTOLOGY_BOUNDS,
  placeConceptPosition,
  positionForLabel,
  readWorkspaceKnowledge,
  restrictEvidenceAttribution,
  sanitizeConcept,
  stripClustersFromState,
  type InsightCandidate,
  type OntologyConcept,
  type OntologyEvidence,
  type OntologyTombstone,
} from "./venom-ontology-core";
/**
 * A drizzle transaction handle for this database. Store operations that
 * accept one join the caller's transaction instead of opening their own,
 * letting multi-store sequences (e.g. a knowledge-move undo) commit or
 * roll back as a single unit.
 */
export type OntologyDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OntologyOwner = {
  ownerType: string;
  ownerId: string;
};

export const userOwner = (userId: string): OntologyOwner => ({
  ownerType: VENOM_ONTOLOGY_OWNER_TYPE_USER,
  ownerId: userId,
});

export const orgOwner = (orgId: string): OntologyOwner => ({
  ownerType: VENOM_ONTOLOGY_OWNER_TYPE_ORG,
  ownerId: orgId,
});
/**
 * Owner scope for a shared workspace. Rows under this scope are served only
 * through membership-checked endpoints and never ride the per-user sync
 * snapshot, so revoking membership actually revokes access.
 */
export const workspaceOwner = (workspaceId: string): OntologyOwner => ({
  ownerType: VENOM_ONTOLOGY_OWNER_TYPE_WORKSPACE,
  ownerId: workspaceId,
});
type DbClient = typeof db;
type TxClient = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type AnyClient = DbClient | TxClient;

export function generateConceptId(): string {
  return `cluster_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Row <-> concept mapping
// ---------------------------------------------------------------------------

function evidenceFromRow(row: VenomOntologyEvidenceRow): OntologyEvidence {
  return {
    conversationId: row.conversationId,
    projectId: row.projectId,
    conversationTitle: row.conversationTitle,
    messageIds: Array.isArray(row.messageIds)
      ? (row.messageIds as unknown[]).filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    excerpt: row.excerpt,
    updatedAt: row.updatedAt,
    capturedByUserId: row.capturedByUserId,
    // A capture time is only meaningful next to the capturing identity.
    capturedAt: row.capturedByUserId === null ? null : row.capturedAt,
    ...(row.sensitive ? { sensitive: true } : {}),
  };
}

function conceptFromRows(
  row: VenomOntologyConceptRow,
  evidence: OntologyEvidence[],
  links: string[],
): OntologyConcept {
  const concept: OntologyConcept = {
    id: row.conceptId,
    projectId: row.projectId,
    label: row.label,
    category: row.category,
    strength: row.strength,
    x: row.x,
    y: row.y,
    links,
    summary: row.summary,
    mentionCount: row.mentionCount,
    lastUpdatedAt: row.lastUpdatedAt,
    sources: [...evidence]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, ONTOLOGY_BOUNDS.evidencePerConcept),
  };
  if (row.description) concept.description = row.description;
  if (row.sensitive) concept.sensitive = true;
  if (row.adminOnly) concept.adminOnly = true;
  if (row.unsorted) concept.unsorted = true;
  return concept;
}

function tombstoneFromRow(row: VenomOntologyTombstoneRow): OntologyTombstone {
  return {
    id: row.conceptId,
    deletedAt: row.deletedAt,
    ...(row.replaced ? { replaced: true } : {}),
  };
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
  const [first, second] = canonicalPair(a, b);
  return `${first}\u0000${second}`;
}

/** Derive the canonical link pair set from concept adjacency lists. */
function linkPairsFromConcepts(
  concepts: OntologyConcept[],
): Map<string, { a: string; b: string; projectId: string | null; updatedAt: number }> {
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  const pairs = new Map<
    string,
    { a: string; b: string; projectId: string | null; updatedAt: number }
  >();
  for (const concept of concepts) {
    for (const linkId of concept.links) {
      const linked = conceptById.get(linkId);
      if (!linked || linked.id === concept.id) continue;
      const [a, b] = canonicalPair(concept.id, linked.id);
      const key = pairKey(a, b);
      if (!pairs.has(key)) {
        pairs.set(key, {
          a,
          b,
          projectId: concept.projectId,
          updatedAt: Math.max(concept.lastUpdatedAt, linked.lastUpdatedAt),
        });
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type LoadedOntology = {
  concepts: OntologyConcept[];
  tombstones: OntologyTombstone[];
};

async function loadOntology(
  client: AnyClient,
  owner: OntologyOwner,
): Promise<LoadedOntology> {
  const [conceptRows, evidenceRows, linkRows, tombstoneRows] =
    await Promise.all([
      client
        .select()
        .from(venomOntologyConceptsTable)
        .where(
          and(
            eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
            eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
          ),
        ),
      client
        .select()
        .from(venomOntologyEvidenceTable)
        .where(
          and(
            eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
            eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
          ),
        ),
      client
        .select()
        .from(venomOntologyLinksTable)
        .where(
          and(
            eq(venomOntologyLinksTable.ownerType, owner.ownerType),
            eq(venomOntologyLinksTable.ownerId, owner.ownerId),
          ),
        ),
      client
        .select()
        .from(venomOntologyTombstonesTable)
        .where(
          and(
            eq(venomOntologyTombstonesTable.ownerType, owner.ownerType),
            eq(venomOntologyTombstonesTable.ownerId, owner.ownerId),
          ),
        ),
    ]);

  return {
    concepts: assembleConcepts(conceptRows, evidenceRows, linkRows),
    tombstones: tombstoneRows.map(tombstoneFromRow),
  };
}

function assembleConcepts(
  conceptRows: VenomOntologyConceptRow[],
  evidenceRows: VenomOntologyEvidenceRow[],
  linkRows: VenomOntologyLinkRow[],
): OntologyConcept[] {
  const evidenceByConcept = new Map<string, OntologyEvidence[]>();
  for (const row of evidenceRows) {
    const list = evidenceByConcept.get(row.conceptId) ?? [];
    list.push(evidenceFromRow(row));
    evidenceByConcept.set(row.conceptId, list);
  }

  const linksByConcept = new Map<string, string[]>();
  for (const row of linkRows) {
    const forA = linksByConcept.get(row.conceptAId) ?? [];
    forA.push(row.conceptBId);
    linksByConcept.set(row.conceptAId, forA);
    const forB = linksByConcept.get(row.conceptBId) ?? [];
    forB.push(row.conceptAId);
    linksByConcept.set(row.conceptBId, forB);
  }

  return conceptRows.map((row) =>
    conceptFromRows(
      row,
      evidenceByConcept.get(row.conceptId) ?? [],
      linksByConcept.get(row.conceptId) ?? [],
    ),
  );
}

// ---------------------------------------------------------------------------
// Writing (diff-based)
// ---------------------------------------------------------------------------

function conceptRowValues(owner: OntologyOwner, concept: OntologyConcept) {
  return {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    conceptId: concept.id,
    projectId: concept.projectId,
    label: concept.label,
    normalizedLabel: normalizeLabel(concept.label),
    category: concept.category,
    summary: concept.summary,
    description: concept.description ?? null,
    strength: concept.strength,
    mentionCount: concept.mentionCount,
    x: concept.x,
    y: concept.y,
    lastUpdatedAt: concept.lastUpdatedAt,
    sensitive: concept.sensitive === true,
    adminOnly: concept.adminOnly === true,
    // The Unsorted holding area exists only in personal stores. Writing
    // through any other owner scope silently drops the flag, so a bug
    // upstream can never leave an author-private marker on shared rows.
    unsorted: owner.ownerType === "user" && concept.unsorted === true,
  };
}

function conceptFingerprint(concept: OntologyConcept): string {
  return JSON.stringify({
    ...concept,
    links: [...concept.links].sort(),
  });
}

/**
 * Persist the difference between the previously loaded ontology and the
 * post-merge concept set. Only changed concepts touch the database.
 */
async function persistOntologyDiff(
  client: AnyClient,
  owner: OntologyOwner,
  before: OntologyConcept[],
  after: OntologyConcept[],
): Promise<void> {
  const beforeById = new Map(
    before.map((concept) => [concept.id, conceptFingerprint(concept)]),
  );
  const afterById = new Map(after.map((concept) => [concept.id, concept]));

  const removedIds = before
    .filter((concept) => !afterById.has(concept.id))
    .map((concept) => concept.id);
  const changed = after.filter(
    (concept) => beforeById.get(concept.id) !== conceptFingerprint(concept),
  );

  for (const conceptId of removedIds) {
    await client
      .delete(venomOntologyConceptsTable)
      .where(
        and(
          eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
          eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
          eq(venomOntologyConceptsTable.conceptId, conceptId),
        ),
      );
    await client
      .delete(venomOntologyEvidenceTable)
      .where(
        and(
          eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
          eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
          eq(venomOntologyEvidenceTable.conceptId, conceptId),
        ),
      );
  }

  for (const concept of changed) {
    const values = conceptRowValues(owner, concept);
    await client
      .insert(venomOntologyConceptsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          venomOntologyConceptsTable.ownerType,
          venomOntologyConceptsTable.ownerId,
          venomOntologyConceptsTable.conceptId,
        ],
        set: {
          projectId: values.projectId,
          label: values.label,
          normalizedLabel: values.normalizedLabel,
          category: values.category,
          summary: values.summary,
          description: values.description,
          strength: values.strength,
          mentionCount: values.mentionCount,
          x: values.x,
          y: values.y,
          lastUpdatedAt: values.lastUpdatedAt,
          sensitive: values.sensitive,
          adminOnly: values.adminOnly,
          unsorted: values.unsorted,
        },
      });

    // Evidence is replaced wholesale per concept: the winning concept's
    // bounded evidence list is authoritative, exactly like the client merge.
    await client
      .delete(venomOntologyEvidenceTable)
      .where(
        and(
          eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
          eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
          eq(venomOntologyEvidenceTable.conceptId, concept.id),
        ),
      );
    if (concept.sources.length > 0) {
      await client.insert(venomOntologyEvidenceTable).values(
        concept.sources.map((evidence) => ({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          conceptId: concept.id,
          conversationId: evidence.conversationId,
          projectId: evidence.projectId,
          conversationTitle: evidence.conversationTitle,
          messageIds: evidence.messageIds,
          excerpt: evidence.excerpt,
          updatedAt: evidence.updatedAt,
          capturedByUserId: evidence.capturedByUserId,
          capturedAt: evidence.capturedAt,
          sensitive: evidence.sensitive === true,
        })),
      );
    }
  }

  // Links: diff canonical pair sets.
  const beforePairs = linkPairsFromConcepts(before);
  const afterPairs = linkPairsFromConcepts(after);
  for (const [key, pair] of beforePairs) {
    if (afterPairs.has(key)) continue;
    await client
      .delete(venomOntologyLinksTable)
      .where(
        and(
          eq(venomOntologyLinksTable.ownerType, owner.ownerType),
          eq(venomOntologyLinksTable.ownerId, owner.ownerId),
          eq(venomOntologyLinksTable.conceptAId, pair.a),
          eq(venomOntologyLinksTable.conceptBId, pair.b),
        ),
      );
  }
  const newPairs = [...afterPairs.entries()]
    .filter(([key]) => !beforePairs.has(key))
    .map(([, pair]) => pair);
  if (newPairs.length > 0) {
    await client
      .insert(venomOntologyLinksTable)
      .values(
        newPairs.map((pair) => ({
          ownerType: owner.ownerType,
          ownerId: owner.ownerId,
          conceptAId: pair.a,
          conceptBId: pair.b,
          projectId: pair.projectId,
          updatedAt: pair.updatedAt,
        })),
      )
      .onConflictDoNothing();
  }
}

async function upsertTombstones(
  client: AnyClient,
  owner: OntologyOwner,
  tombstones: OntologyTombstone[],
): Promise<void> {
  if (tombstones.length === 0) return;
  for (const marker of tombstones) {
    await client
      .insert(venomOntologyTombstonesTable)
      .values({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        conceptId: marker.id,
        deletedAt: marker.deletedAt,
        replaced: marker.replaced === true,
      })
      .onConflictDoUpdate({
        target: [
          venomOntologyTombstonesTable.ownerType,
          venomOntologyTombstonesTable.ownerId,
          venomOntologyTombstonesTable.conceptId,
        ],
        set: {
          deletedAt: sql`GREATEST(${venomOntologyTombstonesTable.deletedAt}, EXCLUDED.deleted_at)`,
          replaced: sql`${venomOntologyTombstonesTable.replaced} OR EXCLUDED.replaced`,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Lazy, idempotent migration: the first time an owner touches the ontology,
 * import the knowledge that still lives inside their workspace snapshot.
 * The owner row is the marker — once present, the blob is never imported
 * again, so deleting every concept later cannot re-trigger an import.
 */
export async function ensureOntologyOwner(
  owner: OntologyOwner,
): Promise<{ migrated: boolean; importedConceptCount: number }> {
  const [existing] = await db
    .select({ ownerId: venomOntologyOwnersTable.ownerId })
    .from(venomOntologyOwnersTable)
    .where(
      and(
        eq(venomOntologyOwnersTable.ownerType, owner.ownerType),
        eq(venomOntologyOwnersTable.ownerId, owner.ownerId),
      ),
    )
    .limit(1);
  if (existing) return { migrated: false, importedConceptCount: 0 };

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(venomOntologyOwnersTable)
      .values({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        importedConceptCount: 0,
      })
      .onConflictDoNothing()
      .returning({ ownerId: venomOntologyOwnersTable.ownerId });
    // Another request migrated this owner concurrently.
    if (!claimed) return { migrated: false, importedConceptCount: 0 };

    let importedConceptCount = 0;
    if (owner.ownerType === VENOM_ONTOLOGY_OWNER_TYPE_USER) {
      const [workspace] = await tx
        .select({ state: venomWorkspacesTable.state })
        .from(venomWorkspacesTable)
        .where(eq(venomWorkspacesTable.clerkUserId, owner.ownerId))
        .limit(1);

      if (workspace?.state) {
        const view = readWorkspaceKnowledge(workspace.state);
        const tombstoneById = new Map(
          view.conceptTombstones.map((marker) => [marker.id, marker]),
        );
        const imported = mergeConceptSets({
          stored: [],
          // Legacy blob evidence predates attribution, but restrict anyway:
          // nothing imported may claim another account's identity.
          incoming: restrictEvidenceAttribution(
            view.concepts,
            new Set([owner.ownerId]),
          ),
          tombstones: tombstoneById,
          liveProjectIds: view.liveProjectIds,
        });
        await persistOntologyDiff(tx, owner, [], imported);
        await upsertTombstones(tx, owner, view.conceptTombstones);
        importedConceptCount = imported.length;
        if (importedConceptCount > 0) {
          await tx
            .update(venomOntologyOwnersTable)
            .set({ importedConceptCount })
            .where(
              and(
                eq(venomOntologyOwnersTable.ownerType, owner.ownerType),
                eq(venomOntologyOwnersTable.ownerId, owner.ownerId),
              ),
            );
        }
      }
    }

    return { migrated: true, importedConceptCount };
  });
}

// ---------------------------------------------------------------------------
// Workspace sync integration
// ---------------------------------------------------------------------------

/**
 * Rebuild a client-visible snapshot from a stored (stripped) blob state.
 * Used by workspace GET, PUT responses, and 409 conflict snapshots.
 */
export async function hydrateWorkspaceStateWithKnowledge(
  userId: string,
  state: unknown,
): Promise<unknown> {
  if (state === null || state === undefined) return state;
  const owner = userOwner(userId);
  await ensureOntologyOwner(owner);
  const { concepts, tombstones } = await loadOntology(db, owner);
  return injectKnowledgeIntoState(state, concepts, tombstones);
}

/**
 * Reconcile an accepted workspace save into the ontology store and return
 * the snapshot state to send back (knowledge re-injected).
 *
 * Must only run after the optimistic-concurrency blob write succeeded: the
 * revision check is what guarantees the incoming snapshot saw the current
 * cloud state, exactly like today's client-side merge discipline.
 */
export async function absorbWorkspaceStateKnowledge(
  userId: string,
  state: unknown,
): Promise<unknown> {
  const owner = userOwner(userId);
  const view = readWorkspaceKnowledge(state);
  // Trust boundary: capture stamps in a client snapshot survive only when
  // they name this ontology's owner. A forged or foreign stamp is stripped
  // back to pre-attribution (which renders as the owner), so snapshots can
  // never attribute knowledge to somebody else — and never trick the server
  // into resolving an arbitrary account's identity.
  const incomingConcepts = restrictEvidenceAttribution(
    view.concepts,
    new Set([owner.ownerId]),
  );

  const result = await db.transaction(async (tx) => {
    const { concepts: stored, tombstones: storedTombstones } =
      await loadOntology(tx, owner);

    const tombstoneById = new Map(
      storedTombstones.map((marker) => [marker.id, marker]),
    );
    const incomingTombstones: OntologyTombstone[] = [];
    for (const marker of view.conceptTombstones) {
      const merged = mergeTombstoneRecords(tombstoneById.get(marker.id), marker);
      tombstoneById.set(marker.id, merged);
      incomingTombstones.push(merged);
    }

    const merged = mergeConceptSets({
      stored,
      incoming: incomingConcepts,
      tombstones: tombstoneById,
      liveProjectIds: view.liveProjectIds,
    });

    const hygiene = applyEvidenceHygiene({
      concepts: merged,
      incomingConceptIds: new Set(view.concepts.map((concept) => concept.id)),
      conversationDeletionTimes: view.conversationDeletionTimes,
    });

    const hygieneTombstones = hygiene.droppedConcepts.map((dropped) => {
      const merged = mergeTombstoneRecords(tombstoneById.get(dropped.id), {
        id: dropped.id,
        deletedAt: dropped.deletedAt,
      });
      tombstoneById.set(dropped.id, merged);
      return merged;
    });

    await persistOntologyDiff(tx, owner, stored, hygiene.concepts);
    await upsertTombstones(tx, owner, [
      ...incomingTombstones,
      ...hygieneTombstones,
    ]);

    return {
      concepts: hygiene.concepts,
      tombstones: [...tombstoneById.values()],
    };
  });

  return injectKnowledgeIntoState(
    stripClustersFromState(state),
    result.concepts,
    result.tombstones,
  );
}

export { stripClustersFromState };

// ---------------------------------------------------------------------------
// Server-side filing at extraction time
// ---------------------------------------------------------------------------

export type FiledKnowledge = {
  /** Concepts created, strengthened, or re-linked by this filing. */
  filed: OntologyConcept[];
  /**
   * Pre-filing snapshots of every touched concept, aligned with `filed`
   * by id: `before === null` means the filing created the concept. These
   * feed the auto-file notice so an undo can restore exactly what the
   * filing changed. Snapshots are taken before the pass's ambient strength
   * decay, i.e. they are the stored states the undo should restore.
   */
  touchedBefore: Array<{ id: string; before: OntologyConcept | null }>;
};

/**
 * File normalized extraction candidates straight into the owner's store.
 * Returns the concepts the filing touched (canonical server ids) so clients
 * apply the same records instead of generating their own ids.
 */
export async function fileExtractedKnowledge(input: {
  owner: OntologyOwner;
  /**
   * The account that initiated this capture, as verified by the caller
   * after every async boundary (model calls, token refreshes). For a
   * personal store it must equal the owning user — one account's knowledge
   * can never carry another account's identity. For a shared-workspace
   * store the route must have re-checked the capturer's current membership
   * for this very request, which is exactly the relaxation the personal
   * rule anticipated.
   */
  capturedByUserId: string;
  conversation: { id: string; title: string; projectId: string | null };
  candidates: InsightCandidate[];
  /**
   * When true (a non-admin member is filing into a shared workspace),
   * admin-only clusters are treated as nonexistent: they are held out of
   * the merge working set entirely — no label matches, no link targets,
   * not even the passive strength decay — and are persisted untouched.
   * A colliding label therefore files into a fresh, unrestricted concept
   * instead of mutating the hidden one.
   */
  excludeAdminOnlyConcepts?: boolean;
  now?: number;
}, withinTx?: OntologyDbTx): Promise<FiledKnowledge> {
  if (
    input.owner.ownerType === VENOM_ONTOLOGY_OWNER_TYPE_USER &&
    input.capturedByUserId !== input.owner.ownerId
  ) {
    // Deliberately id-free: the mismatch itself is the whole story.
    throw new Error(
      "Refusing to file knowledge: capture identity does not match the ontology owner",
    );
  }
  const owner = input.owner;
  await ensureOntologyOwner(owner);
  const now = input.now ?? Date.now();
  // The Unsorted holding area is personal-only: candidates aimed at any
  // shared store lose the flag before they can influence the merge.
  const candidates =
    owner.ownerType === VENOM_ONTOLOGY_OWNER_TYPE_USER
      ? input.candidates
      : input.candidates.map(({ unsorted: _unsorted, ...rest }) => rest);

  const runFiling = async (tx: OntologyDbTx) => {
    // Filing touches one project scope; other projects are never affected.
    const { concepts: allConcepts } = await loadOntology(tx, owner);
    const scopeConcepts = allConcepts
      .filter((concept) => concept.projectId === input.conversation.projectId)
      .sort(
        (a, b) => a.lastUpdatedAt - b.lastUpdatedAt || a.id.localeCompare(b.id),
      );
    // Restricted clusters are invisible to non-admin filings (see the input
    // doc). They must still be re-appended below, byte-for-byte, or the
    // persistence diff would read their absence as deletion.
    const excludeAdminOnly = input.excludeAdminOnlyConcepts === true;
    const withheldConcepts = excludeAdminOnly
      ? scopeConcepts.filter((concept) => concept.adminOnly === true)
      : [];
    const projectConcepts = excludeAdminOnly
      ? scopeConcepts.filter((concept) => concept.adminOnly !== true)
      : scopeConcepts;

    const { concepts: nextProjectConcepts, touchedIds } =
      applyInsightCandidates({
        projectConcepts,
        totalConceptCount: allConcepts.length,
        // The owner's map shows every project (and withheld admin-only
        // concepts stay on the admins' maps), so new spots must clear all
        // stored positions, not just this scope's.
        occupiedPositions: allConcepts,
        conversation: input.conversation,
        candidates,
        now,
        generateId: generateConceptId,
        capturedByUserId: input.capturedByUserId,
      });

    const otherConcepts = allConcepts.filter(
      (concept) => concept.projectId !== input.conversation.projectId,
    );
    await persistOntologyDiff(tx, owner, allConcepts, [
      ...otherConcepts,
      ...withheldConcepts,
      ...nextProjectConcepts,
    ]);

    const beforeById = new Map(
      scopeConcepts.map((concept) => [concept.id, concept]),
    );
    return {
      filed: nextProjectConcepts.filter((concept) =>
        touchedIds.has(concept.id),
      ),
      touchedBefore: [...touchedIds].map((id) => ({
        id,
        before: beforeById.get(id) ?? null,
      })),
      projectConcepts: nextProjectConcepts,
    };
  };
  const outcome = await (withinTx ? runFiling(withinTx) : db.transaction(runFiling));

  // Master-network contribution rides after the commit so a contribution
  // hiccup can never fail (or roll back) the filing itself. It is a no-op
  // unless this owner's tenant has explicitly opted in, and only labels,
  // categories, and label pairs cross the boundary — evidence, summaries,
  // and ids have no path through it.
  try {
    const tenant = masterTenantFromOwner(owner);
    if (tenant) {
      await contributeConceptGraph(tenant, outcome.projectConcepts, now);
    }
  } catch (error) {
    // Contribution must never break knowledge filing.
    console.error("venom master ontology contribution failed", error);
  }

  return { filed: outcome.filed, touchedBefore: outcome.touchedBefore };
}


/**
 * Load every concept in an owner's store (client cluster shape). Used by the
 * membership-checked workspace knowledge endpoint and the workspace chat
 * context builder.
 */
export async function loadOntologyConcepts(
  owner: OntologyOwner,
): Promise<OntologyConcept[]> {
  await ensureOntologyOwner(owner);
  const { concepts } = await loadOntology(db, owner);
  return concepts;
}

/** Load a single concept (client cluster shape) from an owner's store. */
export async function loadOntologyConcept(
  owner: OntologyOwner,
  conceptId: string,
): Promise<OntologyConcept | null> {
  const concepts = await loadOntologyConcepts(owner);
  return concepts.find((concept) => concept.id === conceptId) ?? null;
}

/**
 * Lock or unlock a concept. A deliberate direct UPDATE rather than a merge:
 * sensitivity is server-side state, so it must not bump lastUpdatedAt and
 * start merge wars with client snapshots.
 */
export async function setOntologyConceptSensitivity(
  owner: OntologyOwner,
  conceptId: string,
  sensitive: boolean,
): Promise<boolean> {
  const updated = await db
    .update(venomOntologyConceptsTable)
    .set({ sensitive })
    .where(
      and(
        eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
        eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
        eq(venomOntologyConceptsTable.conceptId, conceptId),
      ),
    )
    .returning({ conceptId: venomOntologyConceptsTable.conceptId });
  return updated.length > 0;
}

/**
 * Restrict or unrestrict a concept to workspace admins. Same contract as the
 * sensitivity lock: a deliberate direct UPDATE that never bumps
 * lastUpdatedAt, because the restriction is server-side state and must not
 * start merge wars with client snapshots.
 */
export async function setOntologyConceptRestriction(
  owner: OntologyOwner,
  conceptId: string,
  adminOnly: boolean,
): Promise<boolean> {
  const updated = await db
    .update(venomOntologyConceptsTable)
    .set({ adminOnly })
    .where(
      and(
        eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
        eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
        eq(venomOntologyConceptsTable.conceptId, conceptId),
      ),
    )
    .returning({ conceptId: venomOntologyConceptsTable.conceptId });
  return updated.length > 0;
}
/** Lock or unlock a single evidence entry. Same contract as the concept lock. */
export async function setOntologyEvidenceSensitivity(
  owner: OntologyOwner,
  conceptId: string,
  conversationId: string,
  sensitive: boolean,
): Promise<boolean> {
  const updated = await db
    .update(venomOntologyEvidenceTable)
    .set({ sensitive })
    .where(
      and(
        eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
        eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
        eq(venomOntologyEvidenceTable.conceptId, conceptId),
        eq(venomOntologyEvidenceTable.conversationId, conversationId),
      ),
    )
    .returning({ conceptId: venomOntologyEvidenceTable.conceptId });
  return updated.length > 0;
}
export type OntologySearchResult = {
  id: string;
  projectId: string | null;
  label: string;
  category: string;
  summary: string;
  strength: number;
  mentionCount: number;
  lastUpdatedAt: number;
  evidenceCount: number;
};

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Cross-project concept search over label and summary text. */
export async function searchOntologyConcepts(
  userId: string,
  query: string,
  limit: number,
): Promise<OntologySearchResult[]> {
  return searchOntologyConceptsForOwner(userOwner(userId), query, limit);
}

/** Concept search inside any owner scope (personal or company Brain). */
export async function searchOntologyConceptsForOwner(
  owner: OntologyOwner,
  query: string,
  limit: number,
): Promise<OntologySearchResult[]> {
  await ensureOntologyOwner(owner);

  const trimmed = query.trim();
  if (!trimmed) return [];
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  const prefixPattern = `${escapeLikePattern(normalizeLabel(trimmed))}%`;

  const rows = await db
    .select()
    .from(venomOntologyConceptsTable)
    .where(
      and(
        eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
        eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
        sql`(${venomOntologyConceptsTable.label} ILIKE ${pattern} OR ${venomOntologyConceptsTable.summary} ILIKE ${pattern})`,
      ),
    )
    .orderBy(
      sql`CASE
        WHEN ${venomOntologyConceptsTable.normalizedLabel} LIKE ${prefixPattern} THEN 0
        WHEN ${venomOntologyConceptsTable.label} ILIKE ${pattern} THEN 1
        ELSE 2
      END`,
      sql`${venomOntologyConceptsTable.strength} DESC`,
      sql`${venomOntologyConceptsTable.lastUpdatedAt} DESC`,
    )
    .limit(limit);

  const evidenceCounts = new Map<string, number>();
  if (rows.length > 0) {
    const countRows = await db
      .select({
        conceptId: venomOntologyEvidenceTable.conceptId,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(venomOntologyEvidenceTable)
      .where(
        and(
          eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
          eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
          inArray(
            venomOntologyEvidenceTable.conceptId,
            rows.map((row) => row.conceptId),
          ),
        ),
      )
      .groupBy(venomOntologyEvidenceTable.conceptId);
    for (const row of countRows) {
      evidenceCounts.set(row.conceptId, row.count);
    }
  }

  return rows.map((concept) => ({
    id: concept.conceptId,
    projectId: concept.projectId,
    label: concept.label,
    category: concept.category,
    summary: concept.summary,
    strength: concept.strength,
    mentionCount: concept.mentionCount,
    lastUpdatedAt: concept.lastUpdatedAt,
    evidenceCount: evidenceCounts.get(concept.conceptId) ?? 0,
  }));
}
export type OntologyConceptDetail = {
  concept: OntologyConcept;
  neighbors: OntologySearchResult[];
};

/** One concept with its evidence plus its linked neighbors. */
export async function getOntologyConceptDetail(
  userId: string,
  conceptId: string,
): Promise<OntologyConceptDetail | null> {
  return getOntologyConceptDetailForOwner(userOwner(userId), conceptId);
}

/** Concept detail inside any owner scope (personal or company Brain). */
export async function getOntologyConceptDetailForOwner(
  owner: OntologyOwner,
  conceptId: string,
): Promise<OntologyConceptDetail | null> {
  await ensureOntologyOwner(owner);

  const [conceptRow] = await db
    .select()
    .from(venomOntologyConceptsTable)
    .where(
      and(
        eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
        eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
        eq(venomOntologyConceptsTable.conceptId, conceptId),
      ),
    )
    .limit(1);
  if (!conceptRow) return null;

  const [evidenceRows, linkRowsA, linkRowsB] = await Promise.all([
    db
      .select()
      .from(venomOntologyEvidenceTable)
      .where(
        and(
          eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
          eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
          eq(venomOntologyEvidenceTable.conceptId, conceptId),
        ),
      ),
    db
      .select()
      .from(venomOntologyLinksTable)
      .where(
        and(
          eq(venomOntologyLinksTable.ownerType, owner.ownerType),
          eq(venomOntologyLinksTable.ownerId, owner.ownerId),
          eq(venomOntologyLinksTable.conceptAId, conceptId),
        ),
      ),
    db
      .select()
      .from(venomOntologyLinksTable)
      .where(
        and(
          eq(venomOntologyLinksTable.ownerType, owner.ownerType),
          eq(venomOntologyLinksTable.ownerId, owner.ownerId),
          eq(venomOntologyLinksTable.conceptBId, conceptId),
        ),
      ),
  ]);

  const neighborIds = [
    ...new Set([
      ...linkRowsA.map((row) => row.conceptBId),
      ...linkRowsB.map((row) => row.conceptAId),
    ]),
  ].filter((id) => id !== conceptId);

  let neighbors: OntologySearchResult[] = [];
  if (neighborIds.length > 0) {
    const neighborRows = await db
      .select()
      .from(venomOntologyConceptsTable)
      .where(
        and(
          eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
          eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
          sql`${venomOntologyConceptsTable.conceptId} IN (${sql.join(
            neighborIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      );
    neighbors = neighborRows
      .map((row) => ({
        id: row.conceptId,
        projectId: row.projectId,
        label: row.label,
        category: row.category,
        summary: row.summary,
        strength: row.strength,
        mentionCount: row.mentionCount,
        lastUpdatedAt: row.lastUpdatedAt,
        evidenceCount: 0,
      }))
      .sort((a, b) => b.strength - a.strength);
  }

  const concept = conceptFromRows(
    conceptRow,
    evidenceRows.map(evidenceFromRow),
    neighborIds,
  );

  return { concept, neighbors };
}

/**
 * The explicit promotion path: lift one personal concept, with its
 * evidence, into a company Brain. Merges by normalized label when the
 * company already knows the concept; otherwise inserts it, respecting org
 * tombstones so a concept the company deliberately retired cannot return
 * under a recycled id.
 */
export async function promoteConceptToOrg(input: {
  orgId: string;
  concept: unknown;
  /** Verified id of the member promoting; the only stamp evidence may keep. */
  promotedByUserId: string;
  /** Project ids shared with this org; any other project link is stripped. */
  keepProjectIds?: Set<string>;
  now?: number;
}): Promise<PromotedConcept> {
  const owner = orgOwner(input.orgId);
  await ensureOntologyOwner(owner);
  const now = input.now ?? Date.now();
  const parsed = sanitizeConcept(input.concept);
  if (!parsed) throw new InvalidConceptPayload("Invalid concept payload");
  // The payload is the promoter's device copy: evidence may only claim the
  // promoter's own identity, never another member's. Promotion is a
  // deliberate share, so the author-private Unsorted flag never crosses
  // into the shared store either.
  delete parsed.unsorted;
  const [sanitized] = restrictEvidenceAttribution(
    [parsed],
    new Set([input.promotedByUserId]),
  );

  return db.transaction(async (tx) => {
    const { concepts, tombstones } = await loadOntology(tx, owner);
    const tombstoneIds = new Set(tombstones.map((marker) => marker.id));
    const normalized = normalizeLabel(sanitized.label);
    const existing = concepts.find(
      (concept) => normalizeLabel(concept.label) === normalized,
    );

    const projectId =
      sanitized.projectId && input.keepProjectIds?.has(sanitized.projectId)
        ? sanitized.projectId
        : null;

    if (existing) {
      const evidenceByConversation = new Map(
        existing.sources.map((evidence) => [evidence.conversationId, evidence]),
      );
      for (const evidence of sanitized.sources) {
        const prior = evidenceByConversation.get(evidence.conversationId);
        if (!prior || evidence.updatedAt > prior.updatedAt) {
          evidenceByConversation.set(evidence.conversationId, evidence);
        }
      }
      const merged: OntologyConcept = {
        ...existing,
        strength: Math.min(
          1,
          Math.max(existing.strength, sanitized.strength) + 0.04,
        ),
        mentionCount: Math.min(
          existing.mentionCount + Math.max(1, sanitized.mentionCount),
          99_999,
        ),
        summary:
          sanitized.lastUpdatedAt >= existing.lastUpdatedAt && sanitized.summary
            ? sanitized.summary
            : existing.summary,
        lastUpdatedAt: now,
        sources: [...evidenceByConversation.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, ONTOLOGY_BOUNDS.evidencePerConcept),
      };
      const after = concepts.map((concept) =>
        concept.id === existing.id ? merged : concept,
      );
      await persistOntologyDiff(tx, owner, concepts, after);
      return { concept: merged, merged: true };
    }

    let conceptId = sanitized.id;
    if (
      concepts.some((concept) => concept.id === conceptId) ||
      tombstoneIds.has(conceptId)
    ) {
      conceptId = generateConceptId();
    }
    const created: OntologyConcept = {
      ...sanitized,
      id: conceptId,
      projectId,
      links: sanitized.links.filter((linkId) =>
        concepts.some((concept) => concept.id === linkId),
      ),
      lastUpdatedAt: now,
    };
    await persistOntologyDiff(tx, owner, concepts, [...concepts, created]);
    return { concept: created, merged: false };
  });
}

export type MovedConceptOutcome = {
  /** The target-store record after the move (merged or created). */
  moved: OntologyConcept;
  /** True when the concept merged into an existing target concept. */
  merged: boolean;
  /** Snapshot of the source concept as it stood before the move. */
  sourceBefore: OntologyConcept;
  /** Prior state of the target concept when merged, else null. */
  targetBefore: OntologyConcept | null;
};

/**
 * Move one concept between ontology stores (personal ⇄ workspace) in a
 * single transaction: merge-or-create in the target exactly like a
 * promotion, then retire the source id with a `replaced` tombstone so no
 * later sync can resurrect it. Evidence and attribution travel with the
 * concept; stamps naming anyone but the moving author are stripped back to
 * pre-attribution, and the author-private Unsorted flag never survives a
 * move (a move IS the sorting).
 *
 * Callers own the policy: membership must be verified before moving into a
 * workspace, and only the author's own knowledge may leave one.
 */
export async function moveOntologyConceptBetweenOwners(input: {
  fromOwner: OntologyOwner;
  toOwner: OntologyOwner;
  conceptId: string;
  /** Verified id of the author whose knowledge is moving. */
  movedByUserId: string;
  /** Project scope for the moved copy; defaults to null (cross-project). */
  targetProjectId?: string | null;
  now?: number;
}): Promise<MovedConceptOutcome | null> {
  const { fromOwner, toOwner } = input;
  if (
    fromOwner.ownerType === toOwner.ownerType &&
    fromOwner.ownerId === toOwner.ownerId
  ) {
    throw new Error("Refusing to move a concept onto itself");
  }
  await ensureOntologyOwner(fromOwner);
  await ensureOntologyOwner(toOwner);
  const now = input.now ?? Date.now();

  return db.transaction(async (tx) => {
    const source = await loadOntology(tx, fromOwner);
    const sourceConcept = source.concepts.find(
      (concept) => concept.id === input.conceptId,
    );
    if (!sourceConcept) return null;

    const sourceBefore: OntologyConcept = {
      ...sourceConcept,
      links: [...sourceConcept.links],
      sources: sourceConcept.sources.map((evidence) => ({ ...evidence })),
    };

    // Shape the traveling copy: cross-store links are meaningless, project
    // scope belongs to the target, and per-store server-managed flags
    // (adminOnly) plus the Unsorted holding flag stay behind.
    const [travelling] = restrictEvidenceAttribution(
      [
        {
          ...sourceBefore,
          links: [],
          projectId: input.targetProjectId ?? null,
          sources: sourceBefore.sources.map((evidence) => ({ ...evidence })),
        },
      ],
      new Set([input.movedByUserId]),
    );
    if (!travelling) return null;
    delete travelling.unsorted;
    delete travelling.adminOnly;

    const target = await loadOntology(tx, toOwner);
    const targetTombstoneIds = new Set(
      target.tombstones.map((marker) => marker.id),
    );
    const normalized = normalizeLabel(travelling.label);
    const existing = target.concepts.find(
      (concept) => normalizeLabel(concept.label) === normalized,
    );

    let moved: OntologyConcept;
    let targetBefore: OntologyConcept | null = null;
    if (existing) {
      targetBefore = {
        ...existing,
        links: [...existing.links],
        sources: existing.sources.map((evidence) => ({ ...evidence })),
      };
      const evidenceByConversation = new Map(
        existing.sources.map((evidence) => [evidence.conversationId, evidence]),
      );
      for (const evidence of travelling.sources) {
        const prior = evidenceByConversation.get(evidence.conversationId);
        if (!prior || evidence.updatedAt > prior.updatedAt) {
          evidenceByConversation.set(evidence.conversationId, evidence);
        }
      }
      moved = {
        ...existing,
        strength: Math.min(
          1,
          Math.max(existing.strength, travelling.strength) + 0.04,
        ),
        mentionCount: Math.min(
          existing.mentionCount + Math.max(1, travelling.mentionCount),
          99_999,
        ),
        summary:
          travelling.lastUpdatedAt >= existing.lastUpdatedAt &&
          travelling.summary
            ? travelling.summary
            : existing.summary,
        lastUpdatedAt: now,
        sources: [...evidenceByConversation.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, ONTOLOGY_BOUNDS.evidencePerConcept),
      };
      // A confident arrival clears a personal target out of Unsorted.
      if (moved.unsorted === true) delete moved.unsorted;
      const after = target.concepts.map((concept) =>
        concept.id === existing.id ? moved : concept,
      );
      await persistOntologyDiff(tx, toOwner, target.concepts, after);
    } else {
      let conceptId = travelling.id;
      if (
        target.concepts.some((concept) => concept.id === conceptId) ||
        targetTombstoneIds.has(conceptId)
      ) {
        conceptId = generateConceptId();
      }
      const position = placeConceptPosition(
        positionForLabel(travelling.label, target.concepts.length),
        target.concepts.map((concept) => ({ x: concept.x, y: concept.y })),
      );
      moved = {
        ...travelling,
        id: conceptId,
        x: position.x,
        y: position.y,
        lastUpdatedAt: now,
      };
      await persistOntologyDiff(tx, toOwner, target.concepts, [
        ...target.concepts,
        moved,
      ]);
    }

    // Retire the source id permanently: `replaced` means "superseded, never
    // resurrect", so a stale device syncing the old record later loses to
    // this marker no matter what timestamps it carries.
    await persistOntologyDiff(
      tx,
      fromOwner,
      source.concepts,
      source.concepts.filter((concept) => concept.id !== input.conceptId),
    );
    await upsertTombstones(tx, fromOwner, [
      { id: input.conceptId, deletedAt: now, replaced: true },
    ]);

    return { moved, merged: existing !== undefined, sourceBefore, targetBefore };
  });
}

/**
 * Restore a set of concepts to earlier snapshots inside one transaction —
 * the undo half of automatic filing. `before === null` means the filing
 * created the concept, so undo removes it and leaves a `replaced` tombstone
 * (permanent: the id can never resurrect through a sync). A non-null
 * snapshot is restored byte-for-byte, evidence included.
 */
export async function restoreConceptStates(
  owner: OntologyOwner,
  entries: Array<{ id: string; before: OntologyConcept | null }>,
  now?: number,
  expected?: Array<{ id: string; lastUpdatedAt: number }>,
  withinTx?: OntologyDbTx,
): Promise<boolean> {
  if (entries.length === 0) return true;
  await ensureOntologyOwner(owner);
  const deletedAt = now ?? Date.now();

  const run = async (tx: OntologyDbTx) => {
    if (expected !== undefined) {
      // Atomic undo drift guard: lock the rows this restore will rewrite,
      // then compare fingerprints inside the same transaction. A concurrent
      // edit either committed first (mismatch → refuse, nothing written) or
      // queues behind the lock and lands after the restore as its own
      // write — either way it is never silently overwritten. Rows deleted
      // since the move stop appearing in the locked select and refuse the
      // same way, as do entries the caller has no fingerprint for.
      const locked = await tx
        .select({
          conceptId: venomOntologyConceptsTable.conceptId,
          lastUpdatedAt: venomOntologyConceptsTable.lastUpdatedAt,
        })
        .from(venomOntologyConceptsTable)
        .where(
          and(
            eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
            eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
            inArray(
              venomOntologyConceptsTable.conceptId,
              entries.map((entry) => entry.id),
            ),
          ),
        )
        .for("update");
      const live = new Map(
        locked.map((row) => [row.conceptId, row.lastUpdatedAt]),
      );
      const want = new Map(
        expected.map((item) => [item.id, item.lastUpdatedAt]),
      );
      for (const entry of entries) {
        const fingerprint = want.get(entry.id);
        if (fingerprint === undefined || live.get(entry.id) !== fingerprint) {
          return false;
        }
      }
    }
    const { concepts } = await loadOntology(tx, owner);
    const byId = new Map(concepts.map((concept) => [concept.id, concept]));
    const next = new Map(byId);
    const retired: OntologyTombstone[] = [];
    for (const entry of entries) {
      if (entry.before === null) {
        next.delete(entry.id);
        retired.push({ id: entry.id, deletedAt, replaced: true });
      } else {
        next.set(entry.id, entry.before);
      }
    }
    await persistOntologyDiff(tx, owner, concepts, [...next.values()]);
    await upsertTombstones(tx, owner, retired);
    return true;
  };
  return withinTx ? run(withinTx) : db.transaction(run);
}

/**
 * Re-create a concept from a snapshot under a FRESH id — the undo half of a
 * cross-store move, whose source id was retired with a permanent `replaced`
 * tombstone. The copy keeps the snapshot's content (including the Unsorted
 * flag when restoring into a personal store) but takes `lastUpdatedAt: now`
 * so it wins the next sync merge instead of losing to any device state
 * written since.
 */
export async function recreateConceptFromSnapshot(
  owner: OntologyOwner,
  snapshot: OntologyConcept,
  now?: number,
  withinTx?: OntologyDbTx,
): Promise<OntologyConcept> {
  await ensureOntologyOwner(owner);
  const at = now ?? Date.now();
  const run = async (tx: OntologyDbTx) => {
    const { concepts } = await loadOntology(tx, owner);
    const recreated: OntologyConcept = {
      ...snapshot,
      id: generateConceptId(),
      links: snapshot.links.filter((linkId) =>
        concepts.some((concept) => concept.id === linkId),
      ),
      sources: snapshot.sources.map((evidence) => ({ ...evidence })),
      lastUpdatedAt: at,
    };
    if (owner.ownerType !== VENOM_ONTOLOGY_OWNER_TYPE_USER) {
      delete recreated.unsorted;
    }
    await persistOntologyDiff(tx, owner, concepts, [...concepts, recreated]);
    return recreated;
  };
  return withinTx ? run(withinTx) : db.transaction(run);
}

export type OrgSourceConceptSeed = {
  /** Deterministic id derived from the source, so reconnects replace in place. */
  id: string;
  label: string;
  category: string;
  strength: number;
  summary: string;
  excerpt: string;
  citationIds: string[];
};

/**
 * File (or refresh) the concepts a company source feeds into the shared
 * Brain. Deterministic ids make in-place replacement safe; seeds that
 * disappeared since the last sync are retired with replaced tombstones so
 * they can never resurrect. An empty seed list retires the whole source.
 */
export async function replaceOrgSourceConcepts(input: {
  orgId: string;
  sourceId: string;
  sourceName: string;
  seeds: OrgSourceConceptSeed[];
  now?: number;
}): Promise<{ filed: OntologyConcept[] }> {
  const owner = orgOwner(input.orgId);
  await ensureOntologyOwner(owner);
  const now = input.now ?? Date.now();
  const prefix = `${input.sourceId}_`;
  const conversationId = `orgsource_${input.sourceId}`.slice(
    0,
    ONTOLOGY_BOUNDS.conversationId,
  );
  const conversationTitle =
    input.sourceName.slice(0, ONTOLOGY_BOUNDS.conversationTitle) ||
    "Company source";

  return db.transaction(async (tx) => {
    const { concepts } = await loadOntology(tx, owner);
    const fromSource = new Map(
      concepts
        .filter((concept) => concept.id.startsWith(prefix))
        .map((concept) => [concept.id, concept]),
    );

    const hubId = input.seeds[0]?.id.slice(0, ONTOLOGY_BOUNDS.conceptId);
    const seedConcepts: OntologyConcept[] = input.seeds.map((seed, index) => {
      const id = seed.id.slice(0, ONTOLOGY_BOUNDS.conceptId);
      const prior = fromSource.get(id);
      const position = prior
        ? { x: prior.x, y: prior.y }
        : positionForLabel(seed.label, index);
      return {
        id,
        projectId: null,
        label: seed.label.slice(0, ONTOLOGY_BOUNDS.label),
        category: seed.category.slice(0, ONTOLOGY_BOUNDS.category) || "source",
        strength: Math.min(1, Math.max(0, seed.strength)),
        x: position.x,
        y: position.y,
        links: hubId && id !== hubId ? [hubId] : [],
        summary: seed.summary.slice(0, ONTOLOGY_BOUNDS.summary),
        mentionCount: (prior?.mentionCount ?? 0) + 1,
        lastUpdatedAt: now,
        sources: [
          {
            conversationId,
            projectId: null,
            conversationTitle,
            messageIds: seed.citationIds
              .map((citation) => citation.slice(0, ONTOLOGY_BOUNDS.messageId))
              .slice(0, ONTOLOGY_BOUNDS.messageIdsPerEvidence),
            excerpt: seed.excerpt.slice(0, ONTOLOGY_BOUNDS.excerpt),
            updatedAt: now,
            // Source-derived evidence is the company source speaking, not a
            // member: readers attribute null to the source-backed owner.
            capturedByUserId: null,
            capturedAt: null,
          },
        ],
      };
    });

    const seedIds = new Set(seedConcepts.map((concept) => concept.id));
    const removed = [...fromSource.values()].filter(
      (concept) => !seedIds.has(concept.id),
    );
    const after = [
      ...concepts.filter((concept) => !concept.id.startsWith(prefix)),
      ...seedConcepts,
    ];
    await persistOntologyDiff(tx, owner, concepts, after);
    if (removed.length > 0) {
      await upsertTombstones(
        tx,
        owner,
        removed.map((concept) => ({
          id: concept.id,
          deletedAt: now,
          replaced: true,
        })),
      );
    }
    return { filed: seedConcepts };
  });
}

export type PromotedConcept = { concept: OntologyConcept; merged: boolean };

/** Erase every ontology row an owner holds. Used when a company is deleted. */
export async function purgeOntologyOwner(owner: OntologyOwner): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(venomOntologyEvidenceTable)
      .where(
        and(
          eq(venomOntologyEvidenceTable.ownerType, owner.ownerType),
          eq(venomOntologyEvidenceTable.ownerId, owner.ownerId),
        ),
      );
    await tx
      .delete(venomOntologyLinksTable)
      .where(
        and(
          eq(venomOntologyLinksTable.ownerType, owner.ownerType),
          eq(venomOntologyLinksTable.ownerId, owner.ownerId),
        ),
      );
    await tx
      .delete(venomOntologyConceptsTable)
      .where(
        and(
          eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
          eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
        ),
      );
    await tx
      .delete(venomOntologyTombstonesTable)
      .where(
        and(
          eq(venomOntologyTombstonesTable.ownerType, owner.ownerType),
          eq(venomOntologyTombstonesTable.ownerId, owner.ownerId),
        ),
      );
    await tx
      .delete(venomOntologyOwnersTable)
      .where(
        and(
          eq(venomOntologyOwnersTable.ownerType, owner.ownerType),
          eq(venomOntologyOwnersTable.ownerId, owner.ownerId),
        ),
      );
  });
}

/** Everything an owner's Brain holds, for rendering a shared layer. */
export async function loadOntologyForOwner(owner: OntologyOwner): Promise<{
  concepts: OntologyConcept[];
  tombstones: OntologyTombstone[];
}> {
  await ensureOntologyOwner(owner);
  return loadOntology(db, owner);
}

export class InvalidConceptPayload extends Error {}
