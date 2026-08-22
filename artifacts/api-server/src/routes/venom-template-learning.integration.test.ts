/**
 * Template learning integration tests: consent gating, distinct-tenant
 * threshold, opt-out recomputation, generation injection bounds and
 * observability, and the structural no-verbatim-text guarantee.
 *
 * Runs against the shared dev database like the other route suites; all
 * fixtures are suffixed per run and removed in finally blocks.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomBuildRunEventsTable,
  venomBuildRunsTable,
  venomBuildTemplatesTable,
  venomMasterContributionSettingsTable,
  venomTemplateEditSignalsTable,
  venomTemplateGuidanceTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import {
  setMasterContribution,
  userTenant,
} from "../lib/venom-master-ontology.js";
import {
  contributeTemplateEditSignals,
  countTemplateGuidance,
  deriveTemplateEditSignals,
  getTemplateGuidance,
  TEMPLATE_EDIT_SIGNAL_VOCABULARY,
  TEMPLATE_LEARNING_BOUNDS,
} from "../lib/venom-template-learning.js";
import buildRunsRouter, {
  overrideVenomBuildRunGeneratorForTests,
  overrideVenomBuildRunSchedulerForTests,
  overrideVenomBuildRunUserIdResolverForTests,
  processVenomBuildRunForTests,
} from "./venom-build-runs.js";
import buildTemplatesRouter, {
  overrideVenomBuildTemplatesUserIdResolverForTests,
} from "./venom-build-templates.js";

type TestResponse = { status: number; body: any };

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

const basePackage = (title: string) => ({
  formatVersion: 1 as const,
  targetType: "website" as const,
  title,
  productBrief: {
    summary: "A small business site.",
    audience: ["Local customers"],
    outcomes: ["More bookings"],
  },
  functionalScope: ["Show services", "Contact form"],
  brandDirection: ["High contrast", "Rounded corners"],
  contentRequirements: ["About page copy"],
  serviceFlowRequirements: [],
  sourceReferences: [],
  sopReferences: [],
  dataNeeds: [],
  integrationNeeds: [],
  permissionRequests: [],
  acceptanceChecks: ["Loads fast"],
  launchConstraints: [
    "Human approval is required before any provisioning or external action.",
  ],
});

async function insertTemplate(suffix: string, slugPrefix: string) {
  const [template] = await db
    .insert(venomBuildTemplatesTable)
    .values({
      slug: `${slugPrefix}-${suffix}`,
      name: "Test learning template",
      category: "app",
      description: "Template used by template-learning tests.",
      previewSummary: "",
      targetType: "website",
      targetName: "Learning target",
      requirements: "Build a small site.",
      constraints: "",
      brandDirection: "",
      acceptanceChecks: [],
      examplePackage: null,
      status: "active",
      sortOrder: 900,
    })
    .returning();
  return template;
}

test("derivation is closed-vocabulary, concept-level, and bounded", () => {
  const marker = `xyzzy${randomUUID().replaceAll("-", "")}`;
  const first = basePackage("First title");
  const approved = {
    ...basePackage("Approved different title"),
    functionalScope: [...first.functionalScope, "Tips jar"],
    brandDirection: ["High contrast"],
  };
  const keys = deriveTemplateEditSignals({
    firstPackage: first,
    approvedPackage: approved,
    revisionInstructions: [`Simplify the pricing area please ${marker}`],
    iterationInstruction: null,
  });
  assert.ok(keys.includes("scope_expanded"), `keys: ${keys.join(",")}`);
  assert.ok(keys.includes("brand_trimmed"));
  assert.ok(keys.includes("title_reworked"));
  assert.ok(keys.includes("theme_simplify"));
  assert.ok(keys.includes("theme_pricing_payments"));
  for (const key of keys) {
    assert.ok(
      TEMPLATE_EDIT_SIGNAL_VOCABULARY[key],
      `non-vocabulary key: ${key}`,
    );
    assert.ok(!key.includes("xyzzy"), "instruction text leaked into a key");
    assert.match(key, /^[a-z0-9_]+$/);
  }

  // Identical packages and empty instructions derive nothing.
  assert.deepEqual(
    deriveTemplateEditSignals({
      firstPackage: first,
      approvedPackage: first,
      revisionInstructions: ["   "],
      iterationInstruction: null,
    }),
    [],
  );

  // A maximal edit stays within the per-approval cap.
  const everything = {
    ...basePackage("Renamed entirely"),
    productBrief: {
      summary: "Rewritten.",
      audience: ["Other people"],
      outcomes: ["Other outcomes"],
    },
    functionalScope: ["Entirely new scope"],
    brandDirection: ["New look"],
    contentRequirements: ["New content", "More content"],
    serviceFlowRequirements: ["A flow"],
    dataNeeds: ["Customers"],
    integrationNeeds: ["Calendar"],
    permissionRequests: [
      { capability: "Send email", reason: "Notify", required: false },
    ],
    acceptanceChecks: ["New check"],
    launchConstraints: ["New constraint"],
  };
  const maximal = deriveTemplateEditSignals({
    firstPackage: first,
    approvedPackage: everything,
    revisionInstructions: [
      "Simplify and add missing features, redesign the look, rewrite the copy for a new audience, fix pricing and checkout, new form fields, integrate the calendar api, improve accessibility and mobile speed, tighten privacy permissions, better onboarding and notifications, add search, translate to spanish, add scheduling and analytics dashboards",
    ],
    iterationInstruction: null,
  });
  assert.ok(maximal.length <= TEMPLATE_LEARNING_BOUNDS.signalsPerApproval);
  assert.equal(new Set(maximal).size, maximal.length);

  // Vocabulary sanity: keys are concept-shaped, copy is short and compiled.
  for (const [key, entry] of Object.entries(TEMPLATE_EDIT_SIGNAL_VOCABULARY)) {
    assert.match(key, /^[a-z0-9_]+$/);
    assert.ok(entry.title.length > 0 && entry.title.length <= 60);
    assert.ok(entry.guidance.length > 0 && entry.guidance.length <= 300);
  }
});

test("approval-path signals honor consent, threshold, and opt-out", async () => {
  const suffix = randomUUID();
  const marker = `xyzzy${suffix.replaceAll("-", "")}`;
  const ownerA = `template-learn-a-${suffix}`;
  const ownerB = `template-learn-b-${suffix}`;
  const ownerC = `template-learn-c-${suffix}`;
  const owners = [ownerA, ownerB, ownerC];
  let activeUserId = ownerA;
  const restoreRunsAuth = overrideVenomBuildRunUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreTemplatesAuth = overrideVenomBuildTemplatesUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(() => {});
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
  app.use(buildRunsRouter);
  app.use(buildTemplatesRouter);
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
      headers: { "content-type": "application/json", ...options.headers },
    });
    const raw = await response.text();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    return { status: response.status, body };
  }

  let templateId: string | null = null;
  try {
    const template = await insertTemplate(suffix, "learn-consent");
    templateId = template.id;

    async function insertReviewableRun(owner: string) {
      const [run] = await db
        .insert(venomBuildRunsTable)
        .values({
          clerkUserId: owner,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetType: "website",
          targetName: "Learning target",
          requirements: `Build the site. ${marker}`,
          constraints: "",
          brandDirection: "",
          sopRevisionIds: [],
          templateId: template.id,
          status: "review_required",
          progress: 100,
          currentRevisionNumber: 2,
        })
        .returning();
      await db.insert(venomBuildPackageRevisionsTable).values({
        runId: run.id,
        clerkUserId: owner,
        revisionNumber: 1,
        reason: "Initial generated package",
        package: basePackage("First title"),
        checksumSha256: "b".repeat(64),
        templateId: template.id,
      });
      const [revision2] = await db
        .insert(venomBuildPackageRevisionsTable)
        .values({
          runId: run.id,
          clerkUserId: owner,
          revisionNumber: 2,
          reason: `Simplify the pricing area please ${marker}`,
          package: {
            ...basePackage("Approved new title"),
            functionalScope: ["Show services", "Contact form", "Tips jar"],
            brandDirection: ["High contrast"],
          },
          checksumSha256: "c".repeat(64),
          templateId: template.id,
        })
        .returning();
      return { run, revision2 };
    }

    // 1) Without opt-in, approval contributes nothing.
    const withoutConsent = await insertReviewableRun(ownerA);
    activeUserId = ownerA;
    const approvedWithout = await request(
      `/venom/build-runs/${withoutConsent.run.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ revisionId: withoutConsent.revision2.id }),
      },
    );
    assertStatus(approvedWithout, 200);
    const rowsWithout = await db
      .select()
      .from(venomTemplateEditSignalsTable)
      .where(eq(venomTemplateEditSignalsTable.tenantId, ownerA));
    assert.equal(rowsWithout.length, 0, "consent-off approval wrote signals");

    // 2) With opt-in, approval contributes closed-vocabulary signals only.
    await setMasterContribution({
      tenant: userTenant(ownerA),
      enabled: true,
      updatedByUserId: ownerA,
    });
    const withConsent = await insertReviewableRun(ownerA);
    const approvedWith = await request(
      `/venom/build-runs/${withConsent.run.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ revisionId: withConsent.revision2.id }),
      },
    );
    assertStatus(approvedWith, 200);
    const rowsWith = await db
      .select()
      .from(venomTemplateEditSignalsTable)
      .where(
        and(
          eq(venomTemplateEditSignalsTable.tenantId, ownerA),
          eq(venomTemplateEditSignalsTable.templateId, template.id),
        ),
      );
    assert.ok(rowsWith.length > 0, "opted-in approval wrote no signals");
    for (const row of rowsWith) {
      assert.ok(
        TEMPLATE_EDIT_SIGNAL_VOCABULARY[row.signalKey],
        `stored non-vocabulary key: ${row.signalKey}`,
      );
      assert.ok(!row.signalKey.includes("xyzzy"), "raw text reached storage");
    }
    const storedKeys = rowsWith.map((row) => row.signalKey).sort();
    assert.ok(storedKeys.includes("scope_expanded"));
    assert.ok(storedKeys.includes("theme_simplify"));

    // 3) One tenant is below the distinct-tenant floor: nothing surfaces.
    assert.equal(await countTemplateGuidance(template.id), 0);
    assert.deepEqual(await getTemplateGuidance(template.id), []);
    const detailBelow = await request(
      `/venom/build-templates/${template.id}`,
    );
    assertStatus(detailBelow, 200);
    assert.equal(detailBelow.body.networkImprovementCount, 0);

    // 4) The same signal from three distinct tenants crosses the floor.
    const sharedKeys = storedKeys.slice(0, 2);
    for (const owner of [ownerB, ownerC]) {
      await setMasterContribution({
        tenant: userTenant(owner),
        enabled: true,
        updatedByUserId: owner,
      });
      const wrote = await contributeTemplateEditSignals({
        tenant: userTenant(owner),
        templateId: template.id,
        signalKeys: sharedKeys,
      });
      assert.equal(wrote, true);
    }
    const guidance = await getTemplateGuidance(template.id);
    assert.deepEqual(
      guidance.map((entry) => entry.key).sort(),
      [...sharedKeys].sort(),
      "exactly the three-tenant keys surface",
    );
    for (const entry of guidance) {
      assert.equal(
        entry.guidance,
        TEMPLATE_EDIT_SIGNAL_VOCABULARY[entry.key]?.guidance,
        "guidance text must be the compiled vocabulary copy",
      );
      assert.ok(!entry.guidance.includes("xyzzy"));
      assert.ok(entry.tenantCount >= 3);
    }
    // Keys only tenant A filed stay unsurfaced everywhere.
    const aggregateRows = await db
      .select()
      .from(venomTemplateGuidanceTable)
      .where(eq(venomTemplateGuidanceTable.templateId, template.id));
    for (const row of aggregateRows) {
      assert.ok(
        sharedKeys.includes(row.signalKey),
        `below-threshold key surfaced: ${row.signalKey}`,
      );
    }
    const detailAbove = await request(
      `/venom/build-templates/${template.id}`,
    );
    assertStatus(detailAbove, 200);
    assert.equal(detailAbove.body.networkImprovementCount, sharedKeys.length);

    // 5) An opt-out removes that tenant's signals and recomputes aggregates.
    await setMasterContribution({
      tenant: userTenant(ownerB),
      enabled: false,
      updatedByUserId: ownerB,
    });
    const rowsAfterOptOut = await db
      .select()
      .from(venomTemplateEditSignalsTable)
      .where(eq(venomTemplateEditSignalsTable.tenantId, ownerB));
    assert.equal(rowsAfterOptOut.length, 0, "opt-out left signal rows behind");
    assert.equal(await countTemplateGuidance(template.id), 0);
    const detailAfterOptOut = await request(
      `/venom/build-templates/${template.id}`,
    );
    assertStatus(detailAfterOptOut, 200);
    assert.equal(detailAfterOptOut.body.networkImprovementCount, 0);

    // 6) Contributions for an opted-out tenant refuse to write.
    const refused = await contributeTemplateEditSignals({
      tenant: userTenant(ownerB),
      templateId: template.id,
      signalKeys: sharedKeys,
    });
    assert.equal(refused, false);
  } finally {
    restoreRunsAuth();
    restoreTemplatesAuth();
    restoreScheduler();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db
      .delete(venomTemplateEditSignalsTable)
      .where(inArray(venomTemplateEditSignalsTable.tenantId, owners));
    if (templateId) {
      await db
        .delete(venomTemplateGuidanceTable)
        .where(eq(venomTemplateGuidanceTable.templateId, templateId));
    }
    await db
      .delete(venomMasterContributionSettingsTable)
      .where(inArray(venomMasterContributionSettingsTable.tenantId, owners));
    const runs = await db
      .select({ id: venomBuildRunsTable.id })
      .from(venomBuildRunsTable)
      .where(inArray(venomBuildRunsTable.clerkUserId, owners));
    const runIds = runs.map((run) => run.id);
    if (runIds.length > 0) {
      await db
        .delete(venomBuildRunEventsTable)
        .where(inArray(venomBuildRunEventsTable.runId, runIds));
      await db
        .delete(venomBuildPackageRevisionsTable)
        .where(inArray(venomBuildPackageRevisionsTable.runId, runIds));
      await db
        .delete(venomBuildRunsTable)
        .where(inArray(venomBuildRunsTable.id, runIds));
    }
    if (templateId) {
      await db
        .delete(venomBuildTemplatesTable)
        .where(eq(venomBuildTemplatesTable.id, templateId));
    }
  }
});

test("generation injects bounded above-threshold guidance observably", async () => {
  const suffix = randomUUID();
  const ownerD = `template-learn-d-${suffix}`;
  const ownerE = `template-learn-e-${suffix}`;
  const ownerF = `template-learn-f-${suffix}`;
  const owners = [ownerD, ownerE, ownerF];
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(() => {});
  const capturedInputs: any[] = [];
  const restoreGenerator = overrideVenomBuildRunGeneratorForTests(
    async (input) => {
      capturedInputs.push(input);
      return basePackage("Generated by stub") as any;
    },
  );
  const templateIds: string[] = [];
  try {
    const aboveTemplate = await insertTemplate(suffix, "learn-above");
    const belowTemplate = await insertTemplate(suffix, "learn-below");
    templateIds.push(aboveTemplate.id, belowTemplate.id);

    for (const owner of owners) {
      await setMasterContribution({
        tenant: userTenant(owner),
        enabled: true,
        updatedByUserId: owner,
      });
      await contributeTemplateEditSignals({
        tenant: userTenant(owner),
        templateId: aboveTemplate.id,
        signalKeys: ["scope_trimmed", "theme_simplify"],
      });
    }
    // The below-threshold template gets the same signal from only 2 tenants.
    for (const owner of [ownerD, ownerE]) {
      await contributeTemplateEditSignals({
        tenant: userTenant(owner),
        templateId: belowTemplate.id,
        signalKeys: ["scope_trimmed"],
      });
    }

    async function insertQueuedRun(owner: string, templateIdFor: string) {
      const [run] = await db
        .insert(venomBuildRunsTable)
        .values({
          clerkUserId: owner,
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          targetType: "website",
          targetName: "Learning target",
          requirements: "Build the site.",
          constraints: "",
          brandDirection: "",
          sopRevisionIds: [],
          templateId: templateIdFor,
          status: "queued",
          progress: 0,
          currentRevisionNumber: 0,
        })
        .returning();
      return run;
    }

    // Above threshold: guidance is injected, bounded, and event-recorded.
    const aboveRun = await insertQueuedRun(ownerD, aboveTemplate.id);
    await processVenomBuildRunForTests(ownerD, aboveRun.id);
    const aboveInput = capturedInputs.at(-1);
    assert.ok(aboveInput?.templateContext, "template context missing");
    assert.deepEqual(aboveInput.templateContext.networkGuidance, [
      TEMPLATE_EDIT_SIGNAL_VOCABULARY.scope_trimmed?.guidance,
      TEMPLATE_EDIT_SIGNAL_VOCABULARY.theme_simplify?.guidance,
    ]);
    const aboveEvents = await db
      .select()
      .from(venomBuildRunEventsTable)
      .where(eq(venomBuildRunEventsTable.runId, aboveRun.id));
    const guidanceEvents = aboveEvents.filter(
      (event) => event.eventType === "network_guidance",
    );
    assert.equal(guidanceEvents.length, 1, "expected one observability event");
    assert.ok(guidanceEvents[0].message.includes("Scope trimmed"));
    assert.ok(guidanceEvents[0].message.includes("Simplification requests"));
    assert.ok(guidanceEvents[0].message.length <= 240);
    // The run payload surfaces the event to clients (review note derives
    // from it), and the run proceeded to review normally.
    const [aboveRunAfter] = await db
      .select()
      .from(venomBuildRunsTable)
      .where(eq(venomBuildRunsTable.id, aboveRun.id));
    assert.equal(aboveRunAfter.status, "review_required");

    // Below threshold: no influence, no event — verifiably unsurfaced.
    const belowRun = await insertQueuedRun(ownerD, belowTemplate.id);
    await processVenomBuildRunForTests(ownerD, belowRun.id);
    const belowInput = capturedInputs.at(-1);
    assert.deepEqual(belowInput.templateContext.networkGuidance, []);
    const belowEvents = await db
      .select()
      .from(venomBuildRunEventsTable)
      .where(eq(venomBuildRunEventsTable.runId, belowRun.id));
    assert.equal(
      belowEvents.filter((event) => event.eventType === "network_guidance")
        .length,
      0,
    );

    // Injection stays bounded even when many lessons cross the floor.
    const manyKeys = [
      "scope_trimmed",
      "theme_simplify",
      "brand_reworked",
      "content_expanded",
      "data_expanded",
      "acceptance_expanded",
      "constraints_trimmed",
      "theme_pricing_payments",
      "theme_integrations",
      "theme_onboarding",
    ];
    for (const owner of owners) {
      await contributeTemplateEditSignals({
        tenant: userTenant(owner),
        templateId: aboveTemplate.id,
        signalKeys: manyKeys,
      });
    }
    assert.equal(await countTemplateGuidance(aboveTemplate.id), manyKeys.length);
    const bounded = await getTemplateGuidance(aboveTemplate.id);
    assert.equal(
      bounded.length,
      TEMPLATE_LEARNING_BOUNDS.guidancePerTemplate,
      "guidance injection must stay bounded",
    );
    const boundedRun = await insertQueuedRun(ownerD, aboveTemplate.id);
    await processVenomBuildRunForTests(ownerD, boundedRun.id);
    const boundedInput = capturedInputs.at(-1);
    assert.equal(
      boundedInput.templateContext.networkGuidance.length,
      TEMPLATE_LEARNING_BOUNDS.guidancePerTemplate,
    );
  } finally {
    restoreGenerator();
    restoreScheduler();
    await db
      .delete(venomTemplateEditSignalsTable)
      .where(inArray(venomTemplateEditSignalsTable.tenantId, owners));
    if (templateIds.length > 0) {
      await db
        .delete(venomTemplateGuidanceTable)
        .where(inArray(venomTemplateGuidanceTable.templateId, templateIds));
    }
    await db
      .delete(venomMasterContributionSettingsTable)
      .where(inArray(venomMasterContributionSettingsTable.tenantId, owners));
    const runs = await db
      .select({ id: venomBuildRunsTable.id })
      .from(venomBuildRunsTable)
      .where(inArray(venomBuildRunsTable.clerkUserId, owners));
    const runIds = runs.map((run) => run.id);
    if (runIds.length > 0) {
      await db
        .delete(venomBuildRunEventsTable)
        .where(inArray(venomBuildRunEventsTable.runId, runIds));
      await db
        .delete(venomBuildPackageRevisionsTable)
        .where(inArray(venomBuildPackageRevisionsTable.runId, runIds));
      await db
        .delete(venomBuildRunsTable)
        .where(inArray(venomBuildRunsTable.id, runIds));
    }
    if (templateIds.length > 0) {
      await db
        .delete(venomBuildTemplatesTable)
        .where(inArray(venomBuildTemplatesTable.id, templateIds));
    }
  }
});
