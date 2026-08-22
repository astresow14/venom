/**
 * Markdown exports for Venom knowledge and SOPs — the product's first real
 * "take it with you" surface.
 *
 * Two callers share these generators:
 *   - the personal export route (always allowed, scoped to the requesting
 *     account's personal tier), and
 *   - the workspace export route, where the workspace's export policy is
 *     enforced HERE, server-side: when the policy forbids sensitive content
 *     leaving, locked clusters, locked evidence entries, and locked SOPs are
 *     excluded and the file states exactly how many items were withheld.
 *     A silent gap would defeat the point of the statement, so the count is
 *     printed prominently near the top and inside any cluster that lost
 *     evidence.
 *
 * Stored summaries and excerpts can carry inline `[source:...]` citation
 * markers (the same machine markers assistant answers store). A reader must
 * never see a raw marker, so rendering resolves each one exactly like the
 * clients do: live citations read as their source title, retired ones as the
 * archived reference, and anything unknown falls back to the archived label.
 */

import type { OntologyConcept } from "./venom-ontology-core";

const CITATION_MARKER_SPLIT_PATTERN = /(\[source:[A-Za-z0-9_-]{1,160}\])/g;
const ARCHIVED_CITATION_LABEL = "(archived source)";

export type CitationLabelLookup = {
  /** Live source citation titles by citation id. */
  liveTitles: Map<string, string>;
  /** Retired citation titles by citation id (rendered as "title (archived)"). */
  archivedTitles: Map<string, string>;
};

const EMPTY_LOOKUP: CitationLabelLookup = {
  liveTitles: new Map(),
  archivedTitles: new Map(),
};

/**
 * Flattens knowledge-derived text to reader-facing plain text, mirroring the
 * clients' knowledgeDisplayText: live markers become their source title,
 * retired ones their archived label, unknown ones the neutral archived
 * reference — and an unterminated marker is dropped rather than leaked.
 */
