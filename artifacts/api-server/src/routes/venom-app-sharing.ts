/**
 * Venom app sharing routes: public distribution for provisioned apps.
 *
 * Owners of a portfolio app can enable link-based public sharing: a stable
 * high-entropy slug on Venom's own domain (`/s/{slug}`) plus an iframe embed
 * snippet. The public resolution endpoint maps slug → the app's *currently
 * published, healthy* release at read time, so publishes and rollbacks change
 * what the link serves without ever changing the URL.
 *
 * Security invariants:
 * - Management endpoints are owner-only (Clerk user id); non-owners get 404.
 * - Public resolution is unauthenticated but uniform: unknown slug, sharing
 *   disabled, and no-healthy-release all return the exact same "unavailable"
 *   payload — public callers can never distinguish them or enumerate state.
 * - Public payloads never contain owner identity, provider identifiers,
 *   release ids, or any internal lifecycle detail. Only the app's display
 *   name and the sanitized launch URL of the live release ever leave.
 * - Slugs are 128-bit random, never derived from user or app identifiers.
 * - `Cache-Control: no-store` on public resolution so disabling sharing
 *   kills links and embeds immediately.
 * - Public resolution is rate limited per caller IP.
 */

import { randomBytes } from "node:crypto";
import { getAuth } from "@clerk/express";
import {
  GetVenomAppSharingParams,
  GetVenomAppSharingResponse,
  ResolvePublicAppShareParams,
  ResolvePublicAppShareResponse,
  UpdateVenomAppSharingBody,
  UpdateVenomAppSharingParams,
  UpdateVenomAppSharingResponse,
} from "@workspace/api-zod";
import {
  db,
  venomCandidateReleasesTable,
  venomPortfolioAppSharesTable,
  venomPortfolioAppsTable,
  type VenomPortfolioApp,
  type VenomPortfolioAppShare,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  applyRateLimit,
  checkRateLimit,
} from "../lib/community-rate-limit";
import { loadLiveReleaseFacts } from "../lib/venom-app-iterations";
import {
  getProvisioningProvider,
  sanitizeLaunchUrl,
} from "../lib/venom-provisioning-provider";

const router: IRouter = Router();

// ─── Auth override (test injection) ──────────────────────────────────────────

let resolveAppSharingUserId = (request: Request): string | null =>
  getAuth(request).userId;

export function overrideVenomAppSharingUserIdResolverForTests(
  resolver: (request: Request) => string | null,
): () => void {
  const previous = resolveAppSharingUserId;
  resolveAppSharingUserId = resolver;
  return () => {
    resolveAppSharingUserId = previous;
  };
}

// ─── View mode (frame vs redirect) ───────────────────────────────────────────

/**
 * Whether public share surfaces should iframe the deployment or link out to
 * it, decided by the provisioning provider's frame-embedding capability.
 * Cached briefly so the public endpoint does not call the provider gateway
 * on every resolution; on any provider hiccup the last known (or default
 * "frame") answer is kept — a capability outage must not flip live embeds.
 */
const VIEW_MODE_TTL_MS = 5 * 60_000;

let cachedViewMode: {
  value: "frame" | "redirect";
  expiresAt: number;
} | null = null;

export function resetShareViewModeCacheForTests(): void {
  cachedViewMode = null;
}

async function resolveShareViewMode(): Promise<"frame" | "redirect"> {
  const now = Date.now();
  if (cachedViewMode && cachedViewMode.expiresAt > now) {
    return cachedViewMode.value;
  }
  try {
    const capability = await getProvisioningProvider().checkCapability();
    const value = capability.frameEmbeddingSupported ? "frame" : "redirect";
    cachedViewMode = { value, expiresAt: now + VIEW_MODE_TTL_MS };
    return value;
  } catch {
    // checkCapability never throws by contract; belt and braces.
    return cachedViewMode?.value ?? "frame";
  }
}

// ─── Slug + URL helpers ──────────────────────────────────────────────────────

/** 128-bit random slug in base36. Never derived from user or app ids. */
function generateShareSlug(): string {
  for (;;) {
    const candidate = BigInt(`0x${randomBytes(16).toString("hex")}`)
      .toString(36)
      .toLowerCase();
    if (/^[a-z0-9]{20,40}$/.test(candidate)) return candidate;
  }
}

