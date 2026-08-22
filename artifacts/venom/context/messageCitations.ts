/**
 * Citation bookkeeping for the phone app.
 *
 * The display half — the marker grammar, the `[source:...]` segment parser,
 * archived-reference wording, and plain-text flattening — lives in
 * @workspace/knowledge-text and is re-exported here under its historical
 * names. The desktop workspace
 * (artifacts/venom-desktop/src/lib/messageCitations.ts) re-exports the same
 * bindings, so both apps resolve cited sources identically by construction;
 * citationRules.test.mjs asserts the identity so a local copy cannot drift
 * back in.
 *
 * What stays local is the refresh/disconnect machinery only this app runs:
 * remapping retired citation ids onto their refreshed equivalents and shaping
 * the bounded archive of citations nothing replaced.
 */
import type {
  VenomArchivedCitation,
  VenomConversation,
  SourceCitation,
} from "@workspace/api-client-react";
import {
  citationMarkerPattern,
  citationUrlIdentity,
} from "@workspace/knowledge-text";

export {
  ARCHIVED_CITATION_LABEL,
  citationUrlIdentity,
  citedCitationIds,
  messageCitationPlainText,
  messageCitationSegments,
  type MessageCitationSegment,
} from "@workspace/knowledge-text";

const CITATION_MARKER_PATTERN = citationMarkerPattern();
/** Matches the maxLength of VenomArchivedCitation.title in the API schema. */
const ARCHIVED_TITLE_MAX_LENGTH = 300;
/** Matches the maxLength of VenomArchivedCitation.url in the API schema. */
const ARCHIVED_URL_MAX_LENGTH = 2048;
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
 * Normalizes a citation title the way the archive stores one (trimmed, cut to
 * the schema limit) plus the case/whitespace folding the retired-citation
 * title tier uses, so an archived entry still matches the live citation for
 * the same item when the archived copy was truncated or the title reflowed.
 */
function archivedTitleIdentity(title: string | undefined): string {
  return (title ?? "")
    .trim()
    .slice(0, ARCHIVED_TITLE_MAX_LENGTH)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
 * Maps archived citation ids onto the refreshed citation covering the same
 * item, so an answer written before an item disappeared points back at live
 * evidence once a refresh restores it. Archived ids that are live again are
 * left out: the renderer already prefers the live citation for that id.
 *
 * Matching prefers the url, then falls back to the normalized title, so a
 * page that vanished and later returned under a new address while keeping its
 * name still reconnects. The archive keeps no kind or reference, so the title
 * tier is stricter than the retired-citation one: it only ever matches a
 * title exactly one refreshed citation of any kind carries, skips candidates
 * that already cover another archived entry (by url, or by being live under
 * an archived id), and never collapses distinct archived items that merely
 * share a name — only duplicate entries for one identical item (same url) may
 * share the target.
 */
export function restoredCitationRemap(
  archivedCitations: VenomArchivedCitation[] | undefined,
  refreshedCitations: SourceCitation[],
): Map<string, string> {
  const refreshedIds = new Set(
    refreshedCitations.map((citation) => citation.id),
  );
  const refreshedByUrl = new Map<string, string>();
  // A title several refreshed citations carry is recorded as `null`: there is
  // no way to tell which of them an archived entry meant, so it is never a
  // fallback target. Without a kind in the archive, sharing across kinds is
  // just as ambiguous, so uniqueness is judged across all refreshed citations.
  const refreshedByTitle = new Map<string, string | null>();
  for (const citation of refreshedCitations) {
    const urlIdentity = citationUrlIdentity(citation.url);
    if (urlIdentity && !refreshedByUrl.has(urlIdentity)) {
      refreshedByUrl.set(urlIdentity, citation.id);
    }
    const titleIdentity = archivedTitleIdentity(citation.title);
    if (titleIdentity) {
      const existing = refreshedByTitle.get(titleIdentity);
      if (existing === undefined) {
        refreshedByTitle.set(titleIdentity, citation.id);
      } else if (existing !== citation.id) {
        refreshedByTitle.set(titleIdentity, null);
      }
    }
  }

  const remap = new Map<string, string>();
  // Refreshed citations that already cover some archived entry exactly: they
  // are live under the entry's own id, or they are its url match. The title
  // fallback must not point a different entry at one of these.
  const claimed = new Set<string>();
  const unmatched: VenomArchivedCitation[] = [];

  for (const entry of archivedCitations ?? []) {
    if (!entry?.id) continue;
    if (refreshedIds.has(entry.id)) {
      claimed.add(entry.id);
      continue;
    }
    const identity = citationUrlIdentity(entry.url);
    const replacement = identity ? refreshedByUrl.get(identity) : undefined;
    if (!replacement) {
      unmatched.push(entry);
      continue;
    }
    claimed.add(replacement);
    if (replacement !== entry.id) remap.set(entry.id, replacement);
  }

  // Archived entries competing for the same title: several archived ids for
  // one item (retired twice from the same address) may share a target, but
  // distinct items that merely share a name cannot, so such a group is left
  // archived. Distinctness is judged by the only other field the archive
  // keeps, the url.
  const titleContenders = new Map<string, VenomArchivedCitation[]>();
  for (const entry of unmatched) {
    const titleKey = archivedTitleIdentity(entry.title);
    if (!titleKey) continue;
    const group = titleContenders.get(titleKey);
    if (group) group.push(entry);
    else titleContenders.set(titleKey, [entry]);
  }

  for (const [titleKey, group] of titleContenders) {
    const replacement = refreshedByTitle.get(titleKey);
    if (!replacement || claimed.has(replacement)) continue;
    const items = new Set(
      group.map((entry) => citationUrlIdentity(entry.url)),
    );
    if (items.size > 1) continue;
    claimed.add(replacement);
    for (const entry of group) {
      if (replacement !== entry.id) remap.set(entry.id, replacement);
    }
  }

  return remap;
}
