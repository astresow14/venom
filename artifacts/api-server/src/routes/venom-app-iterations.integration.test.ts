import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomBuildPackageRevisionsTable,
  venomBuildRunsTable,
  venomCandidateReleasesTable,
  venomOntologyConceptsTable,
  venomPortfolioAppIterationsTable,
  venomPortfolioAppsTable,
  venomPortfolioSourceVersionsTable,
  venomProvisioningRunsTable,
  venomSopRevisionsTable,
  venomSopsTable,
  venomWorkspacesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import portfolioRouter, {
  overrideVenomAppPortfolioUserIdResolverForTests,
} from "./venom-app-portfolio.js";
import buildRunsRouter, {
  overrideVenomBuildRunSchedulerForTests,
  overrideVenomBuildRunUserIdResolverForTests,
  processVenomBuildRunForTests,
} from "./venom-build-runs.js";

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

function testPackage(
  title: string,
  sopReferences: {
    sopId: string;
    revisionId: string;
    revisionNumber: number;
    title: string;
    checksumSha256: string;
  }[] = [],
) {
  return {
    formatVersion: 1 as const,
    targetType: "website" as const,
    title,
    productBrief: {
      summary: "A reviewed product package.",
      audience: ["Owners"],
      outcomes: ["A working product"],
    },
    functionalScope: ["Serve the core flow"],
    brandDirection: ["Monochrome", "Quiet confidence"],
    contentRequirements: [],
    serviceFlowRequirements: [],
    sourceReferences: [],
    sopReferences,
    dataNeeds: [],
    integrationNeeds: [],
    permissionRequests: [],
    acceptanceChecks: ["Core flow works end to end"],
    launchConstraints: [
      "Human approval is required before any provisioning or external action.",
    ],
  };
}

const SOP_CONTENT = {
  purpose: "Keep launches reviewable.",
  prerequisites: [],
  inputs: [],
  guidance: ["Review everything before shipping."],
  requiredApprovals: ["Owner approval"],
  acceptanceChecks: ["Review recorded"],
};

