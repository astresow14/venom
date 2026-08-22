/**
 * Undo for project deletion — capture what a delete removes, then rebuild it
 * under fresh ids.
 *
 * Deleting a project is intentionally permanent in the sync model: tombstones
 * for every removed id propagate to all devices and the merge rules guarantee
 * nothing resurrects them. Undo therefore never argues with a tombstone.
 * Instead, the moment before a delete commits, the app captures a snapshot of
 * exactly what the delete is about to remove; undoing rebuilds that content as
 * *new* entities under freshly generated ids, the same way deleting the last
 * project seeds its fallback workspace under a fresh id. The tombstoned ids
 * stay dead everywhere, and the restored copy merges across devices as
 * ordinary new work.
 *
 * Both apps use this pair through their usual re-export seams
 * (artifacts/venom-desktop/src/lib/workspaceState.ts and
 * artifacts/venom/context/workspaceSync.ts), so the undo semantics cannot
 * drift between the phone and the desktop.
 *
 * Imports from @workspace/api-client-react are type-only on purpose (see
 * index.ts); @workspace/knowledge-text is itself a runtime-safe shared lib
 * already loaded by both apps' strip-types test suites.
 */
import type {
  ProjectSource,
  VenomArchivedCitation,
  VenomConversation,
  VenomKnowledgeCluster,
  VenomKnowledgeSource,
  VenomProject,
  VenomWorkspaceState,
} from '@workspace/api-client-react';
import { citedCitationIds } from '@workspace/knowledge-text';
import { separateStackedClusters } from './clusterPlacement.ts';
import { createDeletionMarkers, mergeTombstones } from './index.ts';

/**
 * How long the apps keep a just-deleted project recoverable. Long enough to
 * read "deleted" and reach the undo control, short enough that the pending
 * snapshot never outlives the moment; after this the snapshot is dropped and
 * the deletion is as final as it always was.
 */
export const PROJECT_RESTORE_WINDOW_MS = 15_000;

/**
 * Everything a project deletion removes, captured verbatim at the moment of
 * the delete. Content only — the tombstones the delete writes are not part of
 * the snapshot, because a restore must leave them exactly as committed.
 */
export type ProjectRestoreSnapshot = {
  project: VenomProject;
  conversations: VenomConversation[];
  clusters: VenomKnowledgeCluster[];
  sources: ProjectSource[];
  /**
   * Archive entries the delete prunes because no surviving conversation cites
   * them any more (see dropUncitedArchivedCitations in both apps). Restoring
   * the conversations restores their evidence too.
   */
  archivedCitations: VenomArchivedCitation[];
  deletedAt: number;
  /**
   * True when the deleted project was the only one, meaning the delete seeded
   * a fresh fallback workspace in its place. The restore uses this to know the
   * fallback may need cleaning up.
   */
  wasLastProject: boolean;
};

/**
 * The slice of workspace state the capture/restore pair reads and rewrites.
 * Generic so each app keeps its own wider state type (extra synced fields ride
 * along untouched through the spread).
 */
type RestorableWorkspaceState = Pick<
  VenomWorkspaceState,
  | 'projects'
  | 'conversations'
  | 'clusters'
  | 'sources'
  | 'activeProjectId'
  | 'activeConversationId'
  | 'tombstones'
  | 'archivedCitations'
>;

/**
 * Captures what deleting `projectId` removes, so the delete can be undone
 * within the restore window. Call with the state the delete is about to
 * rewrite (the same snapshot `deleteProjectFromState` receives), and the same
 * `deletedAt` the delete stamps into its tombstones. Returns null when the
 * project does not exist.
 *
 * The capture mirrors the delete exactly: the project itself, its
 * conversations, its clusters, its connected sources, and the archived
 * citations that lose their last citing conversation with this project.
 * Entities are captured by reference — workspace state is immutable
 * everywhere, so structural sharing is safe.
 */
export function captureProjectRestoreSnapshot<
  S extends RestorableWorkspaceState,
>(state: S, projectId: string, deletedAt: number): ProjectRestoreSnapshot | null {
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) return null;

  const conversations = state.conversations.filter(
    (conversation) => conversation.projectId === projectId,
  );
  const clusters = state.clusters.filter(
    (cluster) => cluster.projectId === projectId,
  );
  const sources = (state.sources ?? []).filter(
    (source) => source.projectId === projectId,
  );

  // The delete keeps only archive entries some *remaining* conversation still
  // cites; everything else is pruned with the project. Capture that pruned
  // remainder so restored chats find their archived evidence again.
  const remaining = state.conversations.filter(
    (conversation) => conversation.projectId !== projectId,
  );
  const stillCited = citedCitationIds(remaining);
  const archivedCitations = (state.archivedCitations ?? []).filter(
    (entry) => !stillCited.has(entry.id),
  );

  return {
    project,
    conversations,
    clusters,
    sources,
    archivedCitations,
    deletedAt,
    wasLastProject: state.projects.length === 1,
  };
}

