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
import { isSuperAdmin } from "../lib/venom-super-admins";

const router: IRouter = Router();

router.get("/venom/identity", async (req, res): Promise<void> => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // The super admin flag rides the identity record clients already fetch.
    // It is derived from the durable designation table on every request —
    // the server re-verifies the role separately for each privileged call,
    // so this flag only ever gates what the UI offers to show.
    const [identity, superAdmin] = await Promise.all([
      resolveVenomIdentity(auth.userId),
      isSuperAdmin(auth.userId),
    ]);
    res.json({ ...identity, superAdmin });
  } catch (error) {
    // Only storage failures reach here (auth-provider failures degrade to
    // a stale or all-null identity inside the resolver, without logging).
    req.log.error({ err: error }, "Venom identity resolution failed");
    res.status(500).json({ error: "Identity unavailable" });
  }
});

export default router;
