/**
 * Starts the server-side scheduled source sync (see
 * ../lib/venom-scheduled-source-sync.ts) with the same live dependencies the
 * interactive connect routes use, so an unattended re-sync is
 * indistinguishable from the user pressing "refresh" themselves.
 */
import { lookup } from "node:dns/promises";
import https from "node:https";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { sql } from "drizzle-orm";
import { db, venomWorkspacesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { createSourceAttestation } from "../lib/source-attestations";
import { isGitHubWorkspaceMember } from "../lib/source-membership";
import {
  createVenomScheduledSourceSyncWorker,
  SCHEDULED_SOURCE_SYNC_INTERVAL_MS,
} from "../lib/venom-scheduled-source-sync";
import {
  createGitHubRequest,
  createWebsiteFetcher,
} from "./venom-sources-router";
import { databaseWorkspaceStore } from "./venom-workspace";

/**
 * Only workspaces that actually contain a daily/weekly source schedule are
 * worth reading; the jsonb probe keeps the scan cheap when most rows have no
 * schedules at all. Oldest-saved rows go first — with per-pass caps, the
 * workspaces nobody has opened in the longest are exactly the ones this
 * worker exists for.
 */
async function listScheduledWorkspaceUserIds(limit: number): Promise<string[]> {
  const rows = await db
    .select({ clerkUserId: venomWorkspacesTable.clerkUserId })
    .from(venomWorkspacesTable)
    .where(
      sql`EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(${venomWorkspacesTable.state} -> 'sources') = 'array'
            THEN ${venomWorkspacesTable.state} -> 'sources'
            ELSE '[]'::jsonb
          END
        ) AS scheduled_source
        WHERE scheduled_source -> 'schedule' ->> 'cadence' IN ('daily', 'weekly')
      )`,
    )
    .orderBy(venomWorkspacesTable.updatedAt)
    .limit(limit);
  return rows.map((row) => row.clerkUserId);
}

function createWorker() {
  return createVenomScheduledSourceSyncWorker({
    listScheduledWorkspaceUserIds,
    store: databaseWorkspaceStore,
    isWorkspaceMember: isGitHubWorkspaceMember,
    // A fresh connector client per request, exactly like the connect route,
    // so long-lived worker state can never hold a stale connector token.
    githubRequest: createGitHubRequest((connector, path, init) =>
      new ReplitConnectors().proxy(connector, path, init),
    ),
    resolveAddresses: (hostname) => lookup(hostname, { all: true }),
    fetchWebsite: createWebsiteFetcher(https.request),
    createAttestation: createSourceAttestation,
    log: logger,
  });
}

let worker: ReturnType<typeof createWorker> | null = null;
let timer: NodeJS.Timeout | null = null;

function runScheduledPass(): void {
  if (!worker) return;
  void worker.runPass().catch((error) => {
    logger.error(
      {
        operation: "venom_scheduled_source_sync",
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "scheduled source sync pass failed",
    );
  });
}

/**
 * Idempotent; the interval is unref'd so a draining process never lingers for
 * the next tick. Every write is CAS-guarded, so overlapping instances (extra
 * deployment machines) are safe — they only cost duplicate reads.
 */
export function startVenomScheduledSourceSyncWorker(): void {
  if (timer) return;
  worker = createWorker();
  runScheduledPass();
  timer = setInterval(runScheduledPass, SCHEDULED_SOURCE_SYNC_INTERVAL_MS);
  timer.unref?.();
}