/** Hostname (optionally with port) — nothing else is accepted. */
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*(:\d{1,5})?$/i;

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

/**
 * Public origin of this request as seen through the proxy, or null when the
 * host cannot be validated. Used only to compose owner-facing share URLs —
 * never trusted for anything security-relevant.
 */
function requestPublicOrigin(request: Request): string | null {
  const host =
    firstHeaderValue(request.headers["x-forwarded-host"]) ??
    firstHeaderValue(request.headers.host);
  if (!host || host.length > 255 || !HOST_PATTERN.test(host)) return null;
  const forwardedProto = firstHeaderValue(
    request.headers["x-forwarded-proto"],
  )?.toLowerCase();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.secure
        ? "https"
        : "http";
  return `${proto}://${host.toLowerCase()}`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Shared lookups ──────────────────────────────────────────────────────────

async function loadOwnedApp(
  userId: string,
  appId: string,
): Promise<VenomPortfolioApp | null> {
  const [app] = await db
    .select()
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

async function loadShareRow(
  appId: string,
): Promise<VenomPortfolioAppShare | null> {
  const [share] = await db
    .select()
    .from(venomPortfolioAppSharesTable)
    .where(eq(venomPortfolioAppSharesTable.appId, appId))
    .limit(1);
  return share ?? null;
}

type LivePublicFacts = {
  iterationNumber: number | null;
  publishedAt: string | null;
};

/**
 * The app's currently published, healthy release — the only thing public
 * surfaces are allowed to serve. Returns null unless the live pointer
 * resolves to an owner-matching release in "published" status with a
 * sanitizable launch URL.
 */
async function loadLivePublicRelease(
  app: VenomPortfolioApp,
): Promise<{ launchUrl: string; facts: LivePublicFacts } | null> {
  const facts = await loadLiveReleaseFacts(app.clerkUserId, [app]);
  const live = facts.get(app.id);
  if (!live) return null;
  if (live.release.appId !== app.id) return null;
  if (live.release.status !== "published") return null;
  const launchUrl = sanitizeLaunchUrl(live.release.launchUrl);
  if (!launchUrl) return null;
  return {
    launchUrl,
    facts: {
      iterationNumber: live.iteration?.iterationNumber ?? null,
      publishedAt:
        live.release.publishedAt?.toISOString() ??
        live.release.updatedAt?.toISOString() ??
        null,
    },
  };
}

function sharingPayload(
  request: Request,
  app: VenomPortfolioApp,
  share: VenomPortfolioAppShare | null,
  live: LivePublicFacts | null,
) {
  const enabled = share?.enabled === true;
  const slug = share?.slug ?? null;
  const origin = requestPublicOrigin(request);
  let shareUrl: string | null = null;
  let embedUrl: string | null = null;
  let embedSnippet: string | null = null;
  if (enabled && slug && origin) {
    shareUrl = `${origin}/s/${slug}`;
    embedUrl = `${origin}/s/${slug}/embed`;
    embedSnippet = `<iframe src="${embedUrl}" title="${escapeHtmlAttribute(app.name)}" style="border:0;width:100%;height:600px;border-radius:12px" allow="clipboard-write; fullscreen" loading="lazy"></iframe>`;
  }
  return {
    appId: app.id,
    enabled,
    slug,
    shareUrl,
    embedUrl,
    embedSnippet,
    publicStatus: live ? ("live" as const) : ("unavailable" as const),
    liveIterationNumber: live?.iterationNumber ?? null,
    livePublishedAt: live?.publishedAt ?? null,
  };
}

// ─── Owner endpoints ─────────────────────────────────────────────────────────

router.get("/venom/apps/:appId/sharing", async (req, res): Promise<void> => {
  const userId = resolveAppSharingUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const params = GetVenomAppSharingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }
  const app = await loadOwnedApp(userId, params.data.appId);
  if (!app) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const [share, live] = await Promise.all([
    loadShareRow(app.id),
    loadLivePublicRelease(app),
  ]);
  res.json(
    GetVenomAppSharingResponse.parse(
      sharingPayload(req, app, share, live?.facts ?? null),
    ),
  );
});

router.put("/venom/apps/:appId/sharing", async (req, res): Promise<void> => {
  const userId = resolveAppSharingUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const params = UpdateVenomAppSharingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid app id" });
    return;
  }
  const body = UpdateVenomAppSharingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid sharing update" });
    return;
  }
  const app = await loadOwnedApp(userId, params.data.appId);
  if (!app) {
    res.status(404).json({ error: "App not found" });
    return;
  }

  const enabled = body.data.enabled;
  let share = await loadShareRow(app.id);
  if (share) {
    if (share.enabled !== enabled) {
      const [updated] = await db
        .update(venomPortfolioAppSharesTable)
        .set(
          enabled
            ? { enabled: true, enabledAt: new Date() }
            : { enabled: false, disabledAt: new Date() },
        )
        .where(
          and(
            eq(venomPortfolioAppSharesTable.id, share.id),
            eq(venomPortfolioAppSharesTable.clerkUserId, userId),
          ),
        )
        .returning();
      share = updated ?? share;
    }
  } else if (enabled) {
    // First enable for this app: mint the stable slug. Retry on the
    // (astronomically unlikely) global slug collision.
    for (let attempt = 0; attempt < 3 && !share; attempt += 1) {
      try {
        const [created] = await db
          .insert(venomPortfolioAppSharesTable)
          .values({
            appId: app.id,
            clerkUserId: userId,
            slug: generateShareSlug(),
            enabled: true,
            enabledAt: new Date(),
          })
          .returning();
        share = created ?? null;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "23505") throw error;
        // Unique violation on appId means a concurrent enable won; reuse it.
        const existing = await loadShareRow(app.id);
        if (existing) {
          share = existing;
          break;
        }
        // Otherwise the slug collided — loop and mint a fresh one.
      }
    }
    if (!share) {
      res.status(500).json({ error: "Could not enable sharing" });
      return;
    }
    if (!share.enabled) {
      // Concurrent-create row was disabled; apply the requested enable.
      const [updated] = await db
        .update(venomPortfolioAppSharesTable)
        .set({ enabled: true, enabledAt: new Date() })
        .where(
          and(
            eq(venomPortfolioAppSharesTable.id, share.id),
            eq(venomPortfolioAppSharesTable.clerkUserId, userId),
          ),
        )
        .returning();
      share = updated ?? share;
    }
  }
  // Disabling an app that was never shared is a no-op (share stays null).

  req.log.info(
    { appId: app.id, sharingEnabled: enabled },
    "Venom app sharing updated",
  );
  const live = await loadLivePublicRelease(app);
  res.json(
    UpdateVenomAppSharingResponse.parse(
      sharingPayload(req, app, share, live?.facts ?? null),
    ),
  );
});

