import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  db,
  venomPortfolioAppsTable,
  venomSopRevisionsTable,
  venomSopsTable,
  venomWorkspacesTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import express from "express";
import router, {
  overrideVenomSopUserIdResolverForTests,
} from "./venom-sops.js";

type TestResponse = {
  status: number;
  body: any;
};

async function ensureSopTestSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_workspaces (
      clerk_user_id text PRIMARY KEY,
      state jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_portfolio_apps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id text NOT NULL,
      name text NOT NULL,
      purpose text NOT NULL,
      brand text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      detected_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_type text NOT NULL DEFAULT 'none',
      current_source_version integer NOT NULL DEFAULT 0,
      latest_import_status text,
      source_updated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sops (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_user_id text NOT NULL,
      title text NOT NULL,
      lifecycle text NOT NULL DEFAULT 'draft',
      category text NOT NULL,
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      provenance text NOT NULL DEFAULT 'manual',
      content jsonb NOT NULL,
      active_revision_id uuid,
      active_revision_number integer,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_sops_owner_updated_idx
      ON venom_sops (clerk_user_id, updated_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_sops_owner_lifecycle_idx
      ON venom_sops (clerk_user_id, lifecycle)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sop_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sop_id uuid NOT NULL REFERENCES venom_sops(id) ON DELETE CASCADE,
      clerk_user_id text NOT NULL,
      version_number integer NOT NULL,
      title text NOT NULL,
      category text NOT NULL,
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      provenance text NOT NULL,
      content jsonb NOT NULL,
      checksum_sha256 text NOT NULL,
      published_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS venom_sop_revisions_sop_version_idx
      ON venom_sop_revisions (sop_id, version_number)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_sop_revisions_owner_sop_idx
      ON venom_sop_revisions (clerk_user_id, sop_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sop_app_assignments (
      clerk_user_id text NOT NULL,
      sop_id uuid NOT NULL REFERENCES venom_sops(id) ON DELETE CASCADE,
      app_id uuid NOT NULL REFERENCES venom_portfolio_apps(id) ON DELETE CASCADE,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_sop_app_assignments_pk PRIMARY KEY (sop_id, app_id)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_sop_app_assignments_owner_app_idx
      ON venom_sop_app_assignments (clerk_user_id, app_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS venom_sop_project_selections (
      clerk_user_id text NOT NULL,
      project_id text NOT NULL,
      sop_id uuid NOT NULL REFERENCES venom_sops(id) ON DELETE CASCADE,
      revision_id uuid NOT NULL REFERENCES venom_sop_revisions(id) ON DELETE CASCADE,
      selected_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT venom_sop_project_selections_pk
        PRIMARY KEY (clerk_user_id, project_id, sop_id)
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS venom_sop_project_selections_owner_project_idx
      ON venom_sop_project_selections (clerk_user_id, project_id)
  `);
}

function assertStatus(response: TestResponse, expected: number): void {
  assert.equal(
    response.status,
    expected,
    `Expected HTTP ${expected}; received ${response.status}: ${JSON.stringify(response.body)}`,
  );
}

test("SOP routes isolate accounts and preserve immutable pinned revisions", async () => {
  await ensureSopTestSchema();
  const suffix = randomUUID();
  const ownerA = `sop-route-a-${suffix}`;
  const ownerB = `sop-route-b-${suffix}`;
  const projectId = `project-${suffix}`;
  const bodyMarker = `sop-body-${suffix}`;
  let activeUserId = ownerA;
  const capturedLogs: unknown[] = [];
  const restoreAuth = overrideVenomSopUserIdResolverForTests(
    () => activeUserId,
  );
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.log = {
      info: (...args: unknown[]) => capturedLogs.push(args),
      warn: (...args: unknown[]) => capturedLogs.push(args),
      error: (...args: unknown[]) => capturedLogs.push(args),
    } as unknown as typeof request.log;
    next();
  });
  app.use(router);
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
        body = {
          contentType: response.headers.get("content-type"),
          rawBody: rawBody.slice(0, 2_000),
        };
      }
    }
    return {
      status: response.status,
      body,
    };
  }

  try {
    await db.insert(venomWorkspacesTable).values([
      {
        clerkUserId: ownerA,
        state: { projects: [{ id: projectId, name: "Test project" }] },
      },
      {
        clerkUserId: ownerB,
        state: { projects: [{ id: `foreign-${projectId}` }] },
      },
    ]);
    const [ownApp, foreignApp] = await db
      .insert(venomPortfolioAppsTable)
      .values([
        {
          clerkUserId: ownerA,
          name: "Owned app",
          purpose: "Test",
          brand: "Test",
        },
        {
          clerkUserId: ownerB,
          name: "Foreign app",
          purpose: "Test",
          brand: "Test",
        },
      ])
      .returning();

    const created = await request("/venom/sops", {
      method: "POST",
      body: JSON.stringify({
        title: `Account-isolated ${suffix}`,
        category: "operations",
        tags: ["security", "test"],
        provenance: "model_assisted",
        content: {
          purpose: bodyMarker,
          prerequisites: ["Approved brief"],
          inputs: ["Release candidate"],
          guidance: ["Review without executing external actions"],
          requiredApprovals: ["Owner approval"],
          acceptanceChecks: ["Approval recorded"],
        },
      }),
    });
    assertStatus(created, 201);
    const sopId = created.body.id as string;

    const ownAssignment = await request(`/venom/sops/${sopId}/apps`, {
      method: "PUT",
      body: JSON.stringify({ appIds: [ownApp.id] }),
    });
    assertStatus(ownAssignment, 200);
    assert.equal(ownAssignment.body[0].appId, ownApp.id);

    const foreignAssignment = await request(`/venom/sops/${sopId}/apps`, {
      method: "PUT",
      body: JSON.stringify({ appIds: [foreignApp.id] }),
    });
    assertStatus(foreignAssignment, 400);

    activeUserId = ownerB;
    const crossAccountGet = await request(`/venom/sops/${sopId}`);
    assertStatus(crossAccountGet, 404);
    const crossAccountUpdate = await request(`/venom/sops/${sopId}`, {
      method: "PATCH",
      body: JSON.stringify(created.body),
    });
    assertStatus(crossAccountUpdate, 404);

    activeUserId = ownerA;
    const firstPublish = await request(`/venom/sops/${sopId}/publish`, {
      method: "POST",
    });
    assertStatus(firstPublish, 200);
    assert.equal(firstPublish.body.versionNumber, 1);

    const secondPurpose = `updated-${bodyMarker}`;
    const update = await request(`/venom/sops/${sopId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: created.body.title,
        category: created.body.category,
        tags: created.body.tags,
        provenance: created.body.provenance,
        content: {
          ...created.body.content,
          purpose: secondPurpose,
        },
      }),
    });
    assertStatus(update, 200);
    const secondPublish = await request(`/venom/sops/${sopId}/publish`, {
      method: "POST",
    });
    assertStatus(secondPublish, 200);
    assert.equal(secondPublish.body.versionNumber, 2);

    const selection = await request(`/venom/projects/${projectId}/sops`, {
      method: "PUT",
      body: JSON.stringify({ sopIds: [sopId] }),
    });
    assertStatus(selection, 200);
    assert.equal(selection.body[0].revisionId, secondPublish.body.id);

    await request(`/venom/sops/${sopId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title: created.body.title,
        category: created.body.category,
        tags: created.body.tags,
        provenance: created.body.provenance,
        content: {
          ...created.body.content,
          purpose: `third-${bodyMarker}`,
        },
      }),
    });
    const thirdPublish = await request(`/venom/sops/${sopId}/publish`, {
      method: "POST",
    });
    assertStatus(thirdPublish, 200);
    assert.equal(thirdPublish.body.versionNumber, 3);

    const pinnedSelection = await request(
      `/venom/projects/${projectId}/sops`,
    );
    assertStatus(pinnedSelection, 200);
    assert.equal(pinnedSelection.body[0].revisionId, secondPublish.body.id);

    const [immutableFirst] = await db
      .select()
      .from(venomSopRevisionsTable)
      .where(
        and(
          eq(venomSopRevisionsTable.clerkUserId, ownerA),
          eq(venomSopRevisionsTable.id, firstPublish.body.id),
        ),
      );
    assert.equal(immutableFirst.content.purpose, bodyMarker);

    const workspace = await db
      .select({ state: venomWorkspacesTable.state })
      .from(venomWorkspacesTable)
      .where(eq(venomWorkspacesTable.clerkUserId, ownerA));
    const workspaceSnapshot = JSON.stringify(workspace[0].state);
    assert.ok(!workspaceSnapshot.includes(sopId));
    assert.ok(!workspaceSnapshot.includes(bodyMarker));

    const archived = await request(`/venom/sops/${sopId}/archive`, {
      method: "POST",
    });
    assertStatus(archived, 200);
    assert.equal(archived.body.lifecycle, "archived");
    const afterArchive = await request(`/venom/projects/${projectId}/sops`);
    assert.deepEqual(afterArchive.body, []);

    const oversized = await request("/venom/sops", {
      method: "POST",
      body: JSON.stringify({
        title: `Oversized reference ${suffix}`,
        category: "operations",
        tags: [],
        provenance: "manual",
        content: {
          purpose: "Review a deliberately detailed operating reference.",
          prerequisites: Array.from(
            { length: 8 },
            (_, index) => `Prerequisite ${index} ${"safe text ".repeat(48)}`,
          ),
          inputs: Array.from(
            { length: 8 },
            (_, index) => `Input ${index} ${"safe text ".repeat(48)}`,
          ),
          guidance: Array.from(
            { length: 8 },
            (_, index) => `Guidance ${index} ${"safe text ".repeat(180)}`,
          ),
          requiredApprovals: Array.from(
            { length: 8 },
            (_, index) => `Approval ${index} ${"safe text ".repeat(48)}`,
          ),
          acceptanceChecks: Array.from(
            { length: 8 },
            (_, index) => `Check ${index} ${"safe text ".repeat(48)}`,
          ),
        },
      }),
    });
    assertStatus(oversized, 201);
    const oversizedPublish = await request(
      `/venom/sops/${oversized.body.id}/publish`,
      { method: "POST" },
    );
    assertStatus(oversizedPublish, 200);
    const oversizedSelection = await request(
      `/venom/projects/${projectId}/sops`,
      {
        method: "PUT",
        body: JSON.stringify({ sopIds: [oversized.body.id] }),
      },
    );
    assertStatus(oversizedSelection, 409);
    assert.match(oversizedSelection.body.error, /context limit/i);
    const afterBudgetRejection = await request(
      `/venom/projects/${projectId}/sops`,
    );
    assert.deepEqual(afterBudgetRejection.body, []);

    assert.ok(!JSON.stringify(capturedLogs).includes(bodyMarker));
    assert.ok(!JSON.stringify(capturedLogs).includes(secondPurpose));
  } finally {
    server.close();
    restoreAuth();
    await db
      .delete(venomSopsTable)
      .where(inArray(venomSopsTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomPortfolioAppsTable)
      .where(inArray(venomPortfolioAppsTable.clerkUserId, [ownerA, ownerB]));
    await db
      .delete(venomWorkspacesTable)
      .where(inArray(venomWorkspacesTable.clerkUserId, [ownerA, ownerB]));
  }
});