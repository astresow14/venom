import {
  db,
  venomSopProjectSelectionsTable,
  venomSopRevisionsTable,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  buildSopReferenceBundle,
  MAX_SOP_REFERENCE_CHARS,
  type SelectedSopRevisionRef,
} from "./sop-reference.js";

const MAX_SELECTED_SOPS = 30;

export async function loadProjectSopContext(
  clerkUserId: string,
  projectId: string,
): Promise<{
  referenceBlock: string | null;
  revisions: SelectedSopRevisionRef[];
}> {
  const selections = await db
    .select({
      revisionId: venomSopProjectSelectionsTable.revisionId,
      selectedAt: venomSopProjectSelectionsTable.selectedAt,
    })
    .from(venomSopProjectSelectionsTable)
    .where(
      and(
        eq(venomSopProjectSelectionsTable.clerkUserId, clerkUserId),
        eq(venomSopProjectSelectionsTable.projectId, projectId),
      ),
    )
    .orderBy(asc(venomSopProjectSelectionsTable.selectedAt))
    .limit(MAX_SELECTED_SOPS);

  if (selections.length === 0) {
    return { referenceBlock: null, revisions: [] };
  }

  const revisionIds = selections.map((selection) => selection.revisionId);
  const revisions = await db
    .select()
    .from(venomSopRevisionsTable)
    .where(
      and(
        eq(venomSopRevisionsTable.clerkUserId, clerkUserId),
        inArray(venomSopRevisionsTable.id, revisionIds),
      ),
    );
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const ordered = revisionIds
    .map((revisionId) => byId.get(revisionId))
    .filter((revision): revision is NonNullable<typeof revision> =>
      Boolean(revision),
    );

  const refs = ordered.map((revision) => ({
    revisionId: revision.id,
    versionNumber: revision.versionNumber,
    title: revision.title,
  }));
  const referenceBlock = buildSopReferenceBundle(
    ordered,
    MAX_SOP_REFERENCE_CHARS,
  );

  return { referenceBlock, revisions: refs };
}