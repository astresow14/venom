/**
 * Venom's canon: super-admin-only teaching and stewardship endpoints.
 *
 * Every route here re-verifies the super admin role against the durable
 * designation table before doing anything else. Refusals are opaque — one
 * 403 body (`canon_access_denied`) for unauthenticated-but-unprivileged
 * callers, malformed params, and unknown resources alike — mirroring the
 * shared-workspace membership pattern so nothing about the canon surface
 * can be probed from outside it.
 *
 * The teach flow is two-step by design: `propose` distills a chat message
 * into a bounded draft (nothing stored), and `teachings` POST commits only
 * what the admin confirmed. Regular users' "store this" messages never
 * reach these routes; their chat path files into the personal Brain as
 * before.
 */

import { Router, type IRouter, type Request } from "express";
import { getAuth } from "@clerk/express";
import { clerkClient } from "@clerk/express";
import {
  CommitVenomCanonTeachingBody,
  CommitVenomCanonTeachingResponse,
  GrantVenomCanonAdminBody,
  GrantVenomCanonAdminResponse,
  ListVenomCanonAdminsResponse,
  ListVenomCanonTeachingsResponse,
  ProposeVenomCanonTeachingBody,
  ProposeVenomCanonTeachingResponse,
  UpdateVenomCanonTeachingBody,
  UpdateVenomCanonTeachingResponse,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  canonAccessDeniedBody,
  grantSuperAdmin,
  isSuperAdmin,
  listSuperAdmins,
  revokeSuperAdmin,
} from "../lib/venom-super-admins";
import {
  CanonCapacityError,
  insertCanonTeaching,
  listCanonTeachings,
  updateCanonTeaching,
  type CanonTeachingRecord,
} from "../lib/venom-canon-store";
import {
  CANON_DISTILL_PROMPT,
  canonAcknowledgment,
  normalizeCanonDraft,
  teachIntentGate,
} from "../lib/venom-canon-teaching";
import {
  identityDisplayLabel,
  resolveVenomIdentities,
  resolveVenomIdentity,
} from "../lib/venom-identity";

const router: IRouter = Router();

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// Test seams (auth, account directory, distiller), NODE_ENV=test only
// ---------------------------------------------------------------------------

type UserIdResolver = (request: Request) => string | null;
let testUserIdResolver: UserIdResolver | null = null;

function userIdFor(request: Request): string | null {
  if (testUserIdResolver) return testUserIdResolver(request);
  return getAuth(request).userId;
}

export function overrideCanonUserIdResolverForTests(
  resolver: UserIdResolver,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Canon auth overrides are available only in tests");
  }
  const previous = testUserIdResolver;
  testUserIdResolver = resolver;
  return () => {
    testUserIdResolver = previous;
  };
}

export type CanonAccountDirectory = {
  /** Resolve one account; null when no such account exists. */
  getUser: (userId: string) => Promise<{ id: string } | null>;
};

function isClerkMissingUser(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 400 || status === 422;
}

const clerkAccountDirectory: CanonAccountDirectory = {
  async getUser(userId) {
    try {
      const user = await clerkClient.users.getUser(userId);
      return { id: user.id };
    } catch (error) {
      if (isClerkMissingUser(error)) return null;
      throw error;
    }
  },
};

let accountDirectory: CanonAccountDirectory = clerkAccountDirectory;

export function overrideCanonAccountDirectoryForTests(
  directory: CanonAccountDirectory,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Canon directory overrides are available only in tests");
  }
  const previous = accountDirectory;
  accountDirectory = directory;
  return () => {
    accountDirectory = previous;
  };
}

/** Raw JSON-mode completion for the distiller; injectable for tests. */
type CanonDistillComplete = (message: string) => Promise<string | null>;

const defaultDistillComplete: CanonDistillComplete = async (message) => {
  const completion = await openai.chat.completions.create({
    model: "gpt-5.6-terra",
    max_completion_tokens: 900,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: CANON_DISTILL_PROMPT },
      { role: "user", content: message },
    ],
  });
  return completion.choices[0]?.message?.content ?? null;
};

let distillComplete: CanonDistillComplete = defaultDistillComplete;