export type RestoreProjectOptions<S extends RestorableWorkspaceState> = {
  /** The state to restore into — usually the one the delete produced. */
  state: S;
  snapshot: ProjectRestoreSnapshot;
  /** Timestamp stamped on the restored project (its updatedAt). */
  restoredAt: number;
  /** The app's id factory; called with the same prefixes the apps use. */
  generateId: (prefix: string) => string;
  /**
   * Id of the fallback workspace the delete seeded when it removed the last
   * project. If that fallback is still untouched, the restore removes it again
   * (with proper tombstones) so undoing a last-project delete does not leave a
   * stray empty workspace behind.
   */
  fallbackProjectId?: string | null;
};

const remapped = (map: Map<string, string>, id: string): string =>
  map.get(id) ?? id;

/**
 * The delete-seeded fallback workspace is removed on restore only while it is
 * provably untouched: no board work, no chats, no knowledge, no sources, and
 * no edit since it was seeded. The moment anything used it, it is the user's
 * workspace and it stays.
 */
function fallbackWorkspaceUntouched(
  state: RestorableWorkspaceState,
  fallback: VenomProject,
  deletedAt: number,
): boolean {
  return (
    fallback.updatedAt === deletedAt &&
    fallback.tasks.length === 0 &&
    fallback.fieldDefinitions.length === 0 &&
    state.conversations.every(
      (conversation) => conversation.projectId !== fallback.id,
    ) &&
    state.clusters.every((cluster) => cluster.projectId !== fallback.id) &&
    (state.sources ?? []).every((source) => source.projectId !== fallback.id)
  );
}

/**
 * Rebuilds a deleted project from its snapshot under entirely fresh ids and
 * makes it the active project again.
 *
 * Sync-safety rules, in order of importance:
 * - The delete's tombstones are never touched. Every restored entity gets a
 *   fresh id, so on merge the old ids stay dead on every device while the
 *   restored copies arrive as ordinary new entities.
 * - Cross-references are remapped onto the fresh ids: tasks to their stages
 *   and field values, conversations to the project, cluster links to sibling
 *   clusters, and embedded knowledge evidence to its conversation/messages.
 * - Citation ids, message content (inline `[source:...]` markers included),
 *   attachment stamps, and captured-by attribution are kept verbatim: none of
 *   those id spaces are tombstoned by a project delete, and rewriting message
 *   text or attachment ids would break evidence resolution and downloads.
 * - Connected sources keep their snapshot, citations, and attestation
 *   verbatim. The attestation is bound server-side to the old project/source
 *   ids, so it will fail verification until the source's next refresh re-keys
 *   it — chat degrades gracefully (those citations pause) rather than
 *   breaking. Schedule cadence survives, but attempt/claim bookkeeping is
 *   dropped so the scheduled-sync worker re-syncs the source promptly and
 *   re-attests it under the new ids.
 * - Restored archive entries are unioned back (existing entries win on id).
 */
