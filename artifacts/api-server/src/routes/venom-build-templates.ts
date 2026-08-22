/**
 * Global build templates: curated starting points anyone can browse and use.
 *
 * Read side (list/get/use) is available to every signed-in account, but the
 * catalog itself is strictly read-only to users — writes happen only through
 * the slug-keyed super-admin upsert (the ops path), mirroring the canon
 * tier's discipline: the privilege gate runs before any input parsing, and
 * the refusal body is one opaque 403 regardless of why.
 *
 * "Use this template" creates a completely normal portfolio app (stamped
 * with template lineage) plus a prefill payload for the build form. It
 * deliberately does NOT create the build run: the user edits everything
 * first, and the run they eventually submit flows through the existing
 * generate → review → approve → provision pipeline unchanged.
 */

import { getAuth } from "@clerk/express";
import {
  GetVenomBuildTemplateParams,
  GetVenomBuildTemplateResponse,
  ListVenomBuildTemplatesResponse,
  UpsertVenomBuildTemplateBody,
  UpsertVenomBuildTemplateParams,
  UseVenomBuildTemplateBody,
  UseVenomBuildTemplateParams,
  UseVenomBuildTemplateResponse,
} from "@workspace/api-zod";
import {
  db,
  venomBuildTemplatesTable,
  venomPortfolioAppsTable,
  type VenomBuildTemplate,
} from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { isSuperAdmin } from "../lib/venom-super-admins";
import { countTemplateGuidance } from "../lib/venom-template-learning";
import { appPayload, EMPTY_APP_CONTEXT } from "./venom-app-portfolio";

const router: IRouter = Router();

export const TEMPLATE_ACCESS_DENIED_CODE = "template_access_denied";

/** One opaque refusal body for the ops surface, whatever the reason. */
function templateAccessDeniedBody(): {
  error: string;
  code: typeof TEMPLATE_ACCESS_DENIED_CODE;
} {
  return {
    error: "You do not have access to this.",
    code: TEMPLATE_ACCESS_DENIED_CODE,
  };
}

let resolveTemplatesUserId = (request: Request): string | null =>
  getAuth(request).userId;

function userIdFor(request: Request): string | null {
  return resolveTemplatesUserId(request);
}

export function overrideVenomBuildTemplatesUserIdResolverForTests(
  resolver: (request: Request) => string | null,
): () => void {
  const previous = resolveTemplatesUserId;
  resolveTemplatesUserId = resolver;
  return () => {
    resolveTemplatesUserId = previous;
  };
}

function summaryPayload(template: VenomBuildTemplate) {
  return {
    id: template.id,
    slug: template.slug,
    name: template.name,
    category: template.category,
    description: template.description,
    targetType: template.targetType,
    hasExamplePackage: template.examplePackage != null,
    updatedAt: template.updatedAt.toISOString(),
  };
}

async function detailPayload(template: VenomBuildTemplate) {
  // The network note must never take the detail page down: a failed count
  // reads as "nothing learned yet".
  let networkImprovementCount = 0;
  try {
    networkImprovementCount = await countTemplateGuidance(template.id);
  } catch {
    networkImprovementCount = 0;
  }
  return {
    ...summaryPayload(template),
    previewSummary: template.previewSummary,
    targetName: template.targetName,
    requirements: template.requirements,
    constraints: template.constraints,
    brandDirection: template.brandDirection,
    acceptanceChecks: template.acceptanceChecks,
    examplePackage: template.examplePackage ?? null,
    status: template.status,
    networkImprovementCount,
  };
}

async function templateById(
  templateId: string,
): Promise<VenomBuildTemplate | null> {
  const [template] = await db
    .select()
    .from(venomBuildTemplatesTable)
    .where(eq(venomBuildTemplatesTable.id, templateId))
    .limit(1);
  return template ?? null;
}

