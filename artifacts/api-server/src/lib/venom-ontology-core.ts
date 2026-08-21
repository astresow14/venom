/**
 * Pure logic for the server-side Venom ontology store.
 *
 * These functions replicate the client knowledge model exactly (see
 * artifacts/venom/context/knowledgeState.ts and workspaceSync.ts, mirrored by
 * artifacts/venom-desktop/src/lib/workspaceState.ts):
 *
 * - concepts merge per id, newer `lastUpdatedAt` wins, incoming wins ties;
 * - a plain deletion tombstone only kills a concept when it is at least as
 *   new as the concept; a replacement tombstone is permanent;
 * - concepts live only inside live projects;
 * - links are bidirectional, same-project, and never dangle;
 * - filing decays same-project strengths, merges by normalized label, caps
 *   evidence at 8 per concept and 12 message ids per evidence entry.
 *
 * Kept free of database and route imports so the semantics can be unit
 * tested on their own.
 */

export type OntologyEvidence = {
  conversationId: string;
  projectId: string | null;
  conversationTitle: string;
  messageIds: string[];
  excerpt: string;
  updatedAt: number;
  /**
   * Clerk user id of the account that initiated the capture, or null for
   * evidence from before attribution existed (readers attribute those to
   * the ontology owner). Assigned server-side from the verified filing
   * identity; stamps arriving in client snapshots survive absorption only
   * when they name an allowed identity (restrictEvidenceAttribution).
   */
  capturedByUserId: string | null;
  /** When that capture was filed (ms since epoch); null pre-attribution. */
  capturedAt: number | null;
};

export type OntologyConcept = {
  id: string;
  projectId: string | null;
  label: string;
  category: string;
  strength: number;
  x: number;
  y: number;
  links: string[];
  summary: string;
  description?: string;
  mentionCount: number;
  lastUpdatedAt: number;
  sources: OntologyEvidence[];
};

export type OntologyTombstone = {
  id: string;
  deletedAt: number;
  replaced?: boolean;
};

export type InsightCandidate = {
  label: string;
  category: string;
  confidence: number;
  summary: string;
  sourceMessageIds: string[];
  relatedLabels: string[];
};

// Bounds mirror the OpenAPI workspace schema so stored records always
// round-trip through a valid workspace snapshot.
export const ONTOLOGY_BOUNDS = {
  conceptId: 120,
  projectId: 120,
  label: 200,
  category: 100,
  summary: 2000,
  description: 2000,
  links: 100,
  evidencePerConcept: 8,
  messageIdsPerEvidence: 12,
  messageId: 120,
  conversationId: 120,
  conversationTitle: 200,
  excerpt: 2000,
  capturedByUserId: 120,
} as const;

/** Injection cap: the workspace schema allows at most 1000 clusters. */
export const MAX_INJECTED_CLUSTERS = 1000;
/** Cluster tombstone cap mirrored from the client TOMBSTONE_LIMITS. */
export const MAX_INJECTED_CLUSTER_TOMBSTONES = 2000;

export const normalizeLabel = (label: string) =>
  label.trim().toLocaleLowerCase();

