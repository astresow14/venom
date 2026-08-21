import type {
  VenomArchivedCitation,
  VenomConversation,
  SourceCitation,
} from "@workspace/api-client-react";

const CITATION_MARKER_PATTERN = /\[source:([A-Za-z0-9_-]{1,160})\]/g;
const CITATION_MARKER_SPLIT_PATTERN = /(\[source:[A-Za-z0-9_-]{1,160}\])/g;

export const ARCHIVED_CITATION_LABEL = "(archived source)";

/** Matches the maxLength of VenomArchivedCitation.title in the API schema. */
const ARCHIVED_TITLE_MAX_LENGTH = 300;
/** Matches the maxLength of VenomArchivedCitation.url in the API schema. */
const ARCHIVED_URL_MAX_LENGTH = 2048;

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
 * Identity of the cited item by its provider reference (issue/PR path, doc
 * path). This is the strongest signal a re-sync preserves, so it is matched
 * first. Namespaced by kind so an issue and a page never collide.
 */
function citationReferenceKey(citation: SourceCitation): string | null {
  const reference = citation.reference?.trim().toLowerCase();
  return reference ? `${citation.kind}\u0000ref\u0000${reference}` : null;
}

/**
 * Identity of the cited item by where it lives. Weaker than the reference: a
 * provider can renumber an issue or rename a doc path while still serving the
 * same page, and it can also put several items on one page.
 */
function citationUrlKey(citation: SourceCitation): string | null {
  const url = citation.url?.trim().toLowerCase();
  return url ? `${citation.kind}\u0000url\u0000${url}` : null;
}

/**
 * Identity of the cited item by what it is called. The weakest signal of the
 * three — titles are not unique — so it only ever stands in for the item when
 * exactly one refreshed citation of the same kind carries it. Whitespace is
 * collapsed so a re-sync that reflows a title still matches.
 */
function citationTitleKey(citation: SourceCitation): string | null {
  const title = citation.title
    ?.trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return title ? `${citation.kind}\u0000title\u0000${title}` : null;
}

/**
 * Lookups over the refreshed citations, keyed by the things that survive a
 * re-sync. A URL or title shared by several refreshed citations is recorded as
 * `null`: there is no way to tell which of them an older citation meant, so it
 * is not used as a fallback target.
 */
function indexRefreshedCitations(refreshedCitations: SourceCitation[]): {
  byReference: Map<string, string>;
  byUrl: Map<string, string | null>;
  byTitle: Map<string, string | null>;
} {
  const byReference = new Map<string, string>();
  const byUrl = new Map<string, string | null>();
  const byTitle = new Map<string, string | null>();

  const recordUnlessShared = (
    lookup: Map<string, string | null>,
    key: string,
    citationId: string,
  ) => {
    const existing = lookup.get(key);
    if (existing === undefined) {
      lookup.set(key, citationId);
    } else if (existing !== citationId) {
      lookup.set(key, null);
    }
  };

  for (const citation of refreshedCitations) {
    const referenceKey = citationReferenceKey(citation);
    if (referenceKey && !byReference.has(referenceKey)) {
      byReference.set(referenceKey, citation.id);
    }

    const urlKey = citationUrlKey(citation);
    if (urlKey) recordUnlessShared(byUrl, urlKey, citation.id);

    const titleKey = citationTitleKey(citation);
    if (titleKey) recordUnlessShared(byTitle, titleKey, citation.id);
  }

  return { byReference, byUrl, byTitle };
}

/**
 * Maps citation ids that a refresh retired onto the refreshed citation that
 * covers the same item, so answers written before the refresh keep pointing at
 * live evidence. Citations with no equivalent are left out; the renderer shows
 * those as archived references instead.
 *
 * Matching prefers the provider reference, then falls back to the URL, then to
 * the normalized title, so a refresh that renumbers an issue, renames a doc
 * path, or moves a page to a new address while keeping its name keeps older
 * answers linked. Both fallbacks stay conservative, so two different items
 * never collapse into one: each is skipped when several refreshed citations of
 * the same kind share the key, when the candidate citation is already the
 * match of another cited item, and when several distinct retired items would
 * land on it.
 */
