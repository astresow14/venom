/**
 * Personal AI usage summary routes.
 *
 * Strictly self-serve: the summary is always scoped to the authenticated
 * account — there is no way to name another user. Money leaves this surface
 * as aggregated dollar amounts under Venom-branded model names; provider
 * SKUs and per-token rates never appear in any payload or log line.
 */

import { Router, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";

import {
  loadVenomUsageSummary,
  type VenomUsageSummaryData,
} from "../lib/venom-usage-store";

export type VenomUsageRouterOptions = {
  /** Injectable auth seam for tests. Defaults to Clerk. */
  resolveUserId?: (req: Request) => string | null | undefined;
  /** Injectable summary loader for db-less tests. */
  loadSummary?: (userId: string) => Promise<VenomUsageSummaryData>;
};

export function createVenomUsageRouter(
  options: VenomUsageRouterOptions = {},
): Router {
  const resolveUserId =
    options.resolveUserId ?? ((req: Request) => getAuth(req).userId);
  const loadSummary =
    options.loadSummary ?? ((userId: string) => loadVenomUsageSummary(userId));

  const router = Router();

  router.get("/venom/usage/summary", async (req: Request, res: Response) => {
    const userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    try {
      const summary = await loadSummary(userId);
      res.json(summary);
    } catch (error) {
      req.log.error({ err: error }, "Venom usage summary failed");
      res.status(500).json({ error: "Usage summary is unavailable" });
    }
  });

  return router;
}