export function overrideCanonDistillCompleteForTests(
  complete: CanonDistillComplete,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Canon distiller overrides are available only in tests");
  }
  const previous = distillComplete;
  distillComplete = complete;
  return () => {
    distillComplete = previous;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The one gate in front of every canon route: authenticated AND currently
 * designated. Returns the caller's user id, or null after writing the
 * refusal (401 for missing auth, the opaque canon body for everyone else).
 */
async function requireSuperAdmin(
  req: Request,
  res: Parameters<typeof canonRefusal>[0],
): Promise<string | null> {
  const userId = userIdFor(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (!(await isSuperAdmin(userId))) {
    canonRefusal(res);
    return null;
  }
  return userId;
}

function canonRefusal(res: {
  status: (code: number) => { json: (body: unknown) => unknown };
}): void {
  res.status(403).json(canonAccessDeniedBody());
}

async function teachingResponse(
  records: CanonTeachingRecord[],
): Promise<Array<Record<string, unknown>>> {
  // Names are cosmetic provenance; the listing must not depend on the
  // identity directory being reachable.
  let identities = new Map<
    string,
    Awaited<ReturnType<typeof resolveVenomIdentity>>
  >();
  try {
    identities = await resolveVenomIdentities([
      ...new Set(records.map((record) => record.taughtByClerkUserId)),
    ]);
  } catch {
    identities = new Map();
  }
  return records.map((record) => ({
    id: record.id,
    domain: record.domain,
    title: record.title,
    principles: record.principles,
    status: record.status,
    taughtByUserId: record.taughtByClerkUserId,
    taughtByName:
      identityDisplayLabel(identities.get(record.taughtByClerkUserId)) ?? null,
    conversationTitle: record.conversationTitle,
    taughtAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  }));
}

// In-process propose rate limit: teaching is a deliberate act, not a hot
// path; the distiller call is the expensive part being protected.
const PROPOSE_RATE_LIMIT_MAX = 12;
const PROPOSE_RATE_LIMIT_WINDOW_MS = 60_000;
const proposeRateLimits = new Map<string, { count: number; resetAt: number }>();

function proposeRateLimited(userId: string): number | null {
  const now = Date.now();
  const current = proposeRateLimits.get(userId);
  if (!current || current.resetAt <= now) {
    proposeRateLimits.set(userId, {
      count: 1,
      resetAt: now + PROPOSE_RATE_LIMIT_WINDOW_MS,
    });
    return null;
  }
  if (current.count >= PROPOSE_RATE_LIMIT_MAX) {
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  }
  current.count += 1;
  return null;
}

const DISTILL_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Teachings
// ---------------------------------------------------------------------------

router.get("/venom/canon/teachings", async (req, res): Promise<void> => {
  const userId = await requireSuperAdmin(req, res);
  if (!userId) return;
  try {
    const records = await listCanonTeachings();
    res.json(ListVenomCanonTeachingsResponse.parse(await teachingResponse(records)));
  } catch (error) {
    req.log.error({ err: error }, "Venom canon listing failed");
    res.status(500).json({ error: "Canon unavailable" });
  }
});

router.post("/venom/canon/teachings", async (req, res): Promise<void> => {
  const userId = await requireSuperAdmin(req, res);
  if (!userId) return;

  const parsed = CommitVenomCanonTeachingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid teaching" });
    return;
  }
  // Commit is authoritative: the confirmed draft passes through the same
  // normalize → bound → validate contract as the distiller output, so a
  // hand-edited or replayed body can never exceed the draft bounds.
  const draft = normalizeCanonDraft({ teach: true, ...parsed.data });
  if (!draft) {
    res.status(400).json({ error: "Invalid teaching" });
    return;
  }

  try {
    // Put the teacher on record (created on first authenticated use) so
    // provenance can resolve to a name later.
    try {
      await resolveVenomIdentity(userId);
    } catch {
      // Identity refresh must never block a teaching; storage failures
      // would surface from the insert below anyway.
    }
    const record = await insertCanonTeaching({
      domain: draft.domain,
      title: draft.title,
      principles: draft.principles,
      taughtByClerkUserId: userId,
      conversationId: parsed.data.conversationId ?? null,
      conversationTitle: parsed.data.conversationTitle ?? null,
    });
    const [teaching] = await teachingResponse([record]);
    res.status(201).json(
      CommitVenomCanonTeachingResponse.parse({
        teaching,
        acknowledgment: canonAcknowledgment(draft),
      }),
    );
  } catch (error) {
    if (error instanceof CanonCapacityError) {
      res.status(409).json({ error: "The canon is at capacity." });
      return;
    }
    req.log.error({ err: error }, "Venom canon commit failed");
    res.status(500).json({ error: "Canon unavailable" });
  }
});

router.patch(
  "/venom/canon/teachings/:teachingId",
  async (req, res): Promise<void> => {
    const userId = await requireSuperAdmin(req, res);
    if (!userId) return;

    const teachingId = req.params.teachingId;
    if (typeof teachingId !== "string" || !UUID_PATTERN.test(teachingId)) {
      res.status(404).json({ error: "No teaching with this id" });
      return;
    }
    const parsed = UpdateVenomCanonTeachingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid update" });
      return;
    }

    // Re-normalize any supplied content field with the same bounds as a
    // fresh draft; an edit that normalizes to nothing is refused rather
    // than silently dropped.
    const patch: {
      domain?: string;
      title?: string;
      principles?: string[];
      status?: "active" | "retired";
    } = {};
    if (
      parsed.data.domain !== undefined ||
      parsed.data.title !== undefined ||
      parsed.data.principles !== undefined
    ) {
      const normalized = normalizeCanonDraft({
        teach: true,
        domain: parsed.data.domain ?? "placeholder",
        title: parsed.data.title ?? "placeholder",
        principles: parsed.data.principles ?? ["placeholder"],
      });
      if (!normalized) {
        res.status(400).json({ error: "Invalid update" });
        return;
      }
      if (parsed.data.domain !== undefined) patch.domain = normalized.domain;
      if (parsed.data.title !== undefined) patch.title = normalized.title;
      if (parsed.data.principles !== undefined) {
        patch.principles = normalized.principles;
      }
    }
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Invalid update" });
      return;
    }

    try {
      const record = await updateCanonTeaching({
        id: teachingId,
        patch,
        editorUserId: userId,
      });
      if (!record) {
        res.status(404).json({ error: "No teaching with this id" });
        return;
      }
      const [teaching] = await teachingResponse([record]);
      res.json(UpdateVenomCanonTeachingResponse.parse(teaching));
    } catch (error) {
      req.log.error({ err: error }, "Venom canon update failed");
      res.status(500).json({ error: "Canon unavailable" });
    }
  },
);

