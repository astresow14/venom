/**
 * Inline citation-marker resolution for the desktop workspace.
 *
 * A port of the mobile client's marker splitter
 * (artifacts/venom/context/messageCitations.ts): assistant text stores
 * machine markers like `[source:abc123]`, and rendering resolves each one to
 * the live citation it references — or to an archived reference when the
 * source has since been retired — so a reader never sees the raw marker.
 */

import type {
  SourceCitation,
  VenomArchivedCitation,
  VenomConversation,
} from "@workspace/api-client-react";

const CITATION_MARKER_SPLIT_PATTERN = /(\[source:[A-Za-z0-9_-]{1,160}\])/g;

const CITATION_MARKER_PATTERN = /\[source:([A-Za-z0-9_-]{1,160})\]/g;
export const ARCHIVED_CITATION_LABEL = "(archived source)";

/**
 * Collects every citation id some saved answer still references. The
 * retired-citation archive keeps entries only for these markers, so the
 * workspace merge needs the same census the mobile client uses.
 */
export function citedCitationIds(
  conversations: VenomConversation[],
): Set<string> {
  const cited = new Set<string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      for (const match of message.content.matchAll(CITATION_MARKER_PATTERN)) {
        cited.add(match[1]);
      }
    }
  }
  return cited;
}
export type MessageCitationSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; citation: SourceCitation }
  | {
      kind: "archived";
      citationId: string;
      label: string;
      archived: VenomArchivedCitation | null;
    };

/** Renders the archived marker text for a retired citation we still know about. */
function archivedCitationLabel(archived: VenomArchivedCitation): string {
  return `${archived.title} (archived)`;
}

/**
 * Splits an assistant answer into renderable segments. Markers whose citation
 * is still connected become links; markers retired by a refresh (or by a
 * disconnected source) read as an archived reference rather than leaking the
 * raw `[source:...]` marker into the answer.
 */
export function messageCitationSegments(
  content: string,
  citationsById: Map<string, SourceCitation>,
  archivedById?: Map<string, VenomArchivedCitation>,
): MessageCitationSegment[] {
  const segments: MessageCitationSegment[] = [];

  const pushText = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") {
      last.text += text;
      return;
    }
    segments.push({ kind: "text", text });
  };

  for (const part of content.split(CITATION_MARKER_SPLIT_PATTERN)) {
    if (!part) continue;
    const match = part.match(/^\[source:([A-Za-z0-9_-]{1,160})\]$/);
    if (!match) {
      pushText(part);
      continue;
    }

    const citation = citationsById.get(match[1]);
    if (citation) {
      segments.push({ kind: "citation", citation });
      continue;
    }
    const archived = archivedById?.get(match[1]) ?? null;
    segments.push({
      kind: "archived",
      citationId: match[1],
      label: archived
        ? archivedCitationLabel(archived)
        : ARCHIVED_CITATION_LABEL,
      archived,
    });
  }

  return segments;
}

/**
 * Flattens an assistant answer to reader-facing plain text: live markers
 * become their source title, retired ones their archived label. Used anywhere
 * the UI shows stored answer text outside a chat bubble (previews, knowledge
 * summaries, excerpts).
 */
export function messageCitationPlainText(
  content: string,
  citationsById: Map<string, SourceCitation>,
  archivedById?: Map<string, VenomArchivedCitation>,
): string {
  const flattened = messageCitationSegments(
    content,
    citationsById,
    archivedById,
  )
    .map((segment) => {
      if (segment.kind === "text") return segment.text;
      if (segment.kind === "citation") return segment.citation.title;
      return segment.label;
    })
    .join("");

  // Safety net for anything the segment pattern cannot classify: an overlong
  // id, or a marker the model left unterminated (a truncated stream flushes
  // the trailing `[source:` as-is). A preview must never show a raw marker, so
  // an unterminated one is dropped through the end of the content.
  return flattened
    .replace(/\[source:[^\]]*(?:\]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Citation lookups for knowledge-derived text, mirroring the mobile client's
 * `KnowledgeCitationLookup` (artifacts/venom/context/knowledgeState.ts).
 */
export type KnowledgeCitationLookup = {
  citationsById: Map<string, SourceCitation>;
  archivedById?: Map<string, VenomArchivedCitation>;
};

const NO_LIVE_CITATIONS: Map<string, SourceCitation> = new Map();

/**
 * Renders a cluster summary or source excerpt as a reader sees it. Both are
 * summarized from conversation text, so they can carry the same inline
 * `[source:...]` markers an assistant answer stores — from the extraction
 * model echoing one, or from a saved answer used verbatim as the excerpt. A
 * marker never belongs on screen: a live one reads as its source title, and
 * one whose source was refreshed away or disconnected reads as the archived
 * reference the chat bubble shows.
 */
export function knowledgeDisplayText(
  text: string,
  lookup?: KnowledgeCitationLookup,
): string {
  if (!text) return "";
  return messageCitationPlainText(
    text,
    lookup?.citationsById ?? NO_LIVE_CITATIONS,
    lookup?.archivedById,
  );
}

/** Mirrors the mobile client's url identity used to match restored evidence. */
export function citationUrlIdentity(url: string | undefined): string {
  return (url ?? "").trim().toLowerCase();
}
