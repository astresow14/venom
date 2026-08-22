/**
 * Inline citation-marker resolution for the desktop workspace.
 *
 * The rules live in @workspace/knowledge-text — one rulebook shared with the
 * phone app, which re-exports the same bindings from
 * artifacts/venom/context/messageCitations.ts (and knowledgeState.ts for
 * knowledgeDisplayText) — so a wording or parsing change lands on both
 * platforms at once. citationRules.test.mjs asserts these exports ARE the
 * shared implementations, so a local copy cannot drift back in.
 */
export {
  ARCHIVED_CITATION_LABEL,
  citationUrlIdentity,
  citedCitationIds,
  knowledgeDisplayText,
  messageCitationPlainText,
  messageCitationSegments,
  type KnowledgeCitationLookup,
  type MessageCitationSegment,
} from "@workspace/knowledge-text";