export function restoreProjectFromSnapshot<S extends RestorableWorkspaceState>(
  options: RestoreProjectOptions<S>,
): { state: S; projectId: string } {
  const { state, snapshot, restoredAt, generateId, fallbackProjectId } =
    options;

  // -- Fresh identities for everything the delete tombstoned -----------------
  const projectId = generateId('proj');
  const stageIds = new Map(
    snapshot.project.boardStages.map((stage) => [
      stage.id,
      generateId('stage'),
    ]),
  );
  const fieldIds = new Map(
    snapshot.project.fieldDefinitions.map((field) => [
      field.id,
      generateId('field'),
    ]),
  );
  const conversationIds = new Map(
    snapshot.conversations.map((conversation) => [
      conversation.id,
      generateId('conv'),
    ]),
  );
  const messageIds = new Map(
    snapshot.conversations.flatMap((conversation) =>
      conversation.messages.map(
        (message) => [message.id, generateId('msg')] as const,
      ),
    ),
  );
  const clusterIds = new Map(
    snapshot.clusters.map((cluster) => [cluster.id, generateId('cluster')]),
  );

  const fallbackStages = snapshot.project.boardStages[0]
    ? [...stageIds.values()][0]
    : undefined;

  const project: VenomProject = {
    ...snapshot.project,
    id: projectId,
    updatedAt: restoredAt,
    boardStages: snapshot.project.boardStages.map((stage) => ({
      ...stage,
      id: remapped(stageIds, stage.id),
    })),
    fieldDefinitions: snapshot.project.fieldDefinitions.map((field) => ({
      ...field,
      id: remapped(fieldIds, field.id),
    })),
    tasks: snapshot.project.tasks.map((task) => ({
      ...task,
      id: generateId('task'),
      // A task whose stage id is unknown (pre-existing data damage) lands on
      // the first restored stage rather than pointing at a tombstoned id.
      stageId: stageIds.get(task.stageId) ?? fallbackStages ?? task.stageId,
      // Values are keyed by field-definition id; keys no definition explains
      // referenced already-deleted fields and stay dead.
      values: Object.fromEntries(
        Object.entries(task.values ?? {}).flatMap(([fieldId, value]) => {
          const nextFieldId = fieldIds.get(fieldId);
          return nextFieldId ? [[nextFieldId, value] as const] : [];
        }),
      ),
    })),
  };
  // Company sharing does not survive the round trip: the share bound the old
  // project id, and filing/mirroring under a stale org linkage would lie.
  delete project.orgId;
  delete project.orgMirror;

  const conversations = snapshot.conversations.map((conversation) => ({
    ...conversation,
    id: remapped(conversationIds, conversation.id),
    projectId,
    messages: conversation.messages.map((message) => ({
      ...message,
      id: remapped(messageIds, message.id),
    })),
  }));

  const remapKnowledgeSource = (
    source: VenomKnowledgeSource,
  ): VenomKnowledgeSource => ({
    ...source,
    projectId:
      source.projectId === snapshot.project.id ? projectId : source.projectId,
    conversationId: remapped(conversationIds, source.conversationId),
    messageIds: source.messageIds.map((id) => remapped(messageIds, id)),
  });

  const clusters = snapshot.clusters.map((cluster) => ({
    ...cluster,
    id: remapped(clusterIds, cluster.id),
    projectId,
    links: cluster.links.map((link) => remapped(clusterIds, link)),
    sources: cluster.sources.map(remapKnowledgeSource),
  }));

  const sources = snapshot.sources.map((source) => {
    const restored: ProjectSource = {
      ...source,
      id: generateId('source'),
      projectId,
    };
    if (source.schedule) {
      // Cadence is the user's choice and survives; attempt and claim
      // bookkeeping belonged to the dead id. A clean slate makes the source
      // due promptly, so the next scheduled sync re-keys and re-attests it.
      restored.schedule = {
        cadence: source.schedule.cadence,
        updatedAt: source.schedule.updatedAt,
      };
    }
    return restored;
  });

  // -- Fallback-workspace cleanup --------------------------------------------
  // Undoing a last-project delete removes the fallback the delete seeded, but
  // only while it is untouched — and its removal writes tombstones of its own,
  // because the fallback already exists on any device that synced the delete.
  let projects = state.projects;
  let tombstones = state.tombstones;
  if (snapshot.wasLastProject && fallbackProjectId) {
    const fallback = state.projects.find(
      (entry) => entry.id === fallbackProjectId,
    );
    if (fallback && fallbackWorkspaceUntouched(state, fallback, snapshot.deletedAt)) {
      projects = state.projects.filter((entry) => entry.id !== fallback.id);
      tombstones = mergeTombstones(tombstones, {
        projects: createDeletionMarkers([fallback.id], restoredAt),
        stages: createDeletionMarkers(
          fallback.boardStages.map((stage) => stage.id),
          restoredAt,
        ),
        fields: createDeletionMarkers(
          fallback.fieldDefinitions.map((field) => field.id),
          restoredAt,
        ),
      });
    }
  }

  // -- Archived evidence ------------------------------------------------------
  // Entries the delete pruned come back so restored chats resolve their
  // citations; anything archived meanwhile wins on id collision.
  const currentArchive = state.archivedCitations ?? [];
  const knownArchiveIds = new Set(currentArchive.map((entry) => entry.id));
  const archivedCitations = [
    ...currentArchive,
    ...snapshot.archivedCitations.filter(
      (entry) => !knownArchiveIds.has(entry.id),
    ),
  ];

  const latestConversation = conversations.reduce<
    (typeof conversations)[number] | null
  >(
    (latest, conversation) =>
      !latest || conversation.updatedAt > latest.updatedAt
        ? conversation
        : latest,
    null,
  );

  return {
    state: {
      ...state,
      projects: [...projects, project],
      conversations: [...state.conversations, ...conversations],
      // The stacked-position repair runs on every path that adds clusters, so
      // a restore cannot reintroduce overlapping map nodes.
      clusters: separateStackedClusters([...state.clusters, ...clusters]),
      sources: [...(state.sources ?? []), ...sources],
      archivedCitations,
      activeProjectId: projectId,
      activeConversationId: latestConversation
        ? latestConversation.id
        : state.activeConversationId,
      tombstones,
    },
    projectId,
  };
}