/** Exact port of the client positionForLabel hash placement. */
export function positionForLabel(
  label: string,
  index: number,
): { x: number; y: number } {
  const hash = [...label].reduce(
    (value, ch) => (value * 31 + ch.charCodeAt(0)) >>> 0,
    17,
  );
  const angle = (hash % 360) * (Math.PI / 180);
  const radius = 80 + ((hash >>> 8) % 4) * 42 + (index % 3) * 18;
  return {
    x: Math.round(Math.cos(angle) * radius),
    y: Math.round(Math.sin(angle) * radius),
  };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const sliced = value.slice(0, max);
  return sliced.length > 0 ? sliced : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

/**
 * Defensive shaping of an evidence entry. Returns null when the entry lacks
 * the identity fields required to anchor it to a conversation.
 */
export function sanitizeEvidence(raw: unknown): OntologyEvidence | null {
  if (!isRecord(raw)) return null;
  const conversationId = boundedString(
    raw.conversationId,
    ONTOLOGY_BOUNDS.conversationId,
  );
  if (!conversationId) return null;

  const projectId =
    raw.projectId === null
      ? null
      : boundedString(raw.projectId, ONTOLOGY_BOUNDS.projectId);
  if (projectId === undefined) return null;

  const messageIds = Array.isArray(raw.messageIds)
    ? [
        ...new Set(
          raw.messageIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        ),
      ]
        .map((id) => id.slice(0, ONTOLOGY_BOUNDS.messageId))
        .slice(0, ONTOLOGY_BOUNDS.messageIdsPerEvidence)
    : [];

  // A capture time only means something alongside the capturing identity;
  // a time without an identity collapses back to pre-attribution.
  const capturedByUserId = boundedString(
    raw.capturedByUserId,
    ONTOLOGY_BOUNDS.capturedByUserId,
  );
  const capturedAt =
    capturedByUserId !== null &&
    typeof raw.capturedAt === "number" &&
    Number.isFinite(raw.capturedAt) &&
    raw.capturedAt > 0
      ? Math.round(raw.capturedAt)
      : null;

  return {
    conversationId,
    projectId: projectId ?? null,
    conversationTitle:
      boundedString(raw.conversationTitle, ONTOLOGY_BOUNDS.conversationTitle) ??
      "Conversation",
    messageIds,
    excerpt:
      typeof raw.excerpt === "string"
        ? raw.excerpt.slice(0, ONTOLOGY_BOUNDS.excerpt)
        : "",
    updatedAt: Math.max(0, Math.round(finiteNumber(raw.updatedAt, 0))),
    capturedByUserId,
    capturedAt,
  };
}

/**
 * Defensive shaping of a concept record coming from a workspace snapshot
 * (either a live PUT or a legacy blob during migration).
 */
export function sanitizeConcept(raw: unknown): OntologyConcept | null {
  if (!isRecord(raw)) return null;
  const id = boundedString(raw.id, ONTOLOGY_BOUNDS.conceptId);
  const label = boundedString(raw.label, ONTOLOGY_BOUNDS.label);
  if (!id || !label) return null;

  const projectId =
    raw.projectId === null
      ? null
      : (boundedString(raw.projectId, ONTOLOGY_BOUNDS.projectId) ?? null);

  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map(sanitizeEvidence)
        .filter((entry): entry is OntologyEvidence => entry !== null)
        .slice(0, ONTOLOGY_BOUNDS.evidencePerConcept)
    : [];

  const links = Array.isArray(raw.links)
    ? [
        ...new Set(
          raw.links.filter(
            (link): link is string =>
              typeof link === "string" && link.length > 0,
          ),
        ),
      ]
        .map((link) => link.slice(0, ONTOLOGY_BOUNDS.conceptId))
        .slice(0, ONTOLOGY_BOUNDS.links)
    : [];

  const summary =
    boundedString(raw.summary, ONTOLOGY_BOUNDS.summary) ??
    boundedString(raw.description, ONTOLOGY_BOUNDS.summary) ??
    label;

  const concept: OntologyConcept = {
    id,
    projectId,
    label,
    category: boundedString(raw.category, ONTOLOGY_BOUNDS.category) ?? "topic",
    strength: Math.max(0, Math.min(1, finiteNumber(raw.strength, 0.5))),
    x: finiteNumber(raw.x, 0),
    y: finiteNumber(raw.y, 0),
    links,
    summary,
    mentionCount: Math.max(
      0,
      Math.round(finiteNumber(raw.mentionCount, Math.max(1, sources.length))),
    ),
    lastUpdatedAt: Math.max(0, Math.round(finiteNumber(raw.lastUpdatedAt, 0))),
    sources,
  };

  const description = boundedString(
    raw.description,
    ONTOLOGY_BOUNDS.description,
  );
  if (description) concept.description = description;
  return concept;
}

export function sanitizeTombstone(raw: unknown): OntologyTombstone | null {
  if (!isRecord(raw)) return null;
  const id = boundedString(raw.id, ONTOLOGY_BOUNDS.conceptId);
  if (!id) return null;
  const deletedAt = Math.round(finiteNumber(raw.deletedAt, Number.NaN));
  if (!Number.isFinite(deletedAt) || deletedAt < 0) return null;
  return {
    id,
    deletedAt,
    ...(raw.replaced === true ? { replaced: true } : {}),
  };
}

/**
 * Trust boundary for capture stamps arriving from outside the store (client
 * snapshots, legacy blob imports): a stamp survives only when it names an
 * identity the server itself could have written for this owner — today,
 * the owner. Anything else is stripped back to pre-attribution (which
 * renders as the ontology owner), never re-attributed, so one account's
 * knowledge can never end up stamped with another account's identity.
 */
export function restrictEvidenceAttribution(
  concepts: OntologyConcept[],
  allowedUserIds: ReadonlySet<string>,
): OntologyConcept[] {
  const allowed = (evidence: OntologyEvidence) =>
    evidence.capturedByUserId === null ||
    allowedUserIds.has(evidence.capturedByUserId);
  return concepts.map((concept) =>
    concept.sources.every(allowed)
      ? concept
      : {
          ...concept,
          sources: concept.sources.map((evidence) =>
            allowed(evidence)
              ? evidence
              : { ...evidence, capturedByUserId: null, capturedAt: null },
          ),
        },
  );
}

/** Newest deletion wins; the replaced flag is permanent once set. */
export function mergeTombstoneRecords(
  existing: OntologyTombstone | undefined,
  incoming: OntologyTombstone,
): OntologyTombstone {
  if (!existing) return incoming;
  const winner =
    incoming.deletedAt >= existing.deletedAt ? incoming : existing;
  const replaced = existing.replaced === true || incoming.replaced === true;
  return replaced ? { ...winner, replaced: true } : winner;
}

/**
 * Exact port of the client reconcileKnowledgeLinks: links become
 * bidirectional, stay within one project, and never point at a missing
 * concept.
 */
export function reconcileConceptLinks(
  concepts: OntologyConcept[],
): OntologyConcept[] {
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  const linkedIds = new Map(
    concepts.map((concept) => [concept.id, new Set<string>()]),
  );

  for (const concept of concepts) {
    for (const linkId of concept.links) {
      const linked = conceptById.get(linkId);
      if (
        !linked ||
        linked.id === concept.id ||
        linked.projectId !== concept.projectId
      ) {
        continue;
      }
      linkedIds.get(concept.id)?.add(linked.id);
      linkedIds.get(linked.id)?.add(concept.id);
    }
  }

  return concepts.map((concept) => ({
    ...concept,
    links: [...(linkedIds.get(concept.id) ?? [])].slice(
      0,
      ONTOLOGY_BOUNDS.links,
    ),
  }));
}

export type MergeConceptSetsInput = {
  stored: OntologyConcept[];
  incoming: OntologyConcept[];
  tombstones: Map<string, OntologyTombstone>;
  liveProjectIds: Set<string>;
};

/**
 * The cross-device cluster merge, verbatim from the clients: union per id,
 * newer lastUpdatedAt wins and the incoming side wins ties, tombstoned and
 * project-dead concepts drop out, links reconcile at the end.
 */
export function mergeConceptSets({
  stored,
  incoming,
  tombstones,
  liveProjectIds,
}: MergeConceptSetsInput): OntologyConcept[] {
  const byId = new Map(stored.map((concept) => [concept.id, concept]));
  for (const concept of incoming) {
    const existing = byId.get(concept.id);
    if (!existing || concept.lastUpdatedAt >= existing.lastUpdatedAt) {
      byId.set(concept.id, concept);
    }
  }

  const survivors = [...byId.values()].filter((concept) => {
    if (concept.projectId !== null && !liveProjectIds.has(concept.projectId)) {
      return false;
    }
    const marker = tombstones.get(concept.id);
    if (!marker) return true;
    if (marker.replaced === true) return false;
    return marker.deletedAt < concept.lastUpdatedAt;
  });

  return reconcileConceptLinks(survivors);
}

export type EvidenceHygieneInput = {
  concepts: OntologyConcept[];
  /** Concept ids present in the incoming snapshot (client-authoritative). */
  incomingConceptIds: Set<string>;
  /** conversationId -> newest deletedAt from the snapshot's tombstones. */
  conversationDeletionTimes: Map<string, number>;
};

export type EvidenceHygieneResult = {
  concepts: OntologyConcept[];
  /** Concepts removed entirely; each needs a tombstone at the given time. */
  droppedConcepts: { id: string; deletedAt: number }[];
};

/**
 * Server-filed concepts can cite conversations a device deleted before it
 * ever saw the concept. For concepts the incoming snapshot does not carry,
 * drop evidence whose conversation was deleted at or after the evidence was
 * written — exactly what the client's own filing guard would have prevented.
 * A concept whose every anchor died this way (and that received no update
 * since) is removed and tombstoned so another device cannot resurrect it.
 */
export function applyEvidenceHygiene({
  concepts,
  incomingConceptIds,
  conversationDeletionTimes,
}: EvidenceHygieneInput): EvidenceHygieneResult {
  if (conversationDeletionTimes.size === 0) {
    return { concepts, droppedConcepts: [] };
  }

  const kept: OntologyConcept[] = [];
  const droppedConcepts: { id: string; deletedAt: number }[] = [];

  for (const concept of concepts) {
    if (incomingConceptIds.has(concept.id) || concept.sources.length === 0) {
      kept.push(concept);
      continue;
    }

    const liveSources = concept.sources.filter((evidence) => {
      const deletedAt = conversationDeletionTimes.get(evidence.conversationId);
      return deletedAt === undefined || deletedAt < evidence.updatedAt;
    });

    if (liveSources.length === concept.sources.length) {
      kept.push(concept);
      continue;
    }

    if (liveSources.length > 0) {
      kept.push({ ...concept, sources: liveSources });
      continue;
    }

    const dropTime = Math.max(
      ...concept.sources.map(
        (evidence) =>
          conversationDeletionTimes.get(evidence.conversationId) ?? 0,
      ),
    );
    if (dropTime >= concept.lastUpdatedAt) {
      droppedConcepts.push({ id: concept.id, deletedAt: dropTime });
    } else {
      // The concept was touched after the deletions; keep it, unanchored,
      // the way a client keeps a cluster whose sources were pruned.
      kept.push({ ...concept, sources: [] });
    }
  }

  if (droppedConcepts.length === 0) {
    return { concepts: kept, droppedConcepts };
  }
  const droppedIds = new Set(droppedConcepts.map((entry) => entry.id));
  return {
    concepts: reconcileConceptLinks(kept).map((concept) => ({
      ...concept,
      links: concept.links.filter((link) => !droppedIds.has(link)),
    })),
    droppedConcepts,
  };
}

export type ApplyInsightsInput = {
  /** Concepts sharing the conversation's project scope, oldest first. */
  projectConcepts: OntologyConcept[];
  /** Total concept count for the owner, used for placement parity. */
  totalConceptCount: number;
  conversation: { id: string; title: string; projectId: string | null };
  candidates: InsightCandidate[];
  now: number;
  generateId: () => string;
  /**
   * Verified identity of the account that initiated this capture; stamped
   * onto every evidence entry the filing writes. Callers must pass the
   * identity captured at authentication time, never a value read after an
   * async boundary without re-verification.
   */
  capturedByUserId: string | null;
};

export type ApplyInsightsResult = {
  /** Every same-project concept after decay/filing, links reconciled. */
  concepts: OntologyConcept[];
  /** Ids of concepts created, strengthened, or re-linked by this filing. */
  touchedIds: Set<string>;
};

/**
 * Server-side filing: the exact client applyKnowledgeInsightsToState
 * algorithm, applied to the owner's stored concepts for one project scope.
 * The caller has already validated the candidates against the supplied
 * conversation messages (concepts without valid cited messages are dropped
 * upstream in normalizeExtractedClusters).
 */
export function applyInsightCandidates({
  projectConcepts,
  totalConceptCount,
  conversation,
  candidates,
  now,
  generateId,
  capturedByUserId,
}: ApplyInsightsInput): ApplyInsightsResult {
  const touchedIds = new Set<string>();
  if (candidates.length === 0) {
    return { concepts: projectConcepts, touchedIds };
  }

  const concepts = projectConcepts.map((concept) => ({
    ...concept,
    links: [...concept.links],
    sources: [...concept.sources],
    strength: Math.max(0.12, concept.strength * 0.96),
  }));

  const conceptByLabel = new Map(
    concepts.map((concept) => [normalizeLabel(concept.label), concept]),
  );

  let createdCount = 0;
  for (const candidate of candidates) {
    const label = candidate.label.trim();
    const normalizedLabel = normalizeLabel(label);
    if (!label || !normalizedLabel) continue;

    const confidence = Math.max(0, Math.min(1, candidate.confidence));
    const evidence: OntologyEvidence = {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      conversationTitle: conversation.title.slice(
        0,
        ONTOLOGY_BOUNDS.conversationTitle,
      ),
      messageIds: [...new Set(candidate.sourceMessageIds)].slice(
        0,
        ONTOLOGY_BOUNDS.messageIdsPerEvidence,
      ),
      excerpt: candidate.summary.trim().slice(0, ONTOLOGY_BOUNDS.excerpt),
      updatedAt: now,
      capturedByUserId,
      capturedAt: capturedByUserId === null ? null : now,
    };

    const existing = conceptByLabel.get(normalizedLabel);
    if (existing) {
      const priorEvidence = existing.sources.find(
        (entry) => entry.conversationId === conversation.id,
      );
      existing.category =
        candidate.category.trim().slice(0, ONTOLOGY_BOUNDS.category) ||
        existing.category;
      existing.summary =
        candidate.summary.trim().slice(0, ONTOLOGY_BOUNDS.summary) ||
        existing.summary;
      existing.mentionCount += 1;
      existing.lastUpdatedAt = now;
      existing.strength = Math.min(
        1,
        existing.strength + 0.12 + confidence * 0.2,
      );
      existing.sources = [
        {
          ...evidence,
          messageIds: [
            ...new Set([
              ...(priorEvidence?.messageIds ?? []),
              ...evidence.messageIds,
            ]),
          ].slice(0, ONTOLOGY_BOUNDS.messageIdsPerEvidence),
        },
        ...existing.sources.filter(
          (entry) => entry.conversationId !== conversation.id,
        ),
      ].slice(0, ONTOLOGY_BOUNDS.evidencePerConcept);
      touchedIds.add(existing.id);
    } else {
      const position = positionForLabel(
        label,
        totalConceptCount + createdCount,
      );
      const created: OntologyConcept = {
        id: generateId(),
        projectId: conversation.projectId,
        label,
        category:
          candidate.category.trim().slice(0, ONTOLOGY_BOUNDS.category) ||
          "topic",
        summary: candidate.summary.trim().slice(0, ONTOLOGY_BOUNDS.summary),
        strength: Math.min(1, 0.34 + confidence * 0.42),
        mentionCount: 1,
        lastUpdatedAt: now,
        sources: [evidence],
        x: position.x,
        y: position.y,
        links: [],
      };
      concepts.push(created);
      conceptByLabel.set(normalizedLabel, created);
      touchedIds.add(created.id);
      createdCount += 1;
    }
  }

  for (const candidate of candidates) {
    const source = conceptByLabel.get(normalizeLabel(candidate.label));
    if (!source) continue;
    for (const relatedLabel of candidate.relatedLabels) {
      const target = conceptByLabel.get(normalizeLabel(relatedLabel));
      if (!target || target.id === source.id) continue;
      if (!source.links.includes(target.id)) {
        source.links.push(target.id);
        touchedIds.add(source.id);
        touchedIds.add(target.id);
      }
      if (!target.links.includes(source.id)) {
        target.links.push(source.id);
        touchedIds.add(source.id);
        touchedIds.add(target.id);
      }
    }
  }

  return {
    concepts: concepts.map((concept) => ({
      ...concept,
      links: concept.links.slice(0, ONTOLOGY_BOUNDS.links),
    })),
    touchedIds,
  };
}

/** Injection order: newest knowledge first, stable across requests. */
export function sortConceptsForInjection(
  concepts: OntologyConcept[],
): OntologyConcept[] {
  return [...concepts].sort(
    (a, b) => b.lastUpdatedAt - a.lastUpdatedAt || a.id.localeCompare(b.id),
  );
}

/**
 * Mirror of the client boundDeletionMarkers: newest first, replacement
 * markers keep priority when the cap bites.
 */
export function boundTombstonesForInjection(
  tombstones: OntologyTombstone[],
  limit: number = MAX_INJECTED_CLUSTER_TOMBSTONES,
): OntologyTombstone[] {
  if (tombstones.length <= limit) return tombstones;
  const newestFirst = [...tombstones].sort((a, b) => b.deletedAt - a.deletedAt);
  const replaced = newestFirst.filter((marker) => marker.replaced === true);
  if (replaced.length >= limit) return replaced.slice(0, limit);
  const deleted = newestFirst.filter((marker) => marker.replaced !== true);
  const kept = new Set([
    ...replaced,
    ...deleted.slice(0, limit - replaced.length),
  ]);
  return newestFirst.filter((marker) => kept.has(marker));
}

// ---------------------------------------------------------------------------
// Workspace-state helpers (operate defensively on unknown snapshots)
// ---------------------------------------------------------------------------

export type WorkspaceKnowledgeView = {
  concepts: OntologyConcept[];
  conceptTombstones: OntologyTombstone[];
  conversationDeletionTimes: Map<string, number>;
  liveProjectIds: Set<string>;
};

/** Pull the knowledge-relevant slices out of a workspace snapshot. */
export function readWorkspaceKnowledge(state: unknown): WorkspaceKnowledgeView {
  const record = isRecord(state) ? state : {};
  const concepts = Array.isArray(record.clusters)
    ? record.clusters
        .map(sanitizeConcept)
        .filter((concept): concept is OntologyConcept => concept !== null)
    : [];

  const tombstones = isRecord(record.tombstones) ? record.tombstones : {};
  const conceptTombstones = Array.isArray(tombstones.clusters)
    ? tombstones.clusters
        .map(sanitizeTombstone)
        .filter((marker): marker is OntologyTombstone => marker !== null)
    : [];

  const conversationDeletionTimes = new Map<string, number>();
  if (Array.isArray(tombstones.conversations)) {
    for (const raw of tombstones.conversations) {
      const marker = sanitizeTombstone(raw);
      if (!marker) continue;
      const existing = conversationDeletionTimes.get(marker.id);
      if (existing === undefined || marker.deletedAt > existing) {
        conversationDeletionTimes.set(marker.id, marker.deletedAt);
      }
    }
  }

  const liveProjectIds = new Set<string>();
  if (Array.isArray(record.projects)) {
    for (const project of record.projects) {
      if (isRecord(project) && typeof project.id === "string") {
        liveProjectIds.add(project.id);
      }
    }
  }

  return {
    concepts,
    conceptTombstones,
    conversationDeletionTimes,
    liveProjectIds,
  };
}

/** The blob stores everything except knowledge; concepts live in the store. */
export function stripClustersFromState(state: unknown): unknown {
  if (!isRecord(state)) return state;
  return { ...state, clusters: [] };
}

/**
 * Rebuild the client-visible snapshot: stored concepts become
 * state.clusters (newest first, capped) and store tombstones merge into
 * state.tombstones.clusters so devices that missed a deletion still see it.
 */
export function injectKnowledgeIntoState(
  state: unknown,
  concepts: OntologyConcept[],
  conceptTombstones: OntologyTombstone[],
): unknown {
  if (!isRecord(state)) return state;

  const clusters = sortConceptsForInjection(concepts).slice(
    0,
    MAX_INJECTED_CLUSTERS,
  );

  const tombstones = isRecord(state.tombstones) ? state.tombstones : {};
  const markerById = new Map<string, OntologyTombstone>();
  if (Array.isArray(tombstones.clusters)) {
    for (const raw of tombstones.clusters) {
      const marker = sanitizeTombstone(raw);
      if (!marker) continue;
      markerById.set(
        marker.id,
        mergeTombstoneRecords(markerById.get(marker.id), marker),
      );
    }
  }
  for (const marker of conceptTombstones) {
    markerById.set(
      marker.id,
      mergeTombstoneRecords(markerById.get(marker.id), marker),
    );
  }

  return {
    ...state,
    clusters,
    tombstones: {
      ...tombstones,
      clusters: boundTombstonesForInjection([...markerById.values()]),
    },
  };
}