// ---------------------------------------------------------------------------
// Propose (teach-intent detection + distillation; stores nothing)
// ---------------------------------------------------------------------------

router.post("/venom/canon/propose", async (req, res): Promise<void> => {
  const userId = await requireSuperAdmin(req, res);
  if (!userId) return;

  const parsed = ProposeVenomCanonTeachingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid proposal request" });
    return;
  }

  const retryAfter = proposeRateLimited(userId);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", retryAfter);
    res.status(429).json({ error: "Too many proposal requests" });
    return;
  }
  if (proposeRateLimits.size > 1_000) {
    const now = Date.now();
    for (const [key, limit] of proposeRateLimits) {
      if (limit.resetAt <= now) proposeRateLimits.delete(key);
    }
  }

  const noIntent = () =>
    res.json(ProposeVenomCanonTeachingResponse.parse({ teachIntent: false }));

  if (!teachIntentGate(parsed.data.message)) {
    noIntent();
    return;
  }

  // One tiny JSON-only distillation call; every failure — timeout, junk
  // output, provider error — fails open to an ordinary chat turn.
  try {
    const raw = await Promise.race([
      distillComplete(parsed.data.message),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("canon distillation timed out")),
          DISTILL_TIMEOUT_MS,
        ).unref?.();
      }),
    ]);
    if (!raw) {
      noIntent();
      return;
    }
    let json: unknown;
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("no JSON object");
      json = JSON.parse(raw.slice(start, end + 1));
    } catch {
      req.log.warn("Venom canon distillation returned invalid JSON");
      noIntent();
      return;
    }
    const draft = normalizeCanonDraft(json);
    if (!draft) {
      noIntent();
      return;
    }
    res.json(
      ProposeVenomCanonTeachingResponse.parse({ teachIntent: true, draft }),
    );
  } catch (error) {
    req.log.warn({ err: error }, "Venom canon distillation failed");
    noIntent();
  }
});