// ─── Public resolution ───────────────────────────────────────────────────────

const UNAVAILABLE_PAYLOAD = {
  status: "unavailable" as const,
  appName: null,
  viewMode: null,
  frameUrl: null,
};

router.get(
  "/public/app-shares/:slug",
  async (req, res): Promise<void> => {
    // Disabling sharing must kill links/embeds immediately — never cache.
    res.setHeader("Cache-Control", "no-store");

    const rate = await checkRateLimit(
      `share-ip:${req.ip ?? "unknown"}`,
      "app_share_resolve",
    );
    if (applyRateLimit(res, rate)) return;

    const params = ResolvePublicAppShareParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid share link" });
      return;
    }

    const respondUnavailable = (): void => {
      res.json(ResolvePublicAppShareResponse.parse(UNAVAILABLE_PAYLOAD));
    };

    const [share] = await db
      .select()
      .from(venomPortfolioAppSharesTable)
      .where(eq(venomPortfolioAppSharesTable.slug, params.data.slug))
      .limit(1);
    if (!share || !share.enabled) {
      respondUnavailable();
      return;
    }
    const [app] = await db
      .select()
      .from(venomPortfolioAppsTable)
      .where(
        and(
          eq(venomPortfolioAppsTable.id, share.appId),
          eq(venomPortfolioAppsTable.clerkUserId, share.clerkUserId),
        ),
      )
      .limit(1);
    if (!app) {
      respondUnavailable();
      return;
    }
    const live = await loadLivePublicRelease(app);
    if (!live) {
      respondUnavailable();
      return;
    }
    const viewMode = await resolveShareViewMode();
    res.json(
      ResolvePublicAppShareResponse.parse({
        status: "live",
        appName: app.name,
        viewMode,
        frameUrl: live.launchUrl,
      }),
    );
  },
);

export default router;
