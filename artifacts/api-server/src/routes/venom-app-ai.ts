/**
 * Owner controls for a provisioned app's whitelabeled AI.
 *
 * Everything here is Clerk-authenticated and owner-scoped: usage numbers
 * come from the canonical ledger as aggregated dollars, the credential is
 * summarized by display prefix only, and the secret itself never appears in
 * any response — rotation delivers it straight into the provisioned app's
 * secret storage through the provisioning provider boundary. When immediate
 * delivery is impossible (provider unconfigured, project missing), the
 * rotation still stands: the old token is dead and the fresh one is
 * delivered at the next provisioning handoff.
 */

import { getAuth } from "@clerk/express";
import {
  GetVenomAppAiParams,
  GetVenomAppAiResponse,
  RevokeVenomAppAiCredentialParams,
  RotateVenomAppAiCredentialParams,
  UpdateVenomAppAiSettingsBody,
  UpdateVenomAppAiSettingsParams,
} from "@workspace/api-zod";
import { db, venomPortfolioAppsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";

import {
  APP_AI_GATEWAY_KEY_ENV,
  APP_AI_GATEWAY_URL_ENV,
  appAiGatewayBaseUrl,
  appAiSafetyCapMicros,
  findAppProviderProjectId,
  getActiveAppAiCredential,
  loadAppAiSettings,
  loadAppAiUsageSummary,
  loadOwnerAiMonthSpendMicros,
  deliverAppAiCredentialSerialized,
  mintAppAiCredential,
  revokeAppAiCredential,
  upsertAppAiSettings,
} from "../lib/venom-app-ai-store";
import { getProvisioningProvider } from "../lib/venom-provisioning-provider";
import { microsToUsd } from "../lib/venom-usage-pricing";

const router: IRouter = Router();

// ─── Auth override (test injection) ──────────────────────────────────────────

let resolveAppAiUserId = (request: Request): string | null =>
  getAuth(request).userId;

export function overrideVenomAppAiUserIdResolverForTests(
  resolver: (request: Request) => string | null,
): () => void {
  const previous = resolveAppAiUserId;
  resolveAppAiUserId = resolver;
  return () => {
    resolveAppAiUserId = previous;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function loadOwnedApp(
  userId: string,
  appId: string,
): Promise<{ id: string } | null> {
  const [app] = await db
    .select({ id: venomPortfolioAppsTable.id })
    .from(venomPortfolioAppsTable)
    .where(
      and(
        eq(venomPortfolioAppsTable.id, appId),
        eq(venomPortfolioAppsTable.clerkUserId, userId),
      ),
    )
    .limit(1);
  return app ?? null;
}

/**
 * The one response shape all four operations return. Costs are aggregated
 * dollars, models are Venom aliases with branded names, the credential is a
 * display-prefix summary — never the secret, never provider identifiers.
 */
async function buildAppAiOverview(
  userId: string,
  appId: string,
): Promise<Record<string, unknown>> {
  const [settings, credential, usage, ownerMonthMicros] = await Promise.all([
    loadAppAiSettings(appId),
    getActiveAppAiCredential(appId),
    loadAppAiUsageSummary(appId),
    loadOwnerAiMonthSpendMicros(userId),
  ]);
  return {
    appId,
    paused: settings?.paused ?? false,
    monthlyCapUsd:
      settings?.monthlyCapMicros == null
        ? null
        : microsToUsd(settings.monthlyCapMicros),
    safetyCapUsd: microsToUsd(appAiSafetyCapMicros()),
    credential: credential
      ? {
          displayPrefix: credential.displayPrefix,
          createdAt: credential.createdAt.toISOString(),
          lastUsedAt: credential.lastUsedAt
            ? credential.lastUsedAt.toISOString()
            : null,
          delivered: credential.deliveredAt !== null,
        }
      : null,
    usage,
    ownerMonthUsd: microsToUsd(ownerMonthMicros),
  };
}

/**
 * Push a freshly minted secret into the app's provider project secret
 * storage. Failure is non-fatal by design: the rotation stands (old token
 * dead), delivery happens at the next provisioning handoff instead.
 */
async function tryDeliverCredential(
  req: Request,
  userId: string,
  appId: string,
  credentialId: string,
  secret: string,
): Promise<void> {
  try {
    const providerProjectId = await findAppProviderProjectId(userId, appId);
    if (!providerProjectId) return;
    // Serialized with the credential lifecycle: skipped when a concurrent
    // rotation superseded this credential (its own delivery then owns the
    // provider secret), and a racing mint waits until this write lands.
    await deliverAppAiCredentialSerialized(
      appId,
      credentialId,
      providerProjectId,
      async () => {
        await getProvisioningProvider().deliverRuntimeCredentials({
          providerProjectId,
          credentials: {
            envVars: {
              [APP_AI_GATEWAY_URL_ENV]: appAiGatewayBaseUrl(),
              [APP_AI_GATEWAY_KEY_ENV]: secret,
            },
          },
        });
      },
    );
  } catch {
    // Never log the error object here: delivery failures can wrap provider
    // request details, and this path carries a live secret.
    req.log.warn(
      { appId, status: "deferred" },
      "App AI credential delivery deferred to next provisioning handoff",
    );
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/venom/apps/:appId/ai", async (req, res): Promise<void> => {
  const userId = resolveAppAiUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const params = GetVenomAppAiParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }
  const app = await loadOwnedApp(userId, params.data.appId);
  if (!app) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  res.json(GetVenomAppAiResponse.parse(await buildAppAiOverview(userId, app.id)));
});

router.put(
  "/venom/apps/:appId/ai/settings",
  async (req, res): Promise<void> => {
    const userId = resolveAppAiUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const params = UpdateVenomAppAiSettingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid app id" });
      return;
    }
    const body = UpdateVenomAppAiSettingsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid AI settings update" });
      return;
    }
    const app = await loadOwnedApp(userId, params.data.appId);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    await upsertAppAiSettings(userId, app.id, {
      monthlyCapMicros:
        body.data.monthlyCapUsd == null
          ? null
          : Math.round(body.data.monthlyCapUsd * 1_000_000),
      paused: body.data.paused,
    });
    req.log.info(
      {
        appId: app.id,
        paused: body.data.paused,
        hasMonthlyCap: body.data.monthlyCapUsd != null,
      },
      "App AI settings updated",
    );
    res.json(
      GetVenomAppAiResponse.parse(await buildAppAiOverview(userId, app.id)),
    );
  },
);

router.post(
  "/venom/apps/:appId/ai/credential/rotate",
  async (req, res): Promise<void> => {
    const userId = resolveAppAiUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const params = RotateVenomAppAiCredentialParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid app id" });
      return;
    }
    const app = await loadOwnedApp(userId, params.data.appId);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const minted = await mintAppAiCredential(userId, app.id);
    await tryDeliverCredential(req, userId, app.id, minted.credential.id, minted.secret);
    req.log.info({ appId: app.id }, "App AI credential rotated");
    res.json(
      GetVenomAppAiResponse.parse(await buildAppAiOverview(userId, app.id)),
    );
  },
);

router.post(
  "/venom/apps/:appId/ai/credential/revoke",
  async (req, res): Promise<void> => {
    const userId = resolveAppAiUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const params = RevokeVenomAppAiCredentialParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid app id" });
      return;
    }
    const app = await loadOwnedApp(userId, params.data.appId);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    await revokeAppAiCredential(userId, app.id);
    req.log.info({ appId: app.id }, "App AI credential revoked");
    res.json(
      GetVenomAppAiResponse.parse(await buildAppAiOverview(userId, app.id)),
    );
  },
);

export default router;
