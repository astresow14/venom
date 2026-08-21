/**
 * Drizzle-backed persistence for the Venom ontology store.
 *
 * The store is the durable system of record for each owner's knowledge
 * graph. Rows are keyed by an owner scope (individual users today,
 * organizations later) and round-trip losslessly through the client's
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
  VENOM_ONTOLOGY_OWNER_TYPE_USER,
  VENOM_ONTOLOGY_OWNER_TYPE_WORKSPACE,
  type VenomOntologyConceptRow,
  type VenomOntologyEvidenceRow,
  type VenomOntologyLinkRow,
  type VenomOntologyTombstoneRow,
} from "@workspace/db";
import {
  applyEvidenceHygiene,
  applyInsightCandidates,
  injectKnowledgeIntoState,
  mergeConceptSets,
  mergeTombstoneRecords,
  normalizeLabel,
  ONTOLOGY_BOUNDS,
  readWorkspaceKnowledge,
  restrictEvidenceAttribution,
  stripClustersFromState,
  type InsightCandidate,
  type OntologyConcept,
  type OntologyEvidence,
  type OntologyTombstone,
} from "./venom-ontology-core";

export type OntologyOwner = {
  ownerType: string;
  ownerId: string;
};

export const userOwner = (userId: string): OntologyOwner => ({
  ownerType: VENOM_ONTOLOGY_OWNER_TYPE_USER,
  ownerId: userId,
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
  now?: number;
}): Promise<FiledKnowledge> {
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

  return db.transaction(async (tx) => {
    // Filing touches one project scope; other projects are never affected.
    const { concepts: allConcepts } = await loadOntology(tx, owner);
    const projectConcepts = allConcepts
      .filter((concept) => concept.projectId === input.conversation.projectId)
      .sort(
        (a, b) => a.lastUpdatedAt - b.lastUpdatedAt || a.id.localeCompare(b.id),
      );

    const { concepts: nextProjectConcepts, touchedIds } =
      applyInsightCandidates({
        projectConcepts,
        totalConceptCount: allConcepts.length,
        conversation: input.conversation,
        candidates: input.candidates,
        now,
        generateId: generateConceptId,
        capturedByUserId: input.capturedByUserId,
      });

    const otherConcepts = allConcepts.filter(
      (concept) => concept.projectId !== input.conversation.projectId,
    );
    await persistOntologyDiff(tx, owner, allConcepts, [
      ...otherConcepts,
      ...nextProjectConcepts,
    ]);

    return {
      filed: nextProjectConcepts.filter((concept) =>
        touchedIds.has(concept.id),
      ),
    };
  });
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
  const owner = userOwner(userId);
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
  const owner = userOwner(userId);
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
