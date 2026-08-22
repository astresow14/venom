import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomBuildRunsTable,
  venomBuildTemplatesTable,
  venomPortfolioAppIterationsTable,
  venomPortfolioAppsTable,
  venomSuperAdminsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import { normalizeBuildPackage } from "../lib/venom-build-package-generator.js";
import buildRunsRouter, {
  overrideVenomBuildRunGeneratorForTests,
  overrideVenomBuildRunSchedulerForTests,
  overrideVenomBuildRunUserIdResolverForTests,
  processVenomBuildRunForTests,
} from "./venom-build-runs.js";
import templatesRouter, {
  overrideVenomBuildTemplatesUserIdResolverForTests,
} from "./venom-build-templates.js";

type TestResponse = {
  status: number;
  body: any;
};

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

test("build templates are read-only for users and stamp lineage through the approval chain", async () => {
  const suffix = randomUUID();
  const user = `tpl-user-${suffix}`;
  const admin = `tpl-admin-${suffix}`;
  const activeSlug = `it-active-${suffix.slice(0, 8)}`;
  const retiredSlug = `it-retired-${suffix.slice(0, 8)}`;
  const opsSlug = `it-ops-${suffix.slice(0, 8)}`;
  const doomedSlug = `it-doomed-${suffix.slice(0, 8)}`;
  let activeUserId: string | null = user;
  const restoreTemplatesAuth = overrideVenomBuildTemplatesUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreRunsAuth = overrideVenomBuildRunUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(() => {});
  const generatorInputs: any[] = [];
  const restoreGenerator = overrideVenomBuildRunGeneratorForTests(
    async (input) => {
      generatorInputs.push(input);
      return normalizeBuildPackage({ title: "Template chain package" }, input);
    },
  );

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as typeof request.log;
    next();
  });
  app.use(templatesRouter);
  app.use(buildRunsRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<TestResponse> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
    });
    const rawBody = await response.text();
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    return { status: response.status, body };
  }

  const examplePackage = normalizeBuildPackage(
    { title: "Example booking package" },
    {
      targetType: "app",
      targetName: "Bookings",
      requirements: "Clients book open slots.",
      constraints: "",
      brandDirection: "",
      sourceReferences: [],
      sopReferences: [],
    },
  );

  try {
    const [activeTemplate] = await db
      .insert(venomBuildTemplatesTable)
      .values({
        slug: activeSlug,
        name: "Integration Booking Template",
        category: "app",
        description: "Bookings without back-and-forth messages.",
        previewSummary: "A booking flow plus an owner dashboard.",
        targetType: "app",
        targetName: "Integration Booking App",
        requirements: "Build a booking app with real availability.",
        constraints: "No payments in v1.",
        brandDirection: "Calm and trustworthy.",
        acceptanceChecks: ["Booked slots leave availability"],
        examplePackage,
        sortOrder: 1,
      })
      .returning();
    const [retiredTemplate] = await db
      .insert(venomBuildTemplatesTable)
      .values({
        slug: retiredSlug,
        name: "Retired Template",
        category: "widget",
        description: "No longer offered.",
        targetType: "website",
        targetName: "Retired Widget",
        requirements: "Old requirements.",
        status: "retired",
        sortOrder: 2,
      })
      .returning();

    // ── Browse: active only, summary shape ─────────────────────────────
    const list = await request("/venom/build-templates");
    assertStatus(list, 200);
    const listedActive = list.body.find(
      (item: { id: string }) => item.id === activeTemplate.id,
    );
    assert.ok(listedActive, "active template appears in the gallery");
    assert.equal(listedActive.hasExamplePackage, true);
    assert.equal(listedActive.category, "app");
    assert.ok(
      !list.body.some(
        (item: { id: string }) => item.id === retiredTemplate.id,
      ),
      "retired template is invisible in the gallery",
    );

    const detail = await request(
      `/venom/build-templates/${activeTemplate.id}`,
    );
    assertStatus(detail, 200);
    assert.equal(
      detail.body.requirements,
      "Build a booking app with real availability.",
    );
    assert.equal(detail.body.examplePackage.title, "Example booking package");
    assertStatus(
      await request(`/venom/build-templates/${retiredTemplate.id}`),
      404,
    );

    // ── Unauthenticated: nothing is reachable ──────────────────────────
    activeUserId = null;
    assertStatus(await request("/venom/build-templates"), 401);
    assertStatus(
      await request(`/venom/build-templates/by-slug/${opsSlug}`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
      401,
    );

    // ── Read-only for users: opaque refusal before any parsing ─────────
    activeUserId = user;
    const denied = await request(
      `/venom/build-templates/by-slug/${opsSlug}`,
      {
        method: "PUT",
        body: JSON.stringify({ garbage: true }),
      },
    );
    assertStatus(denied, 403);
    assert.deepEqual(denied.body, {
      error: "You do not have access to this.",
      code: "template_access_denied",
    });

    // ── Ops path: super admins upsert by slug without code changes ─────
    await db.insert(venomSuperAdminsTable).values({
      clerkUserId: admin,
      grantedByClerkUserId: null,
    });
    activeUserId = admin;
    const adminRetiredDetail = await request(
      `/venom/build-templates/${retiredTemplate.id}`,
    );
    assertStatus(adminRetiredDetail, 200);
    assert.equal(adminRetiredDetail.body.status, "retired");

    const invalidUpsert = await request(
      `/venom/build-templates/by-slug/${opsSlug}`,
      {
        method: "PUT",
        body: JSON.stringify({ name: "Missing required fields" }),
      },
    );
    assertStatus(invalidUpsert, 400);

    const createdByOps = await request(
      `/venom/build-templates/by-slug/${opsSlug}`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: "Ops Created Template",
          category: "widget",
          description: "Created through the ops path.",
          targetType: "website",
          targetName: "Ops Widget",
          requirements: "Ops requirements.",
        }),
      },
    );
    assertStatus(createdByOps, 200);
    assert.equal(createdByOps.body.slug, opsSlug);
    assert.equal(createdByOps.body.hasExamplePackage, false);

    const updatedByOps = await request(
      `/venom/build-templates/by-slug/${opsSlug}`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: "Ops Updated Template",
          category: "widget",
          description: "Updated through the ops path.",
          targetType: "website",
          targetName: "Ops Widget",
          requirements: "Ops requirements v2.",
          status: "retired",
        }),
      },
    );
    assertStatus(updatedByOps, 200);
    assert.equal(updatedByOps.body.id, createdByOps.body.id, "upsert updates in place");
    assert.equal(updatedByOps.body.name, "Ops Updated Template");
    assert.equal(updatedByOps.body.status, "retired");
    const [opsRow] = await db
      .select()
      .from(venomBuildTemplatesTable)
      .where(eq(venomBuildTemplatesTable.slug, opsSlug));
    assert.equal(opsRow.updatedByClerkUserId, admin);

    // Retiring a template cannot start new work, even for the admin.
    assertStatus(
      await request(`/venom/build-templates/${createdByOps.body.id}/use`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      404,
    );

    // ── Use flow: app + prefill, lineage stamped ───────────────────────
    activeUserId = user;
    const used = await request(
      `/venom/build-templates/${activeTemplate.id}/use`,
      {
        method: "POST",
        body: JSON.stringify({ name: "My Booking Studio" }),
      },
    );
    assertStatus(used, 201);
    assert.equal(used.body.app.name, "My Booking Studio");
    assert.equal(used.body.app.templateId, activeTemplate.id);
    assert.equal(used.body.app.templateName, "Integration Booking Template");
    assert.deepEqual(used.body.prefill, {
      targetType: "app",
      targetName: "Integration Booking App",
      requirements: "Build a booking app with real availability.",
      constraints: "No payments in v1.",
      brandDirection: "Calm and trustworthy.",
    });
    const [appRow] = await db
      .select()
      .from(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.id, used.body.app.id));
    assert.equal(appRow.templateId, activeTemplate.id);
    assert.equal(appRow.templateName, "Integration Booking Template");

    assertStatus(
      await request(`/venom/build-templates/${retiredTemplate.id}/use`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      404,
    );

    // ── Run lineage: inherited from the pinned app ─────────────────────
    const runFromApp = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify({
        targetType: "app",
        targetName: "Integration Booking App",
        requirements: "Build a booking app with real availability.",
        constraints: "No payments in v1.",
        brandDirection: "Calm and trustworthy.",
        appId: used.body.app.id,
        sourceVersionId: null,
        projectId: null,
        sopRevisionIds: [],
        idempotencyKey: randomUUID().replaceAll("-", "_"),
      }),
    });
    assertStatus(runFromApp, 201);
    assert.equal(runFromApp.body.templateId, activeTemplate.id);
    assert.equal(runFromApp.body.request.templateId, activeTemplate.id);

    // ── Run lineage: explicit template id without an app ───────────────
    const runExplicit = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify({
        targetType: "website",
        targetName: "Standalone from template",
        requirements: "Standalone requirements.",
        constraints: "",
        brandDirection: "",
        appId: null,
        sourceVersionId: null,
        projectId: null,
        sopRevisionIds: [],
        templateId: activeTemplate.id,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
      }),
    });
    assertStatus(runExplicit, 201);
    assert.equal(runExplicit.body.templateId, activeTemplate.id);

    // A lineage claim against a template that never existed is refused.
    assertStatus(
      await request("/venom/build-runs", {
        method: "POST",
        body: JSON.stringify({
          targetType: "website",
          targetName: "Bad lineage",
          requirements: "Bad lineage requirements.",
          constraints: "",
          brandDirection: "",
          appId: null,
          sourceVersionId: null,
          projectId: null,
          sopRevisionIds: [],
          templateId: randomUUID(),
          idempotencyKey: randomUUID().replaceAll("-", "_"),
        }),
      }),
      400,
    );

    // ── Generation wiring: bounded template context, stamp chain ───────
    await processVenomBuildRunForTests(user, runFromApp.body.id);
    assert.equal(generatorInputs.length, 1);
    const templateContext = generatorInputs[0].templateContext;
    assert.ok(templateContext, "generator received template context");
    assert.equal(templateContext.name, "Integration Booking Template");
    assert.equal(templateContext.category, "app");
    assert.equal(
      templateContext.requirementsSkeleton,
      "Build a booking app with real availability.",
    );
    assert.deepEqual(templateContext.suggestedAcceptanceChecks, [
      "Booked slots leave availability",
    ]);
    assert.ok(
      templateContext.examplePackage,
      "example package rides along as reference data",
    );

    const processed = await request(`/venom/build-runs/${runFromApp.body.id}`);
    assertStatus(processed, 200);
    assert.equal(processed.body.status, "review_required");
    const revisionId = processed.body.revisions[0].id;

    const approved = await request(
      `/venom/build-runs/${runFromApp.body.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ revisionId }),
      },
    );
    assertStatus(approved, 200);
    assert.equal(approved.body.status, "ready_for_provisioning");

    const [revisionRow] = await db
      .select()
      .from(venomBuildPackageRevisionsTable)
      .where(eq(venomBuildPackageRevisionsTable.id, revisionId));
    assert.equal(
      revisionRow.templateId,
      activeTemplate.id,
      "package revision carries lineage",
    );
    const [iterationRow] = await db
      .select()
      .from(venomPortfolioAppIterationsTable)
      .where(
        and(
          eq(venomPortfolioAppIterationsTable.appId, used.body.app.id),
          eq(venomPortfolioAppIterationsTable.clerkUserId, user),
        ),
      );
    assert.ok(iterationRow, "approval registered the app iteration");
    assert.equal(
      iterationRow.templateId,
      activeTemplate.id,
      "approved iteration carries lineage",
    );

    // Runs without lineage stay null through the same chain.
    assert.equal(runExplicit.body.appId, null);
    const [plainRun] = await db
      .select()
      .from(venomBuildRunsTable)
      .where(eq(venomBuildRunsTable.id, runExplicit.body.id));
    assert.equal(plainRun.templateId, activeTemplate.id);

    // ── Vanished lineage fails the run explicitly ──────────────────────
    const [doomedTemplate] = await db
      .insert(venomBuildTemplatesTable)
      .values({
        slug: doomedSlug,
        name: "Doomed Template",
        category: "app",
        description: "Will vanish before generation.",
        targetType: "app",
        targetName: "Doomed App",
        requirements: "Doomed requirements.",
      })
      .returning();
    const doomedRun = await request("/venom/build-runs", {
      method: "POST",
      body: JSON.stringify({
        targetType: "app",
        targetName: "Doomed App",
        requirements: "Doomed requirements.",
        constraints: "",
        brandDirection: "",
        appId: null,
        sourceVersionId: null,
        projectId: null,
        sopRevisionIds: [],
        templateId: doomedTemplate.id,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
      }),
    });
    assertStatus(doomedRun, 201);
    await db
      .delete(venomBuildTemplatesTable)
      .where(eq(venomBuildTemplatesTable.id, doomedTemplate.id));
    await processVenomBuildRunForTests(user, doomedRun.body.id);
    const doomedResult = await request(
      `/venom/build-runs/${doomedRun.body.id}`,
    );
    assertStatus(doomedResult, 200);
    assert.equal(doomedResult.body.status, "failed");
    assert.equal(
      doomedResult.body.failureCode,
      "pinned_reference_unavailable",
    );
  } finally {
    server.close();
    restoreTemplatesAuth();
    restoreRunsAuth();
    restoreScheduler();
    restoreGenerator();
    await db
      .delete(venomPortfolioAppIterationsTable)
      .where(
        inArray(venomPortfolioAppIterationsTable.clerkUserId, [user, admin]),
      );
    await db
      .delete(venomBuildRunsTable)
      .where(inArray(venomBuildRunsTable.clerkUserId, [user, admin]));
    await db
      .delete(venomPortfolioAppsTable)
      .where(inArray(venomPortfolioAppsTable.clerkUserId, [user, admin]));
    await db
      .delete(venomBuildTemplatesTable)
      .where(
        inArray(venomBuildTemplatesTable.slug, [
          activeSlug,
          retiredSlug,
          opsSlug,
          doomedSlug,
        ]),
      );
    await db
      .delete(venomSuperAdminsTable)
      .where(eq(venomSuperAdminsTable.clerkUserId, admin));
  }
});
