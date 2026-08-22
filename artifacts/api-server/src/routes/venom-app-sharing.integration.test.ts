/**
 * Integration tests for public app sharing.
 *
 * Covers:
 * - Owner-only management (401 unauthenticated, 404 non-owner, 400 invalid).
 * - Slug minting, stability across disable/enable, and URL/snippet shape.
 * - Public resolution across published / superseded / rolled-back /
 *   candidate-only / disabled / unknown / tampered launch-url states —
 *   every non-live outcome must be byte-identical ("unavailable").
 * - No-leak guarantees on public payloads (exact key sets + substring sweep
 *   for owner ids, row ids, and provider identifiers).
 * - Frame vs redirect view mode from the provisioning capability, with the
 *   TTL cache and its test reset.
 * - Cache-Control: no-store on public resolution (disable kills instantly).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  type CandidateReleaseStatus,
  db,
  venomCandidateReleasesTable,
  venomPortfolioAppIterationsTable,
  venomPortfolioAppSharesTable,
  venomPortfolioAppsTable,
  venomProvisioningRunsTable,
  type VenomPortfolioApp,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import express from "express";
import {
  overrideProvisioningProviderForTests,
  type ProvisioningProvider,
} from "../lib/venom-provisioning-provider.js";
import sharingRouter, {
  overrideVenomAppSharingUserIdResolverForTests,
  resetShareViewModeCacheForTests,
} from "./venom-app-sharing.js";

type TestResponse = {
  status: number;
  body: any;
  headers: Headers;
};

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

const SHARING_KEYS = [
  "appId",
  "embedSnippet",
  "embedUrl",
  "enabled",
  "liveIterationNumber",
  "livePublishedAt",
  "publicStatus",
  "shareUrl",
  "slug",
];

const PUBLIC_KEYS = ["appName", "frameUrl", "status", "viewMode"];

const UNAVAILABLE_BODY = {
  status: "unavailable",
  appName: null,
  viewMode: null,
  frameUrl: null,
};

test("app sharing: owner management, slug lifecycle, and public resolution", async () => {
  const suffix = randomUUID();
  const ownerA = `share-owner-a-${suffix}`;
  const ownerB = `share-owner-b-${suffix}`;
  let activeUserId: string | null = ownerA;
  const restoreAuth = overrideVenomAppSharingUserIdResolverForTests(
    () => activeUserId,
  );

  // Deterministic capability: mutable so individual sections can flip the
  // frame-embedding answer and exercise the view-mode TTL cache.
  let frameEmbeddingSupported = true;
  const restoreProvider = overrideProvisioningProviderForTests({
    checkCapability: async () => ({
      health: "healthy" as const,
      summary: "ok",
      recoveryGuidance: null,
      supportedTargetTypes: ["app" as const, "website" as const],
      rollbackSupported: true,
      publishSupported: true,
      frameEmbeddingSupported,
    }),
  } as unknown as ProvisioningProvider);
  resetShareViewModeCacheForTests();

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
  app.use(sharingRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (
    path: string,
    init?: RequestInit,
  ): Promise<TestResponse> => {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, headers: response.headers };
  };

  const putSharing = (appId: string, enabled: boolean) =>
    api(`/venom/apps/${appId}/sharing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });

  const createApp = async (
    owner: string,
    name: string,
  ): Promise<VenomPortfolioApp> => {
    const [row] = await db
      .insert(venomPortfolioAppsTable)
      .values({
        clerkUserId: owner,
        name,
        purpose: "Sharing test app",
        brand: "Monochrome",
      })
      .returning();
    assert.ok(row);
    return row;
  };

  /** Seeds run + release; returns both. Does NOT touch liveReleaseId. */
  const createRelease = async (
    owner: string,
    appId: string,
    options: {
      status?: CandidateReleaseStatus;
      launchUrl?: string | null;
      providerReleaseId?: string;
    } = {},
  ) => {
    const [run] = await db
      .insert(venomProvisioningRunsTable)
      .values({
        clerkUserId: owner,
        buildRunId: randomUUID(),
        approvedRevisionId: randomUUID(),
        appId,
        idempotencyKey: randomUUID(),
        targetName: `share-target-${randomUUID()}`,
        status: "published",
      })
      .returning();
    assert.ok(run);
    const [release] = await db
      .insert(venomCandidateReleasesTable)
      .values({
        clerkUserId: owner,
        provisioningRunId: run.id,
        buildRunId: run.buildRunId,
        approvedRevisionId: run.approvedRevisionId,
        appId,
        providerCandidateId: `prov-cand-${randomUUID()}`,
        providerReleaseId:
          options.providerReleaseId ?? `prov-rel-${randomUUID()}`,
        launchUrl:
          options.launchUrl === undefined
            ? "https://shared-app.example.com/live"
            : options.launchUrl,
        status: options.status ?? "published",
        publishedAt: new Date(),
      })
      .returning();
    assert.ok(release);
    return { run, release };
  };

  const setLive = (appId: string, releaseId: string | null) =>
    db
      .update(venomPortfolioAppsTable)
      .set({ liveReleaseId: releaseId })
      .where(eq(venomPortfolioAppsTable.id, appId));

  const appIds: string[] = [];
  try {
    // ── Unauthenticated → 401 on both management endpoints ────────────────
    const probeApp = await createApp(ownerA, "Probe");
    appIds.push(probeApp.id);
    activeUserId = null;
    assertStatus(await api(`/venom/apps/${probeApp.id}/sharing`), 401);
    assertStatus(await putSharing(probeApp.id, true), 401);
    activeUserId = ownerA;

    // ── Invalid app id → 400 ──────────────────────────────────────────────
    assertStatus(await api(`/venom/apps/not-a-uuid/sharing`), 400);

    // ── Default state: private, no slug, nothing live ─────────────────────
    // App name deliberately contains HTML-hostile characters to prove the
    // embed snippet escapes them.
    const shared = await createApp(ownerA, `Share & "Demo" <App>`);
    appIds.push(shared.id);
    const initial = await api(`/venom/apps/${shared.id}/sharing`);
    assertStatus(initial, 200);
    assert.deepEqual(Object.keys(initial.body).sort(), SHARING_KEYS);
    assert.equal(initial.body.enabled, false);
    assert.equal(initial.body.slug, null);
    assert.equal(initial.body.shareUrl, null);
    assert.equal(initial.body.embedSnippet, null);
    assert.equal(initial.body.publicStatus, "unavailable");

    // ── Non-owner sees 404, never state ───────────────────────────────────
    activeUserId = ownerB;
    assertStatus(await api(`/venom/apps/${shared.id}/sharing`), 404);
    assertStatus(await putSharing(shared.id, true), 404);
    activeUserId = ownerA;

    // ── Disabling a never-shared app is a quiet no-op ─────────────────────
    const noopDisable = await putSharing(shared.id, false);
    assertStatus(noopDisable, 200);
    assert.equal(noopDisable.body.enabled, false);
    assert.equal(noopDisable.body.slug, null);

    // ── Enable mints a stable slug and composes URLs ──────────────────────
    const enabled = await putSharing(shared.id, true);
    assertStatus(enabled, 200);
    assert.deepEqual(Object.keys(enabled.body).sort(), SHARING_KEYS);
    assert.equal(enabled.body.enabled, true);
    const slug: string = enabled.body.slug;
    assert.match(slug, /^[a-z0-9]{20,40}$/);
    assert.equal(enabled.body.shareUrl, `http://127.0.0.1:${port}/s/${slug}`);
    assert.equal(
      enabled.body.embedUrl,
      `http://127.0.0.1:${port}/s/${slug}/embed`,
    );
    const snippet: string = enabled.body.embedSnippet;
    assert.ok(snippet.startsWith("<iframe "));
    assert.ok(snippet.includes(`src="http://127.0.0.1:${port}/s/${slug}/embed"`));
    assert.ok(
      snippet.includes(`title="Share &amp; &quot;Demo&quot; &lt;App&gt;"`),
      `snippet must escape the app name: ${snippet}`,
    );
    assert.ok(!snippet.includes(`"Demo" <App>`));
    // Nothing live yet: link exists but the public status says fallback.
    assert.equal(enabled.body.publicStatus, "unavailable");

    // Second enable is idempotent and keeps the slug.
    const reEnabled = await putSharing(shared.id, true);
    assertStatus(reEnabled, 200);
    assert.equal(reEnabled.body.slug, slug);

    // ── Forwarded proxy headers drive the composed origin ─────────────────
    const forwarded = await api(`/venom/apps/${shared.id}/sharing`, {
      headers: {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "venom.example.com",
      },
    });
    assertStatus(forwarded, 200);
    assert.equal(
      forwarded.body.shareUrl,
      `https://venom.example.com/s/${slug}`,
    );

    // ── Public: enabled but nothing live → uniform unavailable ────────────
    const publicNoRelease = await api(`/public/app-shares/${slug}`);
    assertStatus(publicNoRelease, 200);
    assert.deepEqual(publicNoRelease.body, UNAVAILABLE_BODY);
    assert.equal(
      publicNoRelease.headers.get("cache-control"),
      "no-store",
      "public resolution must never be cached",
    );

    // ── Publish a release; public goes live at the same URL ───────────────
    const first = await createRelease(ownerA, shared.id, {
      launchUrl: "https://app-one.example.com/live",
      providerReleaseId: `prov-rel-first-${suffix}`,
    });
    await setLive(shared.id, first.release.id);
    // Map the release back to a package version for the owner panel.
    await db.insert(venomPortfolioAppIterationsTable).values({
      appId: shared.id,
      clerkUserId: ownerA,
      iterationNumber: 3,
      buildRunId: first.release.buildRunId,
      revisionId: first.release.approvedRevisionId,
      packageTitle: "Shared app package",
      packageChecksum: `sha256-${suffix}`,
      reason: "Initial share test package",
      createdBy: ownerA,
    });

    const ownerLive = await api(`/venom/apps/${shared.id}/sharing`);
    assertStatus(ownerLive, 200);
    assert.equal(ownerLive.body.publicStatus, "live");
    assert.equal(ownerLive.body.liveIterationNumber, 3);
    assert.ok(typeof ownerLive.body.livePublishedAt === "string");

    const publicLive = await api(`/public/app-shares/${slug}`);
    assertStatus(publicLive, 200);
    assert.deepEqual(Object.keys(publicLive.body).sort(), PUBLIC_KEYS);
    assert.equal(publicLive.body.status, "live");
    assert.equal(publicLive.body.appName, `Share & "Demo" <App>`);
    assert.equal(publicLive.body.viewMode, "frame");
    assert.equal(
      publicLive.body.frameUrl,
      "https://app-one.example.com/live",
    );
    assert.equal(publicLive.headers.get("cache-control"), "no-store");

    // No-leak sweep: the serialized public payload must not carry the owner,
    // any row id, or any provider identifier.
    const serialized = JSON.stringify(publicLive.body);
    for (const secret of [
      ownerA,
      "clerkUserId",
      shared.id,
      first.release.id,
      first.run.id,
      first.release.buildRunId,
      `prov-rel-first-${suffix}`,
      first.release.providerCandidateId,
      "provider",
      "release",
      "iteration",
    ]) {
      assert.ok(
        secret && !serialized.includes(String(secret)),
        `public payload leaked "${secret}": ${serialized}`,
      );
    }

    // ── Newer publish changes what the link serves, not the link ──────────
    await db
      .update(venomCandidateReleasesTable)
      .set({ status: "superseded" })
      .where(eq(venomCandidateReleasesTable.id, first.release.id));
    const second = await createRelease(ownerA, shared.id, {
      launchUrl: "https://app-two.example.com/live",
    });
    await setLive(shared.id, second.release.id);

    const publicSecond = await api(`/public/app-shares/${slug}`);
    assertStatus(publicSecond, 200);
    assert.equal(
      publicSecond.body.frameUrl,
      "https://app-two.example.com/live",
    );

    // ── Rollback restores the earlier release under the same URL ──────────
    await db
      .update(venomCandidateReleasesTable)
      .set({ status: "rolled_back", rolledBackAt: new Date() })
      .where(eq(venomCandidateReleasesTable.id, second.release.id));
    await db
      .update(venomCandidateReleasesTable)
      .set({ status: "published" })
      .where(eq(venomCandidateReleasesTable.id, first.release.id));
    await setLive(shared.id, first.release.id);

    const publicRolledBack = await api(`/public/app-shares/${slug}`);
    assertStatus(publicRolledBack, 200);
    assert.equal(publicRolledBack.body.status, "live");
    assert.equal(
      publicRolledBack.body.frameUrl,
      "https://app-one.example.com/live",
    );

    // ── A live pointer at a non-published release is not served ───────────
    const candidateOnly = await createRelease(ownerA, shared.id, {
      status: "candidate",
      launchUrl: "https://candidate.example.com/app",
    });
    await setLive(shared.id, candidateOnly.release.id);
    assert.deepEqual(
      (await api(`/public/app-shares/${slug}`)).body,
      UNAVAILABLE_BODY,
    );

    // ── A published release with a tainted launch URL is not served ───────
    const tainted = await createRelease(ownerA, shared.id, {
      launchUrl: "https://user:secret@evil.example.com/app",
    });
    await setLive(shared.id, tainted.release.id);
    assert.deepEqual(
      (await api(`/public/app-shares/${slug}`)).body,
      UNAVAILABLE_BODY,
    );

    // ── A live pointer at another owner's release is refused ──────────────
    const foreignApp = await createApp(ownerB, "Foreign");
    appIds.push(foreignApp.id);
    const foreign = await createRelease(ownerB, foreignApp.id, {
      launchUrl: "https://foreign.example.com/app",
    });
    await setLive(shared.id, foreign.release.id);
    assert.deepEqual(
      (await api(`/public/app-shares/${slug}`)).body,
      UNAVAILABLE_BODY,
    );

    // Restore a healthy live release for the remaining sections.
    await setLive(shared.id, first.release.id);

    // ── View mode: capability drives frame vs redirect, with TTL cache ────
    frameEmbeddingSupported = false;
    // Cache still warm → stays "frame" until reset.
    assert.equal((await api(`/public/app-shares/${slug}`)).body.viewMode, "frame");
    resetShareViewModeCacheForTests();
    assert.equal(
      (await api(`/public/app-shares/${slug}`)).body.viewMode,
      "redirect",
    );
    frameEmbeddingSupported = true;
    resetShareViewModeCacheForTests();
    assert.equal((await api(`/public/app-shares/${slug}`)).body.viewMode, "frame");

    // ── Disable kills the link immediately; slug survives ─────────────────
    const disabled = await putSharing(shared.id, false);
    assertStatus(disabled, 200);
    assert.equal(disabled.body.enabled, false);
    assert.equal(disabled.body.slug, slug, "slug must survive disable");
    assert.equal(disabled.body.shareUrl, null);
    assert.equal(disabled.body.embedUrl, null);
    assert.equal(disabled.body.embedSnippet, null);
    assert.deepEqual(
      (await api(`/public/app-shares/${slug}`)).body,
      UNAVAILABLE_BODY,
    );

    // Re-enable restores the exact same link.
    const restored = await putSharing(shared.id, true);
    assertStatus(restored, 200);
    assert.equal(restored.body.slug, slug, "slug must survive re-enable");
    assert.equal((await api(`/public/app-shares/${slug}`)).body.status, "live");

    // ── Unknown and malformed slugs ───────────────────────────────────────
    const unknown = await api(
      `/public/app-shares/zzzzzzzzzzzzzzzzzzzzzzzz`,
    );
    assertStatus(unknown, 200);
    assert.deepEqual(unknown.body, UNAVAILABLE_BODY);
    assertStatus(await api(`/public/app-shares/short`), 400);
    assertStatus(await api(`/public/app-shares/UPPERCASE-NOT-OK-123`), 400);

    // ── Invalid PUT body → 400 ────────────────────────────────────────────
    const badBody = await api(`/venom/apps/${shared.id}/sharing`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    assertStatus(badBody, 400);

    // ── Slugs are per-app and independent ─────────────────────────────────
    const sibling = await createApp(ownerA, "Sibling");
    appIds.push(sibling.id);
    const siblingEnabled = await putSharing(sibling.id, true);
    assertStatus(siblingEnabled, 200);
    assert.notEqual(siblingEnabled.body.slug, slug);
  } finally {
    restoreAuth();
    restoreProvider();
    resetShareViewModeCacheForTests();
    server.close();
    if (appIds.length > 0) {
      await db
        .delete(venomCandidateReleasesTable)
        .where(inArray(venomCandidateReleasesTable.clerkUserId, [ownerA, ownerB]));
      await db
        .delete(venomProvisioningRunsTable)
        .where(inArray(venomProvisioningRunsTable.clerkUserId, [ownerA, ownerB]));
      await db
        .delete(venomPortfolioAppSharesTable)
        .where(inArray(venomPortfolioAppSharesTable.clerkUserId, [ownerA, ownerB]));
      await db
        .delete(venomPortfolioAppIterationsTable)
        .where(
          inArray(venomPortfolioAppIterationsTable.clerkUserId, [ownerA, ownerB]),
        );
      await db
        .delete(venomPortfolioAppsTable)
        .where(inArray(venomPortfolioAppsTable.id, appIds));
    }
  }
});
