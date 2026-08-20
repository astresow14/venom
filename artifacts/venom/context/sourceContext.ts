export type SourceContextInput = {
  id: string;
  syncedAt: string;
  context: string;
  attestation?: string;
  citations: Array<{
    id: string;
    provider: string;
    kind: string;
    title: string;
    url: string;
    excerpt: string;
    reference: string | null;
  }>;
};

export const CHAT_PROJECT_CONTEXT_MAX_CHARS = 8_000;
const SOURCE_CITATION_PATTERN = /\[source:([A-Za-z0-9_-]{1,160})\]/g;

const OMITTED_SOURCES_NOTE = (count: number) =>
  `[${count} connected source${count === 1 ? "" : "s"} omitted to stay within the chat context limit.]`;

function joinBlocks(blocks: string[]) {
  return blocks.filter(Boolean).join("\n\n");
}

/**
 * Keeps source citations useful without allowing multi-source projects to
 * exceed the API's projectContext contract. A source context is all-or-nothing
 * because its inline citation marker must remain paired with its excerpt.
 */
export function buildChatProjectContextBundle({
  projectName,
  projectDescription,
  sources,
}: {
  projectName?: string;
  projectDescription?: string;
  sources: SourceContextInput[];
}) {
  const selectedSources: Array<SourceContextInput & { context: string }> = [];
  let omittedSourceCount = 0;

  const orderedSources = sources
    .filter(
      (source) =>
        typeof source.attestation === "string" &&
        source.attestation.length > 0 &&
        source.citations.length > 0,
    )
    .sort((left, right) => {
      const freshness = Date.parse(right.syncedAt) - Date.parse(left.syncedAt);
      return freshness || left.id.localeCompare(right.id);
    });

  for (const source of orderedSources) {
    const block = source.context.trim();
    const candidate = joinBlocks([
      ...selectedSources.map((selected) => selected.context),
      block,
    ]);
    if (block && candidate.length <= CHAT_PROJECT_CONTEXT_MAX_CHARS) {
      selectedSources.push({ ...source, context: block });
    } else {
      omittedSourceCount += 1;
    }
  }

  let omissionNote =
    omittedSourceCount > 0 ? OMITTED_SOURCES_NOTE(omittedSourceCount) : "";
  while (
    omissionNote &&
    joinBlocks([
      ...selectedSources.map((source) => source.context),
      omissionNote,
    ]).length >
      CHAT_PROJECT_CONTEXT_MAX_CHARS
  ) {
    selectedSources.pop();
    omittedSourceCount += 1;
    omissionNote = OMITTED_SOURCES_NOTE(omittedSourceCount);
  }

  const sourceContext = joinBlocks([
    ...selectedSources.map((source) => source.context),
    omissionNote,
  ]);
  const projectBlock =
    projectName || projectDescription
      ? `Project: ${projectName ?? "Workspace"}\n${projectDescription ?? ""}`.trim()
      : "";
  const separator = sourceContext && projectBlock ? "\n\n" : "";
  const projectRoom =
    CHAT_PROJECT_CONTEXT_MAX_CHARS - sourceContext.length - separator.length;
  const boundedProjectBlock =
    projectRoom > 0 ? projectBlock.slice(0, projectRoom) : "";

  return {
    context: joinBlocks([sourceContext, boundedProjectBlock]),
    citationIds: [
      ...new Set(
        selectedSources.flatMap((source) => {
          const markers = new Set(
            [...source.context.matchAll(SOURCE_CITATION_PATTERN)].map(
              (match) => match[1],
            ),
          );
          return source.citations
            .map((citation) => citation.id)
            .filter((citationId) => markers.has(citationId));
        }),
      ),
    ],
    sourceSnapshots: selectedSources.map((source) => ({
      id: source.id,
      context: source.context,
      citations: source.citations,
      attestation: source.attestation!,
    })),
  };
}

export function buildChatProjectContext(
  input: Parameters<typeof buildChatProjectContextBundle>[0],
) {
  return buildChatProjectContextBundle(input).context;
}