export function renderKnowledgeText(
  text: string,
  lookup: CitationLabelLookup = EMPTY_LOOKUP,
): string {
  if (!text) return "";
  const flattened = text
    .split(CITATION_MARKER_SPLIT_PATTERN)
    .map((part) => {
      const match = part.match(/^\[source:([A-Za-z0-9_-]{1,160})\]$/);
      if (!match) return part;
      const live = lookup.liveTitles.get(match[1]);
      if (live) return live;
      const archived = lookup.archivedTitles.get(match[1]);
      return archived ? `${archived} (archived)` : ARCHIVED_CITATION_LABEL;
    })
    .join("");
  return flattened
    .replace(/\[source:[^\]]*(?:\]|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type MarkdownExportOptions = {
  /** Heading scope, e.g. `Personal` or `Workspace "Growth team"`. */
  scopeTitle: string;
  /**
   * Export policy verdict. True includes sensitive items (plainly labeled);
   * false withholds them and states how many were withheld.
   */
  allowSensitive: boolean;
  /**
   * Role verdict for admin-only items. True (admins and the personal tier)
   * includes them, plainly labeled; false withholds them and states how
   * many were withheld. Independent of the sensitivity policy: a member's
   * export never carries admin-only content regardless of allowSensitive.
   */
  includeRestricted: boolean;
  citationLookup?: CitationLabelLookup;
  /** Export timestamp (ms); defaults to now. */
  generatedAt?: number;
};

export type MarkdownExport = {
  markdown: string;
  /** How many sensitive items (clusters, evidence entries, SOPs) were withheld. */
  withheldCount: number;
  /** How many admin-only items (clusters, SOPs) were withheld for role. */
  restrictedWithheldCount: number;
};

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function headerLines(
  title: string,
  options: MarkdownExportOptions,
  withheldCount: number,
  restrictedWithheldCount: number,
  emptyMessage: string,
  isEmpty: boolean,
): string[] {
  const lines = [
    `# ${title} — ${options.scopeTitle}`,
    "",
    `Exported ${new Date(options.generatedAt ?? Date.now()).toISOString()}.`,
    "",
  ];
  if (withheldCount > 0) {
    const noun = withheldCount === 1 ? "item was" : "items were";
    lines.push(
      `**${withheldCount} sensitive ${noun} withheld by the workspace export policy.**`,
      "",
    );
  }
  if (restrictedWithheldCount > 0) {
    const noun = restrictedWithheldCount === 1 ? "item was" : "items were";
    lines.push(
      `**${restrictedWithheldCount} admin-only ${noun} withheld from this export.**`,
      "",
    );
  }
  if (isEmpty) {
    lines.push(emptyMessage, "");
  }
  return lines;
}

/** Renders knowledge clusters (Brain notes and evidence) as Markdown. */
export function knowledgeMarkdown(
  clusters: OntologyConcept[],
  options: MarkdownExportOptions,
): MarkdownExport {
  const lookup = options.citationLookup ?? EMPTY_LOOKUP;
  let withheldCount = 0;
  let restrictedWithheldCount = 0;

  const included = [...clusters]
    .sort((a, b) => b.strength - a.strength || b.lastUpdatedAt - a.lastUpdatedAt)
    .filter((cluster) => {
      // Role first: an admin-only cluster is invisible to a member no matter
      // what the sensitivity policy says, and counts once, like a cluster.
      if (cluster.adminOnly && !options.includeRestricted) {
        restrictedWithheldCount += 1;
        return false;
      }
      if (cluster.sensitive && !options.allowSensitive) {
        // The whole cluster stays inside, evidence and all. Count it as one
        // withheld item so the statement matches what a reader would miss.
        withheldCount += 1;
        return false;
      }
      return true;
    });

  const sections: string[] = [];
  for (const cluster of included) {
    const lines: string[] = [`## ${renderKnowledgeText(cluster.label, lookup) || cluster.label}`, ""];
    const facts = [
      `Category: ${cluster.category}`,
      `Strength: ${Math.round(cluster.strength * 100)}%`,
      `Mentions: ${cluster.mentionCount}`,
      `Last updated: ${isoDay(cluster.lastUpdatedAt)}`,
    ];
    if (cluster.sensitive) facts.push("Marked sensitive");
    if (cluster.adminOnly) facts.push("Admin-only");
    lines.push(facts.map((fact) => `- ${fact}`).join("\n"), "");

    const summary = renderKnowledgeText(cluster.summary, lookup);
    if (summary) lines.push(summary, "");
    const description = cluster.description
      ? renderKnowledgeText(cluster.description, lookup)
      : "";
    if (description && description !== summary) lines.push(description, "");

    const keptSources = cluster.sources.filter((evidence) => {
      if (evidence.sensitive && !options.allowSensitive) {
        withheldCount += 1;
        return false;
      }
      return true;
    });
    const droppedHere = cluster.sources.length - keptSources.length;

    if (keptSources.length > 0) {
      lines.push("### Evidence", "");
      for (const evidence of keptSources) {
        const title = renderKnowledgeText(evidence.conversationTitle, lookup) ||
          evidence.conversationTitle;
        const excerpt = renderKnowledgeText(evidence.excerpt, lookup);
        const suffix = evidence.sensitive ? " _(marked sensitive)_" : "";
        lines.push(
          `- **${title}** (${isoDay(evidence.updatedAt)})${suffix}${excerpt ? `: ${excerpt}` : ""}`,
        );
      }
      lines.push("");
    }
    if (droppedHere > 0) {
      const noun = droppedHere === 1 ? "evidence entry" : "evidence entries";
      lines.push(
        `_${droppedHere} sensitive ${noun} withheld by the workspace export policy._`,
        "",
      );
    }
    sections.push(lines.join("\n"));
  }

  const lines = [
    ...headerLines(
      "Venom Brain",
      options,
      withheldCount,
      restrictedWithheldCount,
      "No knowledge captured yet.",
      included.length === 0,
    ),
    ...sections,
  ];
  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    withheldCount,
    restrictedWithheldCount,
  };
}

/** The SOP fields an export renders; structural so DB rows fit directly. */
export type ExportableSop = {
  title: string;
  lifecycle: string;
  category: string;
  tags: string[];
  sensitive?: boolean;
  adminOnly?: boolean;
  updatedAt: Date;
  content: {
    purpose: string;
    prerequisites: string[];
    inputs: string[];
    guidance: string[];
    requiredApprovals: string[];
    acceptanceChecks: string[];
  };
};

function sopSection(heading: string, items: string[], ordered = false): string[] {
  if (items.length === 0) return [];
  return [
    `### ${heading}`,
    "",
    items
      .map((item, index) => (ordered ? `${index + 1}. ${item}` : `- ${item}`))
      .join("\n"),
    "",
  ];
}

/** Renders SOPs as Markdown. Same policy contract as knowledgeMarkdown. */
export function sopsMarkdown(
  sops: ExportableSop[],
  options: MarkdownExportOptions,
): MarkdownExport {
  let withheldCount = 0;
  let restrictedWithheldCount = 0;
  const included = sops.filter((sop) => {
    if (sop.adminOnly && !options.includeRestricted) {
      restrictedWithheldCount += 1;
      return false;
    }
    if (sop.sensitive && !options.allowSensitive) {
      withheldCount += 1;
      return false;
    }
    return true;
  });

  const sections = included.map((sop) => {
    const facts = [
      `Category: ${sop.category}`,
      `Lifecycle: ${sop.lifecycle}`,
      ...(sop.tags.length > 0 ? [`Tags: ${sop.tags.join(", ")}`] : []),
      `Last updated: ${isoDay(sop.updatedAt.getTime())}`,
    ];
    if (sop.sensitive) facts.push("Marked sensitive");
    if (sop.adminOnly) facts.push("Admin-only");
    return [
      `## ${sop.title}`,
      "",
      facts.map((fact) => `- ${fact}`).join("\n"),
      "",
      "### Purpose",
      "",
      sop.content.purpose,
      "",
      ...sopSection("Prerequisites", sop.content.prerequisites),
      ...sopSection("Inputs", sop.content.inputs),
      ...sopSection("Guidance", sop.content.guidance, true),
      ...sopSection("Required approvals", sop.content.requiredApprovals),
      ...sopSection("Acceptance checks", sop.content.acceptanceChecks),
    ].join("\n");
  });

  const lines = [
    ...headerLines(
      "Venom SOPs",
      options,
      withheldCount,
      restrictedWithheldCount,
      "No SOPs recorded yet.",
      included.length === 0,
    ),
    ...sections,
  ];
  return {
    markdown: `${lines.join("\n").trimEnd()}\n`,
    withheldCount,
    restrictedWithheldCount,
  };
}

/** Attachment filename: `venom-<scope>-<kind>-<yyyy-mm-dd>.md`. */
export function exportFileName(scope: string, kind: string, now = Date.now()): string {
  const safeScope = scope
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `venom-${safeScope || "export"}-${kind}-${isoDay(now)}.md`;
}
