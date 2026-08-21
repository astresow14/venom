/**
 * Live verification harness for the bonded symbiote persona (dev-only).
 *
 * Seeds a fresh host and a deeply bonded host (style profile + Brain
 * concepts), composes both system prompts through the real persona layer,
 * and completes real provider calls so the voice difference and the
 * knowledge-grounded pushback can be inspected. Seeded rows are removed at
 * the end. Uses only synthetic data — never real user content.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run verify:bonded-persona
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  venomHostProfilesTable,
  venomOntologyConceptsTable,
} from "@workspace/db";
import { loadHostPersonaContext } from "../lib/venom-host-profile-store";
import {
  composeSymbiotePrompt,
  HOST_PROFILE_VERSION,
} from "../lib/venom-persona";
import { buildVenomCatalog, type VenomModelId } from "../lib/venom-models";
import {
  streamVenomResponse,
  type VenomMessage,
} from "../lib/venom-provider-adapters";

const freshUserId = `personaverify_fresh_${randomUUID()}`;
const bondedUserId = `personaverify_bonded_${randomUUID()}`;
const PROJECT_ID = "proj_persona_demo";

async function complete(
  modelId: VenomModelId,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const messages: VenomMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  let text = "";
  try {
    for await (const token of streamVenomResponse(
      modelId,
      messages,
      controller.signal,
    )) {
      text += token;
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

async function seedBondedHost() {
  await db.insert(venomHostProfilesTable).values({
    ownerType: "user",
    ownerId: bondedUserId,
    profile: {
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
      slangTerms: ["ngl", "fr", "lowkey"],
      signaturePhrases: ["ship it", "lets go"],
      quirks: ["skips greetings", "asks in fragments"],
      attitude: "Impatient builder; wants the fastest working path, hates ceremony.",
    },
    absorbedMessageCount: 120,
    absorbedCharCount: 14_000,
    profiledMessageCount: 118,
    lastRefreshAt: Date.now(),
  });

  const base = {
    ownerType: "user",
    ownerId: bondedUserId,
    description: null,
    mentionCount: 6,
    x: 0,
    y: 0,
    lastUpdatedAt: Date.now(),
  };
  await db.insert(venomOntologyConceptsTable).values([
    {
      ...base,
      conceptId: "cluster_verify_checkout",
      projectId: PROJECT_ID,
      label: "Single-Page Checkout",
      normalizedLabel: "single-page checkout",
      category: "decision",
      summary: "Team locked checkout to one page after cart-abandonment data",
      strength: 0.95,
    },
    {
      ...base,
      conceptId: "cluster_verify_latency",
      projectId: PROJECT_ID,
      label: "Latency Budget",
      normalizedLabel: "latency budget",
      category: "risk",
      summary: "p95 must stay under 2 seconds on checkout routes",
      strength: 0.85,
    },
    {
      ...base,
      conceptId: "cluster_verify_stripe",
      projectId: "proj_other",
      label: "Stripe Migration",
      normalizedLabel: "stripe migration",
      category: "project",
      summary: "Payments moving to Stripe by end of quarter",
      strength: 0.75,
    },
  ]);
}

async function cleanup() {
  for (const userId of [freshUserId, bondedUserId]) {
    await db
      .delete(venomHostProfilesTable)
      .where(eq(venomHostProfilesTable.ownerId, userId));
    await db
      .delete(venomOntologyConceptsTable)
      .where(eq(venomOntologyConceptsTable.ownerId, userId));
  }
}

async function main() {
  const catalog = buildVenomCatalog();
  const liveModels = catalog
    .filter((model) => model.available && model.id !== "venom-claude")
    .map((model) => model.id)
    .filter((id): id is VenomModelId => id === "venom-gpt" || id === "venom-grok");

  console.log(`Live models under test: ${liveModels.join(", ") || "none"}\n`);

  // ── Fresh account: neutral but directive ─────────────────────────────────
  const freshContext = await loadHostPersonaContext(freshUserId, PROJECT_ID);
  const freshPrompt = composeSymbiotePrompt(freshContext);
  console.log("FRESH context:", {
    profile: freshContext.profile,
    bond: freshContext.bondLevel,
    digestChars: freshContext.identityDigest.length,
  });
  if (
    freshPrompt.includes("<host_style>") ||
    freshPrompt.includes("<host_knowledge>")
  ) {
    throw new Error("fresh prompt unexpectedly carries persona layers");
  }
  if (!freshPrompt.includes("Lead with your verdict")) {
    throw new Error("fresh prompt lost the directive posture");
  }

  // ── Bonded account: style + knowledge grounded ───────────────────────────
  await seedBondedHost();
  const bondedContext = await loadHostPersonaContext(bondedUserId, PROJECT_ID);
  const bondedPrompt = composeSymbiotePrompt(bondedContext);
  console.log("BONDED context:", {
    bond: bondedContext.bondLevel,
    slang: bondedContext.profile?.slangTerms,
    digest: bondedContext.identityDigest,
  });
  if (bondedContext.bondLevel.level !== 4) {
    throw new Error(`expected bond level 4, got ${bondedContext.bondLevel.level}`);
  }
  if (!bondedPrompt.includes("<host_style>")) {
    throw new Error("bonded prompt is missing the style layer");
  }
  if (!bondedPrompt.includes("Single-Page Checkout")) {
    throw new Error("bonded prompt is missing the identity digest");
  }

  const question =
    "im thinking about splitting checkout into a second page for gift cards, quick take?";

  for (const modelId of liveModels) {
    console.log(`\n================ ${modelId} — FRESH host ================`);
    console.log(await complete(modelId, freshPrompt, question));
    console.log(`\n================ ${modelId} — BONDED host ================`);
    console.log(await complete(modelId, bondedPrompt, question));
  }
}

main()
  .then(async () => {
    await cleanup();
    await pool.end();
    console.log("\nverify-bonded-persona: done");
  })
  .catch(async (error) => {
    console.error("verify-bonded-persona failed:", error);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
