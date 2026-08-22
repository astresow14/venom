/**
 * Citation-marker display rules shared by the Venom clients.
 *
 * Assistant answers store citations as inline machine markers like
 * `[source:cite_abc]`, and every text derived from an answer (chat previews,
 * Brain cluster summaries, source excerpts, feed entries) inherits them. The
 * phone app (artifacts/venom) and the desktop workspace
 * (artifacts/venom-desktop) must resolve those markers into the *same*
 * reader-facing text: a live citation reads as its source title, a citation
 * retired by a refresh or disconnect reads as its archived reference, and a
 * marker nothing knows about falls back to one generic archived label.
 *
 * This package is the single home for that rulebook: the marker grammar, the
 * segment parser, the archived-reference wording, plain-text flattening, and
 * knowledge display text. Both apps re-export from here under their
 * historical module paths, and each app's suite asserts — by reference
 * identity — that its exports ARE these functions, so a hand-rolled copy on
 * one side fails the tests. Change wording or parsing here, and only here.
 *
 * What deliberately stays out: the refresh/disconnect bookkeeping only the
 * phone app runs (retired-citation remapping, archive shaping, both in
 * artifacts/venom/context/messageCitations.ts) and each app's render
 * components, which consume the segments this module produces.
 *
 * Imports from @workspace/api-client-react are type-only on purpose: this
 * module is loaded at runtime by `node --test --experimental-strip-types`
 * suites in both apps, which cannot load the client package's runtime deps.
 */
import type {
  SourceCitation,
  VenomArchivedCitation,
  VenomConversation,
} from "@workspace/api-client-react";

/**
 * The one grammar for an inline citation marker, with the cited id captured
 * as group 1. Returned as a fresh RegExp per call so one caller's `lastIndex`
 * state can never leak into another's; the `g` flag suits both `matchAll`
 * (which requires it) and whole-text `replace`.
 */
export function citationMarkerPattern(): RegExp {
  return /\[source:([A-Za-z0-9_-]{1,160})\]/g;
}

const CITATION_MARKER_PATTERN = citationMarkerPattern();
const CITATION_MARKER_SPLIT_PATTERN = /(\[source:[A-Za-z0-9_-]{1,160}\])/g;

/** What a marker reads as when neither a live nor an archived citation can name it. */
export const ARCHIVED_CITATION_LABEL = "(archived source)";

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
 * raw `[source:...]` marker into the answer. Retired markers we archived keep
 * their original title so the reader can still tell what was cited.
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
 * Flattens an assistant answer into the text a reader actually sees, so
 * previews (activity feed, summaries) never leak the raw `[source:...]`
 * markers stored in the message. Live citations read as their source title;
 * markers a refresh or disconnect retired read as the same archived label the
 * chat bubble shows. Whitespace is collapsed so the result fits a one-line
 * preview.
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
 * Collects every citation id a saved answer still points at. An archived entry
 * is only ever rendered through such a marker, so ids missing from this set are
 * evidence nothing can reference any more.
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

/**
 * Normalizes a citation url so an archived entry — which only keeps a title and
 * a url — can be matched against the live citations for the same item.
 */
export function citationUrlIdentity(url: string | undefined): string {
  return (url ?? "").trim().toLowerCase();
}

/**
 * The citations a Brain note's text can point at: the live ones of the note's
 * project, plus the archived record of any a refresh or disconnect retired.
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