test("app iteration loop: linking, baselines, signals, and approvals", async () => {
  const suffix = randomUUID();
  const ownerA = `app-iter-a-${suffix}`;
  const ownerB = `app-iter-b-${suffix}`;
  const projectId = `proj-${suffix}`;
  const otherProjectId = `proj-other-${suffix}`;
  let activeUserId = ownerA;
  const restorePortfolioAuth = overrideVenomAppPortfolioUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreBuildAuth = overrideVenomBuildRunUserIdResolverForTests(
    () => activeUserId,
  );
  const scheduled: string[] = [];
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(
    (_userId, runId) => scheduled.push(runId),
  );
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as typeof request.log;
    next();
  });
  app.use(portfolioRouter);
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
      headers: { "content-type": "application/json", ...options.headers },
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

  try {
    // Workspace blob for owner A: two projects, one connected source whose
    // sync time is old (before any iteration exists).
    const oldSync = new Date("2026-01-05T00:00:00.000Z").toISOString();
    await db.insert(venomWorkspacesTable).values({
      clerkUserId: ownerA,
      state: {
        projects: [
          { id: projectId, name: "Atlas Research" },
          { id: otherProjectId, name: "Beacon Ops" },
        ],
        sources: [
          { projectId, name: "Atlas Notion", syncedAt: oldSync },
        ],
      },
    });

    const [portfolioApp] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: ownerA,
        name: "Field Guide",
        purpose: "Publishes curated research",
        brand: "Monochrome",
      })
      .returning();

    // --- Step 1: linking is validated, editable, removable, isolated ---
    const badLink = await request(`/venom/apps/${portfolioApp.id}`, {
      method: "PATCH",
      body: JSON.stringify({ linkedProjectId: "nonexistent-project" }),
    });
    assertStatus(badLink, 400);

    const linked = await request(`/venom/apps/${portfolioApp.id}`, {
      method: "PATCH",
      body: JSON.stringify({ linkedProjectId: projectId }),
    });
    assertStatus(linked, 200);
    assert.equal(linked.body.linkedProjectId, projectId);
    assert.equal(linked.body.linkedProjectName, "Atlas Research");
    assert.equal(linked.body.latestIterationNumber, 0);
    assert.equal(linked.body.improvementSignal, null);

    activeUserId = ownerB;
    assertStatus(await request(`/venom/apps/${portfolioApp.id}`), 404);
    assertStatus(
      await request(`/venom/apps/${portfolioApp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Hijacked" }),
      }),
      404,
    );
    assertStatus(
      await request(`/venom/apps/${portfolioApp.id}/iteration-context`),
      404,
    );
    assertStatus(
      await request(
        `/venom/apps/${portfolioApp.id}/improvement-suggestion/dismiss`,
        { method: "POST", body: "{}" },
      ),
      404,
    );
    activeUserId = ownerA;

    // --- Step 2: no baseline yet -> context blocked, POST rejected ---
    const noBaselineContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(noBaselineContext, 200);
    assert.equal(noBaselineContext.body.canIterate, false);
    assert.equal(noBaselineContext.body.blockedReason, "no_baseline");
    assert.equal(noBaselineContext.body.baseline, null);
    assert.equal(noBaselineContext.body.linkedProject.id, projectId);

    const prematureIteration = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Improve onboarding",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
        }),
      },
    );
    assertStatus(prematureIteration, 409);

    // --- Step 3: approving an app-pinned run registers iteration v1 ---
    // SOP with two revisions: the package pins revision 1, revision 2 is the
    // active one that iteration-context should suggest instead.
    const [sop] = await db
      .insert(venomSopsTable)
      .values({
        clerkUserId: ownerA,
        title: "Launch review",
        lifecycle: "active",
        category: "operations",
        provenance: "manual",
        content: SOP_CONTENT,
      })
      .returning();
    const [sopRev1] = await db
      .insert(venomSopRevisionsTable)
      .values({
        sopId: sop.id,
        clerkUserId: ownerA,
        versionNumber: 1,
        title: "Launch review",
        category: "operations",
        provenance: "manual",
        content: SOP_CONTENT,
        checksumSha256: "d".repeat(64),
      })
      .returning();
    const [sopRev2] = await db
      .insert(venomSopRevisionsTable)
      .values({
        sopId: sop.id,
        clerkUserId: ownerA,
        versionNumber: 2,
        title: "Launch review v2",
        category: "operations",
        provenance: "manual",
        content: SOP_CONTENT,
        checksumSha256: "e".repeat(64),
      })
      .returning();
    await db
      .update(venomSopsTable)
      .set({ activeRevisionId: sopRev2.id, activeRevisionNumber: 2 })
      .where(eq(venomSopsTable.id, sop.id));

    const [firstRun] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: ownerA,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        appId: portfolioApp.id,
        targetType: "website",
        targetName: "Field Guide",
        requirements: "Build the first version.",
        constraints: "",
        brandDirection: "Monochrome",
        sopRevisionIds: [sopRev1.id],
        status: "review_required",
        progress: 100,
        currentRevisionNumber: 1,
      })
      .returning();
    const [firstRevision] = await db
      .insert(venomBuildPackageRevisionsTable)
      .values({
        runId: firstRun.id,
        clerkUserId: ownerA,
        revisionNumber: 1,
        reason: "Initial generated package",
        package: testPackage("Field Guide v1", [
          {
            sopId: sop.id,
            revisionId: sopRev1.id,
            revisionNumber: 1,
            title: "Launch review",
            checksumSha256: "d".repeat(64),
          },
        ]),
        checksumSha256: "1".repeat(64),
      })
      .returning();
    const approvedFirst = await request(
      `/venom/build-runs/${firstRun.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ revisionId: firstRevision.id }),
      },
    );
    assertStatus(approvedFirst, 200);
    assert.equal(approvedFirst.body.status, "ready_for_provisioning");

    const afterFirstApproval = await request(
      `/venom/apps/${portfolioApp.id}`,
    );
    assertStatus(afterFirstApproval, 200);
    assert.equal(afterFirstApproval.body.app.latestIterationNumber, 1);
    assert.equal(afterFirstApproval.body.iterations.length, 1);
    assert.equal(afterFirstApproval.body.iterations[0].iterationNumber, 1);
    assert.equal(afterFirstApproval.body.iterations[0].runKind, "standard");
    assert.equal(
      afterFirstApproval.body.iterations[0].packageTitle,
      "Field Guide v1",
    );
    assert.match(
      afterFirstApproval.body.iterations[0].reason,
      /Approved build package/,
    );
    const timelineKinds = afterFirstApproval.body.timeline.map(
      (entry: { kind: string }) => entry.kind,
    );
    assert.ok(timelineKinds.includes("package_iteration"));

    // A source version so iteration-context can report the latest archive.
    const [sourceVersion] = await db
      .insert(venomPortfolioSourceVersionsTable)
      .values({
        appId: portfolioApp.id,
        clerkUserId: ownerA,
        versionNumber: 1,
        sourceType: "zip",
        packageObjectPath: `test/${suffix}-iter.zip`,
        archiveFilename: "field-guide.zip",
        archiveBytes: 512,
        checksumSha256: "f".repeat(64),
        manifest: {
          formatVersion: 1,
          rootKind: "single-project",
          totalEntries: 1,
          safeFileCount: 3,
          excludedSensitiveFileCount: 0,
          files: ["package.json"],
          projectFiles: ["package.json"],
          detectedStack: ["TypeScript"],
        },
      })
      .returning();
    await db
      .update(venomPortfolioAppsTable)
      .set({ currentSourceVersion: 1 })
      .where(eq(venomPortfolioAppsTable.id, portfolioApp.id));

    // --- Step 4: meaningful knowledge changes surface a signal ---
    // Concept updates land after the baseline approval but before the
    // dismissal below, so dismissing genuinely hides them.
    const afterBaseline = Date.now();
    await db.insert(venomOntologyConceptsTable).values(
      [0, 1, 2].map((index) => ({
        ownerType: "user",
        ownerId: ownerA,
        conceptId: `concept-${suffix}-${index}`,
        projectId,
        label: `Fresh finding ${index}`,
        normalizedLabel: `fresh finding ${index}`,
        category: "insight",
        summary: "New knowledge captured after the baseline.",
        strength: 0.8,
        mentionCount: 2,
        x: 0,
        y: 0,
        lastUpdatedAt: afterBaseline,
      })),
    );

    const withSignal = await request("/venom/apps");
    assertStatus(withSignal, 200);
    const signalApp = withSignal.body.find(
      (item: { id: string }) => item.id === portfolioApp.id,
    );
    assert.ok(signalApp.improvementSignal);
    assert.equal(signalApp.improvementSignal.knowledgeChanges, 3);
    assert.equal(signalApp.improvementSignal.baselineIterationNumber, 1);
    assert.match(signalApp.improvementSignal.summary, /Atlas Research/);

    // Dismissing hides the current suggestion...
    const dismissed = await request(
      `/venom/apps/${portfolioApp.id}/improvement-suggestion/dismiss`,
      { method: "POST", body: "{}" },
    );
    assertStatus(dismissed, 200);
    assert.equal(dismissed.body.improvementSignal, null);

    // ...until genuinely newer data arrives (a fresh source sync).
    const resync = new Date(Date.now() + 120_000).toISOString();
    await db
      .update(venomWorkspacesTable)
      .set({
        state: {
          projects: [
            { id: projectId, name: "Atlas Research" },
            { id: otherProjectId, name: "Beacon Ops" },
          ],
          sources: [
            { projectId, name: "Atlas Notion", syncedAt: resync },
          ],
        },
      })
      .where(eq(venomWorkspacesTable.clerkUserId, ownerA));
    const resurfaced = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(resurfaced, 200);
    assert.ok(resurfaced.body.app.improvementSignal);
    assert.equal(resurfaced.body.app.improvementSignal.sourceChanges, 1);
    assert.match(
      resurfaced.body.app.improvementSignal.summary,
      /Atlas Notion/,
    );

    // --- Step 5: iteration-context is fully seeded ---
    const context = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(context, 200);
    assert.equal(context.body.canIterate, true);
    assert.equal(context.body.blockedReason, null);
    assert.equal(context.body.baseline.iterationNumber, 1);
    assert.equal(context.body.baseline.resolvable, true);
    assert.equal(context.body.baseline.packageTitle, "Field Guide v1");
    assert.equal(context.body.latestSourceVersion.id, sourceVersion.id);
    assert.equal(context.body.latestSourceVersion.versionNumber, 1);
    assert.equal(context.body.suggestedSops.length, 1);
    assert.equal(context.body.suggestedSops[0].revisionId, sopRev2.id);
    assert.equal(context.body.suggestedSops[0].revisionNumber, 2);
    assert.ok(context.body.changes);
    assert.match(context.body.changes.summary, /Atlas Research/);

    // --- Step 6: starting an iteration creates a pinned, queued run ---
    const iterationKey = randomUUID().replaceAll("-", "_");
    const iterationStarted = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Highlight the newest findings on the landing page.",
          idempotencyKey: iterationKey,
        }),
      },
    );
    assertStatus(iterationStarted, 201);
    assert.equal(iterationStarted.body.status, "queued");
    assert.equal(iterationStarted.body.runKind, "app_iteration");
    assert.equal(iterationStarted.body.request.appId, portfolioApp.id);
    assert.equal(
      iterationStarted.body.request.sourceVersionId,
      sourceVersion.id,
    );
    assert.deepEqual(iterationStarted.body.request.sopRevisionIds, [
      sopRev2.id,
    ]);
    assert.equal(
      iterationStarted.body.request.baselineRevisionId,
      firstRevision.id,
    );
    assert.match(
      iterationStarted.body.request.changesSummary,
      /Atlas Research/,
    );
    assert.equal(iterationStarted.body.targetType, "website");
    assert.ok(scheduled.includes(iterationStarted.body.id));

    // Idempotent replay returns the same run.
    const replay = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Highlight the newest findings on the landing page.",
          idempotencyKey: iterationKey,
        }),
      },
    );
    assertStatus(replay, 201);
    assert.equal(replay.body.id, iterationStarted.body.id);

    // The run is queued, not approved: no approval bypass.
    const queuedRun = await request(
      `/venom/build-runs/${iterationStarted.body.id}`,
    );
    assertStatus(queuedRun, 200);
    assert.equal(queuedRun.body.status, "queued");
    assert.equal(queuedRun.body.approvedRevisionId, null);

    // Once a baseline exists, a generic standard run can no longer target the
    // app — the next version must be an iteration pinned to that baseline.
    const bypassAttempt = await request(`/venom/build-runs`, {
      method: "POST",
      body: JSON.stringify({
        targetType: "website",
        targetName: "Field Guide",
        requirements: "Rebuild the site from scratch and ignore the baseline.",
        constraints: "",
        brandDirection: "",
        appId: portfolioApp.id,
        sourceVersionId: null,
        projectId: null,
        sopRevisionIds: [],
        idempotencyKey: randomUUID().replaceAll("-", "_"),
      }),
    });
    assertStatus(bypassAttempt, 409);
    assert.match(String(bypassAttempt.body.error), /improvement iteration/i);

    // --- Step 7: deleting the baseline fails clearly everywhere ---
    await db
      .delete(venomBuildPackageRevisionsTable)
      .where(eq(venomBuildPackageRevisionsTable.id, firstRevision.id));

    const unresolvableContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(unresolvableContext, 200);
    assert.equal(unresolvableContext.body.canIterate, false);
    assert.equal(
      unresolvableContext.body.blockedReason,
      "baseline_unresolvable",
    );
    assert.equal(unresolvableContext.body.baseline.resolvable, false);

    const blockedIteration = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Try again",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
        }),
      },
    );
    assertStatus(blockedIteration, 409);

    // Processing the already-queued iteration fails before generation with a
    // distinct failure code instead of silently starting fresh.
    await processVenomBuildRunForTests(ownerA, iterationStarted.body.id);
    const failedRun = await request(
      `/venom/build-runs/${iterationStarted.body.id}`,
    );
    assertStatus(failedRun, 200);
    assert.equal(failedRun.body.status, "failed");
    assert.equal(failedRun.body.failureCode, "baseline_unresolvable");
    assert.match(failedRun.body.failureMessage, /baseline package/i);

    // The failed run registered no iteration; the app still shows v1 only.
    const afterFailure = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(afterFailure, 200);
    assert.equal(afterFailure.body.app.latestIterationNumber, 1);
    assert.equal(afterFailure.body.iterations.length, 1);

    // --- Step 8: unlinking clears the knowledge context ---
    const unlinked = await request(`/venom/apps/${portfolioApp.id}`, {
      method: "PATCH",
      body: JSON.stringify({ linkedProjectId: null }),
    });
    assertStatus(unlinked, 200);
    assert.equal(unlinked.body.linkedProjectId, null);
    assert.equal(unlinked.body.linkedProjectName, null);
    assert.equal(unlinked.body.improvementSignal, null);

    const unlinkedContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(unlinkedContext, 200);
    assert.equal(unlinkedContext.body.linkedProject, null);
    assert.equal(unlinkedContext.body.changes, null);

    // --- Step 9: history beyond the embedded cap stays fully reachable ---
    // 449 extra imports push the timeline (1 version + 1 iteration already
    // exist) past the 400-entry embedded view.
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await db.insert(venomPortfolioSourceVersionsTable).values(
      Array.from({ length: 449 }, (_, i) => ({
        appId: portfolioApp.id,
        clerkUserId: ownerA,
        versionNumber: i + 2,
        sourceType: "zip" as const,
        packageObjectPath: `test/${suffix}-bulk-${i + 2}.zip`,
        archiveFilename: `field-guide-v${i + 2}.zip`,
        archiveBytes: 128,
        checksumSha256: "a".repeat(64),
        manifest: {
          formatVersion: 1 as const,
          rootKind: "single-project" as const,
          totalEntries: 1,
          safeFileCount: 1,
          excludedSensitiveFileCount: 0,
          files: ["package.json"],
          projectFiles: ["package.json"],
          detectedStack: ["TypeScript"],
        },
        createdAt: new Date(base + (i + 2) * 1000),
      })),
    );

    const cappedDetail = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(cappedDetail, 200);
    assert.equal(cappedDetail.body.timeline.length, 400);
    assert.equal(cappedDetail.body.timelineTotal, 451);
    assert.equal(cappedDetail.body.timelineTruncated, true);

    // Paging retrieves every entry the embedded view could not show.
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let reportedTotal = 0;
    do {
      const pageQuery: string = cursor
        ? `?limit=200&cursor=${encodeURIComponent(cursor)}`
        : "?limit=200";
      const page = await request(
        `/venom/apps/${portfolioApp.id}/timeline${pageQuery}`,
      );
      assertStatus(page, 200);
      reportedTotal = page.body.total;
      for (const entry of page.body.entries) {
        assert.ok(!seenIds.has(entry.id), `duplicate entry ${entry.id}`);
        seenIds.add(entry.id);
      }
      if (pages === 0) {
        // Newest-first: the first page opens with the embedded view's head.
        assert.equal(page.body.entries[0].id, cappedDetail.body.timeline[0].id);
        assert.equal(page.body.entries.length, 200);
      }
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(reportedTotal, 451);
    assert.equal(seenIds.size, 451);

    // Malformed cursors are rejected — missing delimiter, delimited but
    // non-ISO timestamp, non-canonical timestamp encoding, and an empty id
    // half — rather than being lexically seeked into a 200 page.
    const badCursor = await request(
      `/venom/apps/${portfolioApp.id}/timeline?cursor=garbage`,
    );
    assertStatus(badCursor, 400);
    const delimitedGarbage = await request(
      `/venom/apps/${portfolioApp.id}/timeline?cursor=garbage~foo`,
    );
    assertStatus(delimitedGarbage, 400);
    const impossibleDate = await request(
      `/venom/apps/${portfolioApp.id}/timeline?cursor=2026-99-99T00%3A00%3A00.000Z~x`,
    );
    assertStatus(impossibleDate, 400);
    const nonCanonicalDate = await request(
      `/venom/apps/${portfolioApp.id}/timeline?cursor=2026-01-01~x`,
    );
    assertStatus(nonCanonicalDate, 400);
    const emptyIdHalf = await request(
      `/venom/apps/${portfolioApp.id}/timeline?cursor=2026-01-01T00%3A00%3A00.000Z~`,
    );
    assertStatus(emptyIdHalf, 400);
    // A canonical cursor with an unknown id is a valid seek position, not an
    // error: it lands on the first entry strictly after that position.
    const unknownIdCursor = await request(
      `/venom/apps/${portfolioApp.id}/timeline?cursor=2026-01-01T00%3A00%3A00.000Z~not-a-real-entry`,
    );
    assertStatus(unknownIdCursor, 200);
    activeUserId = ownerB;
    const foreignTimeline = await request(
      `/venom/apps/${portfolioApp.id}/timeline`,
    );
    assertStatus(foreignTimeline, 404);
    activeUserId = ownerA;
  } finally {
    server.close();
    restorePortfolioAuth();
    restoreBuildAuth();
    restoreScheduler();
    await db
      .delete(venomBuildRunsTable)
      .where(inArray(venomBuildRunsTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomPortfolioAppsTable)
      .where(inArray(venomPortfolioAppsTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomSopsTable)
      .where(inArray(venomSopsTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomWorkspacesTable)
      .where(inArray(venomWorkspacesTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomOntologyConceptsTable)
      .where(inArray(venomOntologyConceptsTable.ownerId, [ownerA, ownerB]));
  }
});

test("live release anchoring: divergence, baseline choice, and rollback visibility", async () => {
  const suffix = randomUUID();
  const owner = `app-live-${suffix}`;
  let activeUserId = owner;
  const restorePortfolioAuth = overrideVenomAppPortfolioUserIdResolverForTests(
    () => activeUserId,
  );
  const restoreBuildAuth = overrideVenomBuildRunUserIdResolverForTests(
    () => activeUserId,
  );
  const scheduled: string[] = [];
  const restoreScheduler = overrideVenomBuildRunSchedulerForTests(
    (_userId, runId) => scheduled.push(runId),
  );
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as unknown as typeof request.log;
    next();
  });
  app.use(portfolioRouter);
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
      headers: { "content-type": "application/json", ...options.headers },
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

  try {
    // An app with two approved package versions, registered directly the way
    // approval does. No linked project: divergence must not depend on it.
    const [portfolioApp] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: owner,
        name: "Anchor App",
        purpose: "Proves live-release anchoring",
        brand: "Monochrome",
      })
      .returning();
    const [runOne] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: owner,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        appId: portfolioApp.id,
        targetType: "website",
        targetName: "Anchor App",
        requirements: "Build v1.",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "complete",
        progress: 100,
        currentRevisionNumber: 1,
      })
      .returning();
    const [revOne] = await db
      .insert(venomBuildPackageRevisionsTable)
      .values({
        runId: runOne.id,
        clerkUserId: owner,
        revisionNumber: 1,
        reason: "Initial package",
        package: testPackage("Anchor v1"),
        checksumSha256: "1".repeat(64),
      })
      .returning();
    const [runTwo] = await db
      .insert(venomBuildRunsTable)
      .values({
        clerkUserId: owner,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        appId: portfolioApp.id,
        targetType: "website",
        targetName: "Anchor App",
        requirements: "Build v2.",
        constraints: "",
        brandDirection: "",
        sopRevisionIds: [],
        status: "complete",
        progress: 100,
        currentRevisionNumber: 1,
      })
      .returning();
    const [revTwo] = await db
      .insert(venomBuildPackageRevisionsTable)
      .values({
        runId: runTwo.id,
        clerkUserId: owner,
        revisionNumber: 1,
        reason: "Improved package",
        package: testPackage("Anchor v2"),
        checksumSha256: "2".repeat(64),
      })
      .returning();
    const [iterOne] = await db
      .insert(venomPortfolioAppIterationsTable)
      .values({
        appId: portfolioApp.id,
        clerkUserId: owner,
        iterationNumber: 1,
        buildRunId: runOne.id,
        revisionId: revOne.id,
        packageTitle: "Anchor v1",
        packageChecksum: "1".repeat(64),
        runKind: "standard",
        reason: "Approved build package",
        createdBy: owner,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      })
      .returning();
    const [iterTwo] = await db
      .insert(venomPortfolioAppIterationsTable)
      .values({
        appId: portfolioApp.id,
        clerkUserId: owner,
        iterationNumber: 2,
        buildRunId: runTwo.id,
        revisionId: revTwo.id,
        packageTitle: "Anchor v2",
        packageChecksum: "2".repeat(64),
        runKind: "app_iteration",
        reason: "Owner-requested improvement",
        createdBy: owner,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      })
      .returning();

    // Provisioning history: v1's release published an hour ago; v2 approved
    // but never published. The app is serving v1 — live lags approved.
    const [provRun] = await db
      .insert(venomProvisioningRunsTable)
      .values({
        clerkUserId: owner,
        buildRunId: runOne.id,
        approvedRevisionId: revOne.id,
        appId: portfolioApp.id,
        idempotencyKey: randomUUID().replaceAll("-", "_"),
        targetName: "Anchor App",
        status: "published",
        progress: 100,
      })
      .returning();
    const publishedAtV1 = new Date(Date.now() - 60 * 60 * 1000);
    const [releaseOne] = await db
      .insert(venomCandidateReleasesTable)
      .values({
        clerkUserId: owner,
        provisioningRunId: provRun.id,
        buildRunId: runOne.id,
        approvedRevisionId: revOne.id,
        appId: portfolioApp.id,
        targetName: "Anchor App",
        providerCandidateId: "cand-anchor-1",
        launchUrl: "https://example.com/anchor",
        status: "published",
        publishedAt: publishedAtV1,
      })
      .returning();
    await db
      .update(venomPortfolioAppIterationsTable)
      .set({ releaseId: releaseOne.id })
      .where(eq(venomPortfolioAppIterationsTable.id, iterOne.id));
    await db
      .update(venomPortfolioAppsTable)
      .set({ liveReleaseId: releaseOne.id })
      .where(eq(venomPortfolioAppsTable.id, portfolioApp.id));

    // --- App payloads surface the live pointer ---
    const list = await request("/venom/apps");
    assertStatus(list, 200);
    const listed = list.body.find(
      (item: { id: string }) => item.id === portfolioApp.id,
    );
    assert.equal(listed.liveReleaseId, releaseOne.id);
    assert.equal(listed.liveIterationNumber, 1);
    assert.equal(listed.livePublishedAt, publishedAtV1.toISOString());

    const detail = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(detail, 200);
    assert.equal(detail.body.app.liveReleaseId, releaseOne.id);
    assert.equal(detail.body.app.liveIterationNumber, 1);
    assert.equal(detail.body.app.livePublishedAt, publishedAtV1.toISOString());
    const iterationsById = new Map<string, any>(
      detail.body.iterations.map((item: { id: string }) => [item.id, item]),
    );
    assert.equal(iterationsById.get(iterOne.id)!.releaseId, releaseOne.id);
    assert.equal(iterationsById.get(iterOne.id)!.isLive, true);
    assert.equal(iterationsById.get(iterTwo.id)!.releaseId, null);
    assert.equal(iterationsById.get(iterTwo.id)!.isLive, false);
    const publishedEntry = detail.body.timeline.find(
      (entry: { id: string }) =>
        entry.id === `release_published:${releaseOne.id}`,
    );
    assert.ok(publishedEntry);
    assert.equal(publishedEntry.title, "Release published — package v1 live");
    assert.equal(publishedEntry.iterationNumber, 1);
    const createdEntry = detail.body.timeline.find(
      (entry: { id: string }) =>
        entry.id === `release_created:${releaseOne.id}`,
    );
    assert.ok(createdEntry);
    assert.equal(
      createdEntry.title,
      "Release candidate created from package v1",
    );

    // --- Context reports live_behind with a selectable live baseline ---
    const behindContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(behindContext, 200);
    assert.equal(behindContext.body.canIterate, true);
    assert.equal(behindContext.body.divergence, "live_behind");
    assert.equal(behindContext.body.baseline.iterationNumber, 2);
    assert.equal(behindContext.body.baseline.resolvable, true);
    assert.equal(behindContext.body.live.releaseId, releaseOne.id);
    assert.equal(behindContext.body.live.iterationId, iterOne.id);
    assert.equal(behindContext.body.live.iterationNumber, 1);
    assert.equal(behindContext.body.live.packageTitle, "Anchor v1");
    assert.equal(
      behindContext.body.live.publishedAt,
      publishedAtV1.toISOString(),
    );
    assert.equal(behindContext.body.live.restoredByRollback, false);
    assert.equal(behindContext.body.live.resolvable, true);
    assert.equal(behindContext.body.live.baselineSelectable, true);
    assert.equal(behindContext.body.live.changes, null);

    // --- POST honors a conscious live-version baseline ---
    const liveBaselineRun = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Improve from what is actually live.",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          baselineIterationId: iterOne.id,
        }),
      },
    );
    assertStatus(liveBaselineRun, 201);
    assert.equal(liveBaselineRun.body.runKind, "app_iteration");
    assert.equal(liveBaselineRun.body.request.baselineRevisionId, revOne.id);
    assert.ok(scheduled.includes(liveBaselineRun.body.id));
    const [liveBaselineRow] = await db
      .select()
      .from(venomBuildRunsTable)
      .where(eq(venomBuildRunsTable.id, liveBaselineRun.body.id));
    assert.equal(liveBaselineRow.baselineIterationId, iterOne.id);
    assert.equal(liveBaselineRow.baselineRevisionId, revOne.id);
    await db
      .update(venomBuildRunsTable)
      .set({ status: "cancelled" })
      .where(eq(venomBuildRunsTable.id, liveBaselineRun.body.id));

    // --- Arbitrary historical baselines stay rejected ---
    const arbitraryBaseline = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Use a random baseline.",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          baselineIterationId: randomUUID(),
        }),
      },
    );
    assertStatus(arbitraryBaseline, 409);
    assert.match(
      String(arbitraryBaseline.body.error),
      /newest approved package or the version that is live/,
    );

    // --- A rollback-restored release is visibly marked ---
    await db
      .update(venomCandidateReleasesTable)
      .set({ rolledBackAt: new Date() })
      .where(eq(venomCandidateReleasesTable.id, releaseOne.id));
    const restoredContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(restoredContext, 200);
    assert.equal(restoredContext.body.divergence, "live_behind");
    assert.equal(restoredContext.body.live.restoredByRollback, true);
    const rolledDetail = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(rolledDetail, 200);
    const rolledEntry = rolledDetail.body.timeline.find(
      (entry: { id: string }) =>
        entry.id === `release_rolled_back:${releaseOne.id}`,
    );
    assert.ok(rolledEntry);
    assert.equal(rolledEntry.title, "Rolled back — package v1 live again");
    assert.equal(rolledEntry.iterationNumber, 1);
    assert.match(String(rolledEntry.detail), /live pointer was reset/);

    // --- in_sync once the newest package is what's live ---
    const [releaseTwo] = await db
      .insert(venomCandidateReleasesTable)
      .values({
        clerkUserId: owner,
        provisioningRunId: provRun.id,
        buildRunId: runTwo.id,
        approvedRevisionId: revTwo.id,
        appId: portfolioApp.id,
        targetName: "Anchor App",
        providerCandidateId: "cand-anchor-2",
        launchUrl: "https://example.com/anchor",
        status: "published",
        publishedAt: new Date(),
      })
      .returning();
    await db
      .update(venomPortfolioAppIterationsTable)
      .set({ releaseId: releaseTwo.id })
      .where(eq(venomPortfolioAppIterationsTable.id, iterTwo.id));
    await db
      .update(venomPortfolioAppsTable)
      .set({ liveReleaseId: releaseTwo.id })
      .where(eq(venomPortfolioAppsTable.id, portfolioApp.id));
    const syncContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(syncContext, 200);
    assert.equal(syncContext.body.divergence, "in_sync");
    assert.equal(syncContext.body.live.iterationId, iterTwo.id);
    assert.equal(syncContext.body.live.iterationNumber, 2);
    assert.equal(syncContext.body.live.baselineSelectable, false);
    const syncDetail = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(syncDetail, 200);
    const syncIterations = new Map<string, any>(
      syncDetail.body.iterations.map((item: { id: string }) => [
        item.id,
        item,
      ]),
    );
    assert.equal(syncIterations.get(iterTwo.id)!.isLive, true);
    // The superseded iteration keeps naming the release it shipped as.
    assert.equal(syncIterations.get(iterOne.id)!.isLive, false);
    assert.equal(syncIterations.get(iterOne.id)!.releaseId, releaseOne.id);
    // Explicitly choosing the newest baseline is always accepted.
    const latestExplicit = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Iterate on the newest package.",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          baselineIterationId: iterTwo.id,
        }),
      },
    );
    assertStatus(latestExplicit, 201);
    assert.equal(latestExplicit.body.request.baselineRevisionId, revTwo.id);
    await db
      .update(venomBuildRunsTable)
      .set({ status: "cancelled" })
      .where(eq(venomBuildRunsTable.id, latestExplicit.body.id));

    // --- live_unversioned when the live release maps to no known package ---
    const [releaseThree] = await db
      .insert(venomCandidateReleasesTable)
      .values({
        clerkUserId: owner,
        provisioningRunId: provRun.id,
        buildRunId: randomUUID(),
        approvedRevisionId: randomUUID(),
        appId: portfolioApp.id,
        targetName: "Anchor App",
        providerCandidateId: "cand-anchor-3",
        launchUrl: "https://example.com/anchor",
        status: "published",
        publishedAt: new Date(),
      })
      .returning();
    await db
      .update(venomPortfolioAppsTable)
      .set({ liveReleaseId: releaseThree.id })
      .where(eq(venomPortfolioAppsTable.id, portfolioApp.id));
    const unversionedContext = await request(
      `/venom/apps/${portfolioApp.id}/iteration-context`,
    );
    assertStatus(unversionedContext, 200);
    assert.equal(unversionedContext.body.divergence, "live_unversioned");
    assert.equal(unversionedContext.body.live.releaseId, releaseThree.id);
    assert.equal(unversionedContext.body.live.iterationId, null);
    assert.equal(unversionedContext.body.live.iterationNumber, null);
    assert.equal(unversionedContext.body.live.packageTitle, null);
    assert.equal(unversionedContext.body.live.resolvable, false);
    assert.equal(unversionedContext.body.live.baselineSelectable, false);
    assert.equal(unversionedContext.body.canIterate, true);
    const unversionedDetail = await request(`/venom/apps/${portfolioApp.id}`);
    assertStatus(unversionedDetail, 200);
    assert.equal(unversionedDetail.body.app.liveReleaseId, releaseThree.id);
    assert.equal(unversionedDetail.body.app.liveIterationNumber, null);
    // The previously-live version is no longer a valid conscious baseline...
    const staleChoice = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Baseline on a version that is no longer live.",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
          baselineIterationId: iterOne.id,
        }),
      },
    );
    assertStatus(staleChoice, 409);
    // ...but the default newest-package path still works in the split state.
    const defaultRun = await request(
      `/venom/apps/${portfolioApp.id}/iterations`,
      {
        method: "POST",
        body: JSON.stringify({
          instruction: "Iterate normally despite the unversioned release.",
          idempotencyKey: randomUUID().replaceAll("-", "_"),
        }),
      },
    );
    assertStatus(defaultRun, 201);
    assert.equal(defaultRun.body.request.baselineRevisionId, revTwo.id);
  } finally {
    server.close();
    restorePortfolioAuth();
    restoreBuildAuth();
    restoreScheduler();
    await db
      .delete(venomCandidateReleasesTable)
      .where(eq(venomCandidateReleasesTable.clerkUserId, owner));
    await db
      .delete(venomProvisioningRunsTable)
      .where(eq(venomProvisioningRunsTable.clerkUserId, owner));
    await db
      .delete(venomBuildPackageRevisionsTable)
      .where(eq(venomBuildPackageRevisionsTable.clerkUserId, owner));
    await db
      .delete(venomBuildRunsTable)
      .where(eq(venomBuildRunsTable.clerkUserId, owner));
    await db
      .delete(venomPortfolioAppsTable)
      .where(eq(venomPortfolioAppsTable.clerkUserId, owner));
  }
});