router.get("/venom/build-templates", async (req, res): Promise<void> => {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const templates = await db
    .select()
    .from(venomBuildTemplatesTable)
    .where(eq(venomBuildTemplatesTable.status, "active"))
    .orderBy(
      asc(venomBuildTemplatesTable.sortOrder),
      asc(venomBuildTemplatesTable.name),
    )
    .limit(200);
  res.json(ListVenomBuildTemplatesResponse.parse(templates.map(summaryPayload)));
});

router.get(
  "/venom/build-templates/:templateId",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = GetVenomBuildTemplateParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const template = await templateById(params.data.templateId);
    // Retired templates stay resolvable for lineage but leave the user
    // surface entirely; only the ops role can still inspect them.
    if (
      !template ||
      (template.status !== "active" && !(await isSuperAdmin(userId)))
    ) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.json(GetVenomBuildTemplateResponse.parse(await detailPayload(template)));
  },
);

router.post(
  "/venom/build-templates/:templateId/use",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const params = UseVenomBuildTemplateParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const body = UseVenomBuildTemplateBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "Invalid template use request" });
      return;
    }
    const template = await templateById(params.data.templateId);
    // Retired templates cannot start new work for anyone — including
    // admins — even though existing lineage keeps pointing at them.
    if (!template || template.status !== "active") {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const appName = (body.data.name?.trim() || template.targetName).slice(
      0,
      120,
    );
    const [app] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: userId,
        name: appName,
        purpose: template.description.slice(0, 1000),
        brand: template.name.slice(0, 120),
        templateId: template.id,
        templateName: template.name,
      })
      .returning();
    req.log.info(
      { appId: app.id, templateId: template.id },
      "Portfolio app created from template",
    );
    res.status(201).json(
      UseVenomBuildTemplateResponse.parse({
        app: appPayload(app, null, EMPTY_APP_CONTEXT),
        templateId: template.id,
        templateName: template.name,
        prefill: {
          targetType: template.targetType,
          targetName: template.targetName,
          requirements: template.requirements,
          constraints: template.constraints,
          brandDirection: template.brandDirection,
        },
      }),
    );
  },
);

router.put(
  "/venom/build-templates/by-slug/:slug",
  async (req, res): Promise<void> => {
    const userId = userIdFor(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // Privilege gate before any input parsing: unprivileged callers learn
    // nothing about what this endpoint accepts.
    if (!(await isSuperAdmin(userId))) {
      res.status(403).json(templateAccessDeniedBody());
      return;
    }
    const params = UpsertVenomBuildTemplateParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid template slug" });
      return;
    }
    const body = UpsertVenomBuildTemplateBody.safeParse(req.body);
    if (!body.success) {
      req.log.warn(
        {
          operation: "venom_build_template_upsert",
          validationIssueCount: body.error.issues.length,
        },
        "Invalid template upsert",
      );
      res.status(400).json({ error: "Invalid template" });
      return;
    }
    const values = {
      slug: params.data.slug,
      name: body.data.name.trim(),
      category: body.data.category,
      description: body.data.description.trim(),
      previewSummary: body.data.previewSummary?.trim() ?? "",
      targetType: body.data.targetType,
      targetName: body.data.targetName.trim(),
      requirements: body.data.requirements.trim(),
      constraints: body.data.constraints?.trim() ?? "",
      brandDirection: body.data.brandDirection?.trim() ?? "",
      acceptanceChecks: body.data.acceptanceChecks ?? [],
      examplePackage: body.data.examplePackage ?? null,
      status: body.data.status ?? ("active" as const),
      sortOrder: body.data.sortOrder ?? 0,
      updatedByClerkUserId: userId,
    };
    const [template] = await db
      .insert(venomBuildTemplatesTable)
      .values(values)
      .onConflictDoUpdate({
        target: venomBuildTemplatesTable.slug,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    req.log.info(
      { templateId: template.id, slug: template.slug },
      "Build template upserted",
    );
    res.json(GetVenomBuildTemplateResponse.parse(await detailPayload(template)));
  },
);

export default router;