export function retiredCitationRemap(
  previousCitations: SourceCitation[],
  refreshedCitations: SourceCitation[],
): Map<string, string> {
  const refreshedIds = new Set(
    refreshedCitations.map((citation) => citation.id),
  );
  const { byReference, byUrl, byTitle } =
    indexRefreshedCitations(refreshedCitations);

  const remap = new Map<string, string>();
  // Refreshed citations that some previous citation already identifies exactly:
  // either it survived under the same id, or it is that citation's reference
  // match. The URL fallback must not point a different item at one of these.
  const claimed = new Set<string>();
  const unmatched: SourceCitation[] = [];

  for (const citation of previousCitations) {
    if (refreshedIds.has(citation.id)) {
      claimed.add(citation.id);
      continue;
    }
    const referenceKey = citationReferenceKey(citation);
    const replacement = referenceKey
      ? byReference.get(referenceKey)
      : undefined;
    if (!replacement) {
      unmatched.push(citation);
      continue;
    }
    claimed.add(replacement);
    if (replacement !== citation.id) remap.set(citation.id, replacement);
  }

  // Retired citations competing for the same URL: several ids for one item
  // (no reference to tell them apart) may share a target, but distinct items
  // that lost their reference cannot, so the whole group is left archived.
  const contenders = new Map<string, SourceCitation[]>();
  for (const citation of unmatched) {
    const urlKey = citationUrlKey(citation);
    if (!urlKey) continue;
    const group = contenders.get(urlKey);
    if (group) group.push(citation);
    else contenders.set(urlKey, [citation]);
  }

  for (const [urlKey, group] of contenders) {
    const replacement = byUrl.get(urlKey);
    if (!replacement || claimed.has(replacement)) continue;
    const items = new Set(
      group.map((citation) => citationReferenceKey(citation) ?? ""),
    );
    if (items.size > 1) continue;
    claimed.add(replacement);
    for (const citation of group) {
      if (replacement !== citation.id) remap.set(citation.id, replacement);
    }
  }

  // Last resort, for an item the refresh moved to a new address (a doc renamed
  // into a new path, a site restructured) whose reference also changed or was
  // never set: the normalized title. It runs only for citations both prior
  // tiers missed, and only onto a title exactly one refreshed citation of the
  // same kind carries, so two items that merely share a name never collapse
  // into one. Distinctness within a group is judged by reference and URL
  // together: only duplicate ids for one identical item may share the target.
  const titleContenders = new Map<string, SourceCitation[]>();
  for (const citation of unmatched) {
    if (remap.has(citation.id)) continue;
    const titleKey = citationTitleKey(citation);
    if (!titleKey) continue;
    const group = titleContenders.get(titleKey);
    if (group) group.push(citation);
    else titleContenders.set(titleKey, [citation]);
  }

  for (const [titleKey, group] of titleContenders) {
    const replacement = byTitle.get(titleKey);
    if (!replacement || claimed.has(replacement)) continue;
    const items = new Set(
      group.map(
        (citation) =>
          `${citationReferenceKey(citation) ?? ""}\u0000${citationUrlKey(citation) ?? ""}`,
      ),
    );
    if (items.size > 1) continue;
    claimed.add(replacement);
    for (const citation of group) {
      if (replacement !== citation.id) remap.set(citation.id, replacement);
    }
  }

  return remap;
}

/**
 * Normalizes a citation url so an archived entry — which only keeps a title and
 * a url — can be matched against the live citations for the same item.
 */
export function citationUrlIdentity(url: string | undefined): string {
  return (url ?? "").trim().toLowerCase();
}
/**
 * Captures the retired citations a refresh could not remap, so answers written
 * before the refresh can still show what they were based on. Only the fields a
 * reader needs are kept (title + url), which keeps the archive small enough to
 * live inside the synced workspace payload.
 */
export function archivedCitationsFromRetired(
  previousCitations: SourceCitation[],
  refreshedCitations: SourceCitation[],
  remap: Map<string, string>,
  retiredAt: number,
): VenomArchivedCitation[] {
  const refreshedIds = new Set(
    refreshedCitations.map((citation) => citation.id),
  );
  return archiveCitations(
    previousCitations.filter(
      (citation) =>
        !refreshedIds.has(citation.id) && !remap.has(citation.id),
    ),
    retiredAt,
  );
}

