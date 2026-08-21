export type SopReferenceContent = {
  purpose: string;
  prerequisites: string[];
  inputs: string[];
  guidance: string[];
  requiredApprovals: string[];
  acceptanceChecks: string[];
};

export type SelectedSopRevisionRef = {
  revisionId: string;
  versionNumber: number;
  title: string;
};

const MAX_FIELD_CHARS = 1_200;
const MAX_LIST_ITEMS = 8;
export const MAX_SOP_REFERENCE_CHARS = 24_000;

function bounded(value: string, max = MAX_FIELD_CHARS): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}

export type SopReferenceRevision = {
  id: string;
  versionNumber: number;
  title: string;
  category: string;
  provenance: string;
  content: SopReferenceContent;
};

function boundedList(values: string[]): string[] {
  return values
    .slice(0, MAX_LIST_ITEMS)
    .map((value) => bounded(value, MAX_FIELD_CHARS));
}

function toReferenceRecord(revision: SopReferenceRevision) {
  return {
    revisionId: revision.id,
    revisionNumber: revision.versionNumber,
    title: bounded(revision.title, 320),
    category: revision.category,
    provenance: revision.provenance,
    content: {
      purpose: bounded(revision.content.purpose),
      prerequisites: boundedList(revision.content.prerequisites),
      inputs: boundedList(revision.content.inputs),
      orderedGuidance: boundedList(revision.content.guidance),
      requiredApprovals: boundedList(revision.content.requiredApprovals),
      acceptanceChecks: boundedList(revision.content.acceptanceChecks),
    },
  };
}

export function formatSopReference(revision: SopReferenceRevision): string {
  return JSON.stringify(toReferenceRecord(revision));
}

export function buildSopReferenceBundle(
  revisions: SopReferenceRevision[],
  maxChars = MAX_SOP_REFERENCE_CHARS,
): string {
  return buildSopReferenceBundleResult(revisions, maxChars).json;
}

export function buildSopReferenceBundleResult(
  revisions: SopReferenceRevision[],
  maxChars = MAX_SOP_REFERENCE_CHARS,
): { json: string; includedRevisionIds: string[] } {
  const envelope = {
    documentType: "venom_untrusted_sop_reference_bundle_v1",
    selectedRevisions: revisions.map((revision) => ({
      revisionId: revision.id,
      revisionNumber: revision.versionNumber,
      title: bounded(revision.title, 320),
    })),
    referenceExcerpts: [] as ReturnType<typeof toReferenceRecord>[],
  };

  for (const revision of revisions) {
    const record = toReferenceRecord(revision);
    const candidate = {
      ...envelope,
      referenceExcerpts: [...envelope.referenceExcerpts, record],
    };
    if (JSON.stringify(candidate).length > maxChars) break;
    envelope.referenceExcerpts.push(record);
  }

  return {
    json: JSON.stringify(envelope),
    includedRevisionIds: envelope.referenceExcerpts.map(
      (reference) => reference.revisionId,
    ),
  };
}

export function sopRevisionDisclosure(
  revisions: SelectedSopRevisionRef[],
): string {
  if (revisions.length === 0) return "";
  return `SOP revisions selected: ${revisions
    .map(
      (revision) =>
        `${revision.title} v${revision.versionNumber} (${revision.revisionId})`,
    )
    .join("; ")}\n\n`;
}