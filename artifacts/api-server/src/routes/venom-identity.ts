/**
 * Who Venom recognizes the signed-in account as.
 *
 * GET /venom/identity resolves the authenticated account into its per-user
 * identity record (display name, email, sign-in provider), creating the
 * record on first authenticated use and refreshing it when stale. The
 * response is personal data: bounded upstream, returned only to the
 * account it belongs to, and never logged.
 */

import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { resolveVenomIdentity } from "../lib/venom-identity";

const router: IRouter = Router();

router.get("/venom/identity", async (req, res): Promise<void> => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const identity = await resolveVenomIdentity(auth.userId);
    res.json(identity);
  } catch (error) {
    // Only storage failures reach here (auth-provider failures degrade to
    // a stale or all-null identity inside the resolver, without logging).
    req.log.error({ err: error }, "Venom identity resolution failed");
    res.status(500).json({ error: "Identity unavailable" });
  }
});

export default router;