/**
 * Captures the citations of a source the reader disconnected. Nothing replaces
 * a removed source, so every citation it carried is retired at once and kept
 * in the same bounded archive a refresh writes to; answers written before the
 * removal can then still name (and open) the evidence they were based on.
 */
export function archivedCitationsFromRemovedSource(
  removedCitations: SourceCitation[],
  retiredAt: number,
): VenomArchivedCitation[] {
  return archiveCitations(removedCitations, retiredAt);
}

/**
 * Shared shaping for both retirement paths: one entry per citation id, holding
 * only the fields a reader needs (title + url), trimmed to the schema limits
 * so the archive stays small enough to live inside the synced workspace.
 */
function archiveCitations(
  citations: SourceCitation[],
  retiredAt: number,
): VenomArchivedCitation[] {
  const archived: VenomArchivedCitation[] = [];
  const seen = new Set<string>();

  for (const citation of citations) {
    if (seen.has(citation.id)) continue;
    seen.add(citation.id);

    const title = citation.title.trim() || citation.url.trim();
    if (!title) continue;
    archived.push({
      id: citation.id,
      title: title.slice(0, ARCHIVED_TITLE_MAX_LENGTH),
      url: citation.url.slice(0, ARCHIVED_URL_MAX_LENGTH),
      retiredAt,
    });
  }

  return archived;
}

/**
 * Rewrites the inline markers of an already-saved answer so retired citation
 * ids resolve to their current equivalent. Only the machine markers change;
 * the surrounding answer text is untouched.
 */
export function remapMessageCitations(
  content: string,
  remap: Map<string, string>,
): string {
  if (remap.size === 0) return content;
  return content.replace(
    CITATION_MARKER_PATTERN,
    (marker, citationId: string) => {
      const replacement = remap.get(citationId);
      return replacement ? `[source:${replacement}]` : marker;
    },
  );
}

/**
 * Applies a refresh's citation remap to the saved answers of the project the
 * source belongs to. Conversation timestamps stay put so a refresh never
 * reshuffles the session list.
 */
export function remapConversationCitations(
  conversations: VenomConversation[],
  projectId: string | null,
  remap: Map<string, string>,
): VenomConversation[] {
  if (remap.size === 0) return conversations;

  let changed = false;
  const next = conversations.map((conversation) => {
    if (conversation.projectId !== projectId) return conversation;

    let conversationChanged = false;
    const messages = conversation.messages.map((message) => {
      if (message.role !== "assistant") return message;
      const content = remapMessageCitations(message.content, remap);
      if (content === message.content) return message;
      conversationChanged = true;
      return { ...message, content };
    });

    if (!conversationChanged) return conversation;
    changed = true;
    return { ...conversation, messages };
  });

  return changed ? next : conversations;
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
      label: archived ? archivedCitationLabel(archived) : ARCHIVED_CITATION_LABEL,
      archived,
    });
  }

  return segments;
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
 * Maps archived citation ids onto the refreshed citation covering the same url,
 * so an answer written before an item disappeared points back at live evidence
 * once a refresh restores it. Archived ids that are live again are left out:
 * the renderer already prefers the live citation for that id.
 */
export function restoredCitationRemap(
  archivedCitations: VenomArchivedCitation[] | undefined,
  refreshedCitations: SourceCitation[],
): Map<string, string> {
  const refreshedIds = new Set(
    refreshedCitations.map((citation) => citation.id),
  );
  const refreshedByUrl = new Map<string, string>();
  for (const citation of refreshedCitations) {
    const identity = citationUrlIdentity(citation.url);
    if (identity && !refreshedByUrl.has(identity)) {
      refreshedByUrl.set(identity, citation.id);
    }
  }

  const remap = new Map<string, string>();
  for (const entry of archivedCitations ?? []) {
    if (!entry?.id || refreshedIds.has(entry.id)) continue;
    const identity = citationUrlIdentity(entry.url);
    if (!identity) continue;
    const replacement = refreshedByUrl.get(identity);
    if (replacement && replacement !== entry.id) {
      remap.set(entry.id, replacement);
    }
  }
  return remap;
}
