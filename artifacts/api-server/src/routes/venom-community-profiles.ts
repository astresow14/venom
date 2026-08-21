/**
 * venom-community-profiles.ts
 * Community profile endpoints: GET and PUT /venom/community/profile
 */

import { getAuth } from "@clerk/express";
import {
  GetCommunityProfileResponse,
  UpsertCommunityProfileBody,
  UpsertCommunityProfileResponse,
} from "@workspace/api-zod";
import {
  communityProfilesTable,
  db,
  type CommunityProfile,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { checkRateLimit, applyRateLimit } from "../lib/community-rate-limit";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Public payload builder — explicit allowlist, never spreads DB rows
// ---------------------------------------------------------------------------

export function profilePayload(profile: CommunityProfile) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    bio: profile.bio ?? null,
    joinedAt: profile.createdAt,
  };
}

// ---------------------------------------------------------------------------
// GET /venom/community/profile — get own profile
// ---------------------------------------------------------------------------

router.get("/venom/community/profile", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [profile] = await db
    .select()
    .from(communityProfilesTable)
    .where(eq(communityProfilesTable.clerkUserId, userId))
    .limit(1);

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  res.json(GetCommunityProfileResponse.parse(profilePayload(profile)));
});

// ---------------------------------------------------------------------------
// PUT /venom/community/profile — create or update own profile
// ---------------------------------------------------------------------------

router.put("/venom/community/profile", async (req, res): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const parsed = UpsertCommunityProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid profile data" });
    return;
  }

  const rl = await checkRateLimit(userId, "profile_upsert");
  if (applyRateLimit(res, rl)) return;

  const start = Date.now();

  const [profile] = await db
    .insert(communityProfilesTable)
    .values({
      clerkUserId: userId,
      displayName: parsed.data.displayName.trim(),
      bio: parsed.data.bio?.trim() ?? null,
    })
    .onConflictDoUpdate({
      target: communityProfilesTable.clerkUserId,
      set: {
        displayName: parsed.data.displayName.trim(),
        bio: parsed.data.bio?.trim() ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!profile) {
    res.status(500).json({ error: "Internal error" });
    return;
  }

  req.log.info(
    { profileId: profile.id, durationMs: Date.now() - start, op: "upsert_profile" },
    "Community profile upserted",
  );

  res.json(UpsertCommunityProfileResponse.parse(profilePayload(profile)));
});

export default router;
