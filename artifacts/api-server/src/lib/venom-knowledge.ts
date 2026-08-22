/**
 * Normalization for the knowledge extraction endpoint's model output. Kept
 * free of route, auth and provider imports so the shaping rules can be unit
 * tested on their own.
 */

/**
 * Inline citation markers (`[source:cite_abc]`) belong to answer text, where
 * the reader's client resolves them to the source they point at. A cluster
 * label is a short identity string that is matched, merged and renamed by
 * hand, so a marker that lands in one can only ever read as raw machine text.
 * An unterminated marker is dropped as well: a truncated answer can leave a
 * trailing `[source:` behind with no closing bracket.
 */
const CITATION_MARKER_PATTERN = /\[source:[^\]]*(?:\]|$)/g;

export function stripCitationMarkers(text: string): string {
  return text
    .replace(CITATION_MARKER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type NormalizedKnowledgeCluster = {
  label: string;
  category: string;
  confidence: number;
  summary: string;
  sourceMessageIds: string[];
  relatedLabels: string[];
  /**
   * Raw scope verdict from the extraction model when scope classification
   * was requested: "personal" or a workspace id. Validated and thresholded
   * by `resolveClusterScope` — never trusted as-is. Stripped from the HTTP
   * response before parsing (clients never see raw verdicts).
   */
  scope?: string;
  /** Raw model confidence for `scope`, clamped to [0, 1]. */
  scopeConfidence?: number;
};

const MAX_CLUSTERS = 8;
const MAX_LABEL_LENGTH = 64;
const MAX_CATEGORY_LENGTH = 32;
const MAX_SUMMARY_LENGTH = 240;
const MAX_SOURCE_MESSAGE_IDS = 12;
const MAX_RELATED_LABELS = 8;
const DEFAULT_CONFIDENCE = 0.68;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shapes the model's raw JSON into the clusters the client can file. Clusters
 * that cite no supplied message id are dropped: without a live message the
 * client has nothing to anchor the note to.
 */
export function normalizeExtractedClusters(
  responseData: unknown,
  messageById: Map<string, string>,
): NormalizedKnowledgeCluster[] {
  const rawClusters =
    isRecord(responseData) && Array.isArray(responseData.clusters)
      ? responseData.clusters
      : [];

  return rawClusters
    .slice(0, MAX_CLUSTERS)
    .map((candidate): NormalizedKnowledgeCluster | null => {
      if (!isRecord(candidate) || typeof candidate.label !== "string") {
        return null;
      }

      const label = stripCitationMarkers(candidate.label).slice(
        0,
        MAX_LABEL_LENGTH,
      );
      if (!label) return null;

      const sourceMessageIds = Array.isArray(candidate.sourceMessageIds)
        ? candidate.sourceMessageIds
            .filter(
              (id): id is string =>
                typeof id === "string" && messageById.has(id),
            )
            .slice(0, MAX_SOURCE_MESSAGE_IDS)
        : [];
      if (!sourceMessageIds.length) return null;

      const sourceExcerpt = messageById.get(sourceMessageIds[0]) ?? label;
      const confidence =
        typeof candidate.confidence === "number" &&
        Number.isFinite(candidate.confidence)
          ? Math.max(0, Math.min(1, candidate.confidence))
          : DEFAULT_CONFIDENCE;

      // Summaries keep any citation marker they carry: the client renders a
      // marker as the source it names (or as an archived reference once that
      // source is gone), which reads better than dropping the attribution.
      const summary =
        typeof candidate.summary === "string" && candidate.summary.trim()
          ? candidate.summary.trim().slice(0, MAX_SUMMARY_LENGTH)
          : sourceExcerpt.trim().slice(0, MAX_SUMMARY_LENGTH);
      if (!summary) return null;

      const scope =
        typeof candidate.scope === "string" && candidate.scope.trim()
          ? candidate.scope.trim().slice(0, 128)
          : null;
      const scopeConfidence =
        typeof candidate.scopeConfidence === "number" &&
        Number.isFinite(candidate.scopeConfidence)
          ? Math.max(0, Math.min(1, candidate.scopeConfidence))
          : null;

      return {
        label,
        category:
          typeof candidate.category === "string" && candidate.category.trim()
            ? candidate.category.trim().slice(0, MAX_CATEGORY_LENGTH)
            : "topic",
        confidence,
        summary,
        sourceMessageIds,
        relatedLabels: Array.isArray(candidate.relatedLabels)
          ? candidate.relatedLabels
              .filter(
                (relatedLabel): relatedLabel is string =>
                  typeof relatedLabel === "string",
              )
              .map((relatedLabel) =>
                stripCitationMarkers(relatedLabel).slice(0, MAX_LABEL_LENGTH),
              )
              .filter((relatedLabel) => relatedLabel.length > 0)
              .slice(0, MAX_RELATED_LABELS)
          : [],
        ...(scope !== null ? { scope } : {}),
        ...(scopeConfidence !== null ? { scopeConfidence } : {}),
      };
    })
    .filter((candidate): candidate is NormalizedKnowledgeCluster =>
      candidate !== null,
    );
}
