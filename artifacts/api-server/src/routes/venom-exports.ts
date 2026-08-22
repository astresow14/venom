/**
 * Personal markdown exports: the signed-in account's own Brain knowledge and
 * SOPs as .md downloads.
 *
 * Always scoped to the requesting account's personal tier — no workspace
 * content ever rides through here, which is exactly why the download keeps
 * working after someone is removed from a workspace. Workspace exports live
 * on the membership-checked workspace router instead, where the workspace's
 * export policy is enforced.
 */

import { getAuth } from "@clerk/express";
import { ExportVenomPersonalMarkdownParams } from "@workspace/api-zod";
import { db, venomSopsTable, venomWorkspacesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  exportFileName,
  knowledgeMarkdown,
  sopsMarkdown,
  type CitationLabelLookup,
} from "../lib/venom-markdown-export";
import { loadOntologyConcepts, userOwner } from "../lib/venom-ontology-store";

const router: IRouter = Router();
type UserIdResolver = (request: Request) => string | null;
let testUserIdResolver: UserIdResolver | null = null;

function userIdFor(request: Request): string | null {
  if (testUserIdResolver) return testUserIdResolver(request);
  return getAuth(request).userId;
}

export function overrideVenomExportUserIdResolverForTests(
  resolver: UserIdResolver,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Export route auth overrides are available only in tests");
  }
  const previous = testUserIdResolver;
  testUserIdResolver = resolver;
  return () => {
    testUserIdResolver = previous;
  };
}

/**
 * The slice of the synced workspace blob the citation lookup reads. The blob
 * column is untyped jsonb; this stays structural on purpose so a lookup miss
 * degrades to the archived-reference label instead of a crash.
 */
type PersonalBlobState = {
  sources?: Array<{ citations?: Array<{ id?: string; title?: string }> }>;
  archivedCitations?: Array<{ id?: string; title?: string }>;
};

/**
 * Citation labels from the account's own synced workspace blob, so inline
 * `[source:...]` markers in summaries and excerpts render as source titles
 * exactly like the clients show them.
 */
async function personalCitationLookup(
  userId: string,
): Promise<CitationLabelLookup> {
  const liveTitles = new Map<string, string>();
  const archivedTitles = new Map<string, string>();
  const [workspace] = await db
    .select({ state: venomWorkspacesTable.state })
    .from(venomWorkspacesTable)
    .where(eq(venomWorkspacesTable.clerkUserId, userId))
    .limit(1);
  const state = workspace?.state as PersonalBlobState | undefined;
  for (const source of state?.sources ?? []) {
    for (const citation of source.citations ?? []) {
      if (citation?.id && citation.title) {
        liveTitles.set(citation.id, citation.title);
      }
    }
  }
  for (const archived of state?.archivedCitations ?? []) {
    if (archived?.id && archived.title) {
      archivedTitles.set(archived.id, archived.title);
    }
  }
  return { liveTitles, archivedTitles };
}

router.get("/venom/exports/:kind", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const params = ExportVenomPersonalMarkdownParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid export request" });
    return;
  }
  // Brain exports follow the Brain page's scope filter: everything (no
  // param), only sorted knowledge, or only the Unsorted holding area. All
  // three are personal-tier views of the caller's own store.
  const scopeRaw = req.query.scope;
  const scope =
    scopeRaw === undefined || scopeRaw === "sorted" || scopeRaw === "unsorted"
      ? (scopeRaw as "sorted" | "unsorted" | undefined)
      : null;
  if (scope === null) {
    res.status(400).json({ error: "Invalid export request" });
    return;
  }

  // Personal tier only: your own notes always leave with you. The workspace
  // export policy and admin-only restrictions govern workspace content,
  // which this route never touches.
  const options = {
    scopeTitle: scope === "unsorted" ? "Unsorted" : "Personal",
    allowSensitive: true,
    includeRestricted: true,
  } as const;
  let markdown: string;
  if (params.data.kind === "brain") {
    const [allConcepts, citationLookup] = await Promise.all([
      loadOntologyConcepts(userOwner(userId)),
      personalCitationLookup(userId),
    ]);
    const concepts =
      scope === "unsorted"
        ? allConcepts.filter((concept) => concept.unsorted === true)
        : scope === "sorted"
          ? allConcepts.filter((concept) => concept.unsorted !== true)
          : allConcepts;
    markdown = knowledgeMarkdown(concepts, { ...options, citationLookup })
      .markdown;
  } else {
    const sops = await db
      .select()
      .from(venomSopsTable)
      .where(eq(venomSopsTable.clerkUserId, userId))
      .orderBy(desc(venomSopsTable.updatedAt))
      .limit(500);
    markdown = sopsMarkdown(
      sops.filter((sop) => sop.lifecycle !== "archived"),
      options,
    ).markdown;
  }

  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${exportFileName(
      scope === "unsorted" ? "unsorted" : "personal",
      params.data.kind,
    )}"`,
  );
  res.send(markdown);
});

export default router;
