import type {
  VenomConversation,
  SourceCitation,
} from "@workspace/api-client-react";

const CITATION_MARKER_PATTERN = /\[source:([A-Za-z0-9_-]{1,160})\]/g;
const CITATION_MARKER_SPLIT_PATTERN = /(\[source:[A-Za-z0-9_-]{1,160}\])/g;

export const ARCHIVED_CITATION_LABEL = "(archived source)";

export type MessageCitationSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; citation: SourceCitation }
  | { kind: "archived"; citationId: string; label: string };

/**
 * Identity of the cited item itself, independent of the generated citation id.
 * A refresh regenerates citation ids whenever the source id changes, so the
 * underlying reference (issue/PR path) or URL is what survives a re-sync.
 */
function citationIdentity(citation: SourceCitation): string {
  const reference = citation.reference?.trim().toLowerCase();
  const target = reference || citation.url.trim().toLowerCase();
  return `${citation.kind}\u0000${target}`;
}

/**
 * Maps citation ids that a refresh retired onto the refreshed citation that
 * covers the same item, so answers written before the refresh keep pointing at
 * live evidence. Citations with no equivalent are left out; the renderer shows
 * those as archived references instead.
 */
export function retiredCitationRemap(
  previousCitations: SourceCitation[],
  refreshedCitations: SourceCitation[],
): Map<string, string> {
  const refreshedIds = new Set(
    refreshedCitations.map((citation) => citation.id),
  );
  const refreshedByIdentity = new Map<string, string>();
  for (const citation of refreshedCitations) {
    const identity = citationIdentity(citation);
    if (!refreshedByIdentity.has(identity)) {
      refreshedByIdentity.set(identity, citation.id);
    }
  }

  const remap = new Map<string, string>();
  for (const citation of previousCitations) {
    if (refreshedIds.has(citation.id)) continue;
    const replacement = refreshedByIdentity.get(citationIdentity(citation));
    if (replacement && replacement !== citation.id) {
      remap.set(citation.id, replacement);
    }
  }
  return remap;
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
 * Splits an assistant answer into renderable segments. Markers whose citation
 * is still connected become links; markers retired by a refresh (or by a
 * disconnected source) read as an archived reference rather than leaking the
 * raw `[source:...]` marker into the answer.
 */
export function messageCitationSegments(
  content: string,
  citationsById: Map<string, SourceCitation>,
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
    segments.push({
      kind: "archived",
      citationId: match[1],
      label: ARCHIVED_CITATION_LABEL,
    });
  }

  return segments;
}