// ---------------------------------------------------------------------------
// Stewardship (grant / revoke / list admins)
// ---------------------------------------------------------------------------

router.get("/venom/canon/admins", async (req, res): Promise<void> => {
  const userId = await requireSuperAdmin(req, res);
  if (!userId) return;
  try {
    const rows = await listSuperAdmins();
    let identities = new Map<
      string,
      Awaited<ReturnType<typeof resolveVenomIdentity>>
    >();
    try {
      identities = await resolveVenomIdentities(
        rows.map((row) => row.clerkUserId),
      );
    } catch {
      identities = new Map();
    }
    res.json(
      ListVenomCanonAdminsResponse.parse(
        rows.map((row) => ({
          userId: row.clerkUserId,
          name: identityDisplayLabel(identities.get(row.clerkUserId)) ?? null,
          grantedByUserId: row.grantedByClerkUserId,
          grantedAt: row.createdAt.toISOString(),
        })),
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Venom canon admin listing failed");
    res.status(500).json({ error: "Canon unavailable" });
  }
});

router.post("/venom/canon/admins", async (req, res): Promise<void> => {
  const userId = await requireSuperAdmin(req, res);
  if (!userId) return;

  const parsed = GrantVenomCanonAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "No account with this id" });
    return;
  }

  try {
    // Fail closed: only accounts the directory can confirm may be granted
    // the role — a typo must not create a dangling designation.
    let account: { id: string } | null = null;
    try {
      account = await accountDirectory.getUser(parsed.data.userId);
    } catch (error) {
      req.log.error({ err: error }, "Venom canon grant directory check failed");
      res.status(502).json({ error: "The account directory is unavailable. Try again." });
      return;
    }
    if (!account) {
      res.status(400).json({ error: "No account with this id" });
      return;
    }

    const result = await grantSuperAdmin({
      targetUserId: account.id,
      grantedByUserId: userId,
    });
    if (result.outcome === "already_admin") {
      res.status(409).json({ error: "Already a super admin" });
      return;
    }
    // Put the new admin on record so the listing can show a name.
    try {
      await resolveVenomIdentity(account.id);
    } catch {
      // Cosmetic only.
    }
    let identities = new Map<
      string,
      Awaited<ReturnType<typeof resolveVenomIdentity>>
    >();
    try {
      identities = await resolveVenomIdentities([account.id]);
    } catch {
      identities = new Map();
    }
    res.status(201).json(
      GrantVenomCanonAdminResponse.parse({
        userId: result.row.clerkUserId,
        name: identityDisplayLabel(identities.get(account.id)) ?? null,
        grantedByUserId: result.row.grantedByClerkUserId,
        grantedAt: result.row.createdAt.toISOString(),
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Venom canon grant failed");
    res.status(500).json({ error: "Canon unavailable" });
  }
});

router.delete(
  "/venom/canon/admins/:adminUserId",
  async (req, res): Promise<void> => {
    const userId = await requireSuperAdmin(req, res);
    if (!userId) return;

    const target = req.params.adminUserId;
    if (typeof target !== "string" || target.length === 0 || target.length > 120) {
      res.status(404).json({ error: "That account is not a super admin" });
      return;
    }

    try {
      const outcome = await revokeSuperAdmin({
        targetUserId: target,
        actorUserId: userId,
      });
      switch (outcome) {
        case "revoked":
          res.status(204).end();
          return;
        case "self_revocation":
          res
            .status(400)
            .json({ error: "You cannot revoke your own super admin role" });
          return;
        case "not_admin":
          res.status(404).json({ error: "That account is not a super admin" });
          return;
        case "last_admin":
          res
            .status(409)
            .json({ error: "The last super admin cannot be removed" });
          return;
      }
    } catch (error) {
      req.log.error({ err: error }, "Venom canon revoke failed");
      res.status(500).json({ error: "Canon unavailable" });
    }
  },
);

export default router;
