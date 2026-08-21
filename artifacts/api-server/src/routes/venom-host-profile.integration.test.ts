/**
 * Real-database integration tests for the bonded persona store: absorption
 * counters, the periodic refresh claim, profile round-trips, and the
 * Brain-fed identity digest.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  venomHostProfilesTable,
  venomOntologyConceptsTable,
} from "@workspace/db";
import {
  absorbHostMessage,
  loadHostPersonaContext,
} from "../lib/venom-host-profile-store";
import {
  HOST_PROFILE_VERSION,
  type HostStyleProfile,
} from "../lib/venom-persona";

const testUserIds: string[] = [];

function freshUserId(): string {
  const userId = `personatest_${randomUUID()}`;
  testUserIds.push(userId);
  return userId;
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function stubProfile(overrides: Partial<HostStyleProfile> = {}): HostStyleProfile {
  return {
    version: HOST_PROFILE_VERSION,
    casing: "lowercase",
    punctuation: "minimal",
    sentenceLength: "short",
    formality: "casual",
    energy: "high",
    directness: "blunt",
    usesEmoji: false,
    usesSlang: true,
    hasProfanity: false,
    slangTerms: ["ngl"],
    signaturePhrases: ["ship it"],
    quirks: ["skips greetings"],
    attitude: "Fast, impatient, allergic to ceremony.",
    ...overrides,
  };
}

async function cleanup() {
  for (const userId of testUserIds) {
    await db
      .delete(venomHostProfilesTable)
      .where(eq(venomHostProfilesTable.ownerId, userId));
    await db
      .delete(venomOntologyConceptsTable)
      .where(eq(venomOntologyConceptsTable.ownerId, userId));
  }
}

test.after(async () => {
  await cleanup();
  await pool.end();
});

test("absorbing messages creates the row and counts material", async () => {
  const userId = freshUserId();
  const first = await absorbHostMessage({
    userId,
    messageChars: 120,
    recentUserMessages: ["hello there"],
    log: silentLog,
    now: 10_000_000,
    derive: async () => {
      throw new Error("must not derive below the material minimum");
    },
  });
  assert.equal(first, "absorbed");

  // A giant paste contributes at most the per-message cap.
  await absorbHostMessage({
    userId,
    messageChars: 50_000,
    recentUserMessages: ["big paste"],
    log: silentLog,
    now: 10_001_000,
    derive: async () => {
      throw new Error("must not derive below the material minimum");
    },
  });

  const context = await loadHostPersonaContext(userId, null);
  assert.equal(context.material.messageCount, 2);
  assert.equal(context.material.charCount, 120 + 2_000);
  assert.equal(context.profile, null);
  assert.equal(context.bondLevel.level, 0);
});

test("a due refresh derives, validates, and stores the profile", async () => {
  const userId = freshUserId();
  let deriveCalls = 0;
  const now = 20_000_000;
  for (let index = 0; index < 3; index++) {
    await absorbHostMessage({
      userId,
      messageChars: 300,
      recentUserMessages: ["msg a", "msg b", "msg c"],
      log: silentLog,
      now: now + index,
      derive: async (messages, previous) => {
        deriveCalls += 1;
        assert.equal(previous, null);
        assert.ok(messages.length > 0);
        // Raw model output: normalizeHostProfile must clean this up.
        return {
          ...stubProfile(),
          slangTerms: ["ngl", "see http://spam.example", "fr"],
        } as HostStyleProfile;
      },
    });
  }
  assert.equal(deriveCalls, 1, "only the third message triggers a refresh");

  const context = await loadHostPersonaContext(userId, null);
  assert.ok(context.profile);
  assert.deepEqual(context.profile.slangTerms, ["ngl", "fr"]);
  assert.equal(context.bondLevel.level, 1);

  const [row] = await db
    .select()
    .from(venomHostProfilesTable)
    .where(eq(venomHostProfilesTable.ownerId, userId));
  assert.equal(row.profiledMessageCount, 3);
  assert.equal(row.lastRefreshAt, now + 2);
});

test("concurrent due absorptions refresh exactly once", async () => {
  const userId = freshUserId();
  // Seed enough material that the next absorption is due.
  for (let index = 0; index < 3; index++) {
    await absorbHostMessage({
      userId,
      messageChars: 300,
      recentUserMessages: ["seed"],
      log: silentLog,
      now: 1_000, // inside cooldown → no refresh while seeding
      derive: async () => stubProfile(),
    });
  }

  let deriveCalls = 0;
  const results = await Promise.all([
    absorbHostMessage({
      userId,
      messageChars: 200,
      recentUserMessages: ["one"],
      log: silentLog,
      now: 30_000_000,
      derive: async () => {
        deriveCalls += 1;
        return stubProfile();
      },
    }),
    absorbHostMessage({
      userId,
      messageChars: 200,
      recentUserMessages: ["two"],
      log: silentLog,
      now: 30_000_001,
      derive: async () => {
        deriveCalls += 1;
        return stubProfile();
      },
    }),
  ]);

  assert.equal(deriveCalls, 1, "the optimistic claim admits one refresh");
  assert.ok(results.includes("refreshed"));
});

test("a failed derivation keeps the old profile and advances the cooldown", async () => {
  const userId = freshUserId();
  const now = 40_000_000;
  let result: Awaited<ReturnType<typeof absorbHostMessage>> = "absorbed";
  for (let index = 0; index < 3; index++) {
    result = await absorbHostMessage({
      userId,
      messageChars: 300,
      recentUserMessages: ["msg"],
      log: silentLog,
      now: now + index,
      derive: async () => null,
    });
  }
  assert.equal(result, "refresh_failed");

  const [row] = await db
    .select()
    .from(venomHostProfilesTable)
    .where(eq(venomHostProfilesTable.ownerId, userId));
  assert.equal(row.profile, null);
  assert.equal(row.profiledMessageCount, 0);
  assert.equal(row.lastRefreshAt, now + 2, "claim advanced the cooldown gate");
});

test("the identity digest surfaces the strongest concepts with project scope", async () => {
  const userId = freshUserId();
  const baseConcept = {
    ownerType: "user",
    ownerId: userId,
    summary: "",
    description: null,
    mentionCount: 3,
    x: 0,
    y: 0,
    lastUpdatedAt: 1_000,
  };
  await db.insert(venomOntologyConceptsTable).values([
    {
      ...baseConcept,
      conceptId: "cluster_persona_a",
      projectId: "proj_alpha",
      label: "Checkout Rework",
      normalizedLabel: "checkout rework",
      category: "feature",
      summary: "Move checkout to one page",
      strength: 0.95,
    },
    {
      ...baseConcept,
      conceptId: "cluster_persona_b",
      projectId: "proj_beta",
      label: "Latency Budget",
      normalizedLabel: "latency budget",
      category: "risk",
      summary: "p95 under 2 seconds",
      strength: 0.8,
    },
    {
      ...baseConcept,
      conceptId: "cluster_persona_weak",
      projectId: "proj_alpha",
      label: "Faded Idea",
      normalizedLabel: "faded idea",
      category: "topic",
      summary: "Barely mentioned",
      strength: 0.05,
    },
  ]);

  const context = await loadHostPersonaContext(userId, "proj_alpha");
  assert.ok(
    context.identityDigest.includes("Checkout Rework (feature, this project)"),
  );
  assert.ok(context.identityDigest.includes("Latency Budget (risk)"));
  assert.ok(
    !context.identityDigest.includes("Faded Idea"),
    "weak concepts stay out of the digest",
  );
  const alphaIndex = context.identityDigest.indexOf("Checkout Rework");
  const betaIndex = context.identityDigest.indexOf("Latency Budget");
  assert.ok(alphaIndex < betaIndex, "strongest first");
});
