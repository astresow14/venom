/**
 * Persistence and refresh orchestration for the bonded host persona.
 *
 * One bounded row per owner (mirroring the ontology store's owner scoping)
 * holds the validated style profile plus the material counters that drive
 * bond depth. Refreshes are periodic and cheap: the chat route absorbs one
 * message per request, and a refresh only runs when `shouldRefreshProfile`
 * says enough new material accumulated — claimed via an optimistic
 * `lastRefreshAt` compare-and-set so concurrent requests never double-spend
 * a model call.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  venomHostProfilesTable,
  venomOntologyConceptsTable,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import { userOwner, type OntologyOwner } from "./venom-ontology-store";
import {
  bondLevelFor,
  buildIdentityDigest,
  buildProfileExtractionInput,
  HOST_PROFILE_EXTRACTION_PROMPT,
  normalizeHostProfile,
  readStoredHostProfile,
  shouldRefreshProfile,
  type BondLevel,
  type BondMaterial,
  type HostStyleProfile,
  type IdentityDigestEntry,
} from "./venom-persona";

/** Long pastes must not inflate the bond; a message contributes at most this. */
const ABSORB_CHARS_PER_MESSAGE_CAP = 2_000;

const DIGEST_OVERALL_LIMIT = 6;
const DIGEST_PROJECT_LIMIT = 4;
/** Concepts weaker than this are noise, not identity. */
const DIGEST_MIN_STRENGTH = 0.2;

type PersonaLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

export type HostPersonaContext = {
  profile: HostStyleProfile | null;
  bondLevel: BondLevel;
  material: BondMaterial;
  identityDigest: string;
};

function ownerFilter(owner: OntologyOwner) {
  return and(
    eq(venomHostProfilesTable.ownerType, owner.ownerType),
    eq(venomHostProfilesTable.ownerId, owner.ownerId),
  );
}

// ---------------------------------------------------------------------------
// Answer-time context
// ---------------------------------------------------------------------------

/**
 * Everything the chat route needs to compose the symbiote prompt: stored
 * profile, bond material, and the strongest concepts from the host's
 * ontology (overall identity plus anchors scoped to the active project).
 */
export async function loadHostPersonaContext(
  userId: string,
  activeProjectId: string | null,
): Promise<HostPersonaContext> {
  const owner = userOwner(userId);

  const [profileRows, overallRows, projectRows] = await Promise.all([
    db
      .select()
      .from(venomHostProfilesTable)
      .where(ownerFilter(owner))
      .limit(1),
    db
      .select({
        conceptId: venomOntologyConceptsTable.conceptId,
        projectId: venomOntologyConceptsTable.projectId,
        label: venomOntologyConceptsTable.label,
        category: venomOntologyConceptsTable.category,
        summary: venomOntologyConceptsTable.summary,
        strength: venomOntologyConceptsTable.strength,
      })
      .from(venomOntologyConceptsTable)
      .where(
        and(
          eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
          eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
          sql`${venomOntologyConceptsTable.strength} >= ${DIGEST_MIN_STRENGTH}`,
        ),
      )
      .orderBy(
        sql`${venomOntologyConceptsTable.strength} DESC`,
        sql`${venomOntologyConceptsTable.lastUpdatedAt} DESC`,
      )
      .limit(DIGEST_OVERALL_LIMIT),
    activeProjectId
      ? db
          .select({
            conceptId: venomOntologyConceptsTable.conceptId,
            projectId: venomOntologyConceptsTable.projectId,
            label: venomOntologyConceptsTable.label,
            category: venomOntologyConceptsTable.category,
            summary: venomOntologyConceptsTable.summary,
            strength: venomOntologyConceptsTable.strength,
          })
          .from(venomOntologyConceptsTable)
          .where(
            and(
              eq(venomOntologyConceptsTable.ownerType, owner.ownerType),
              eq(venomOntologyConceptsTable.ownerId, owner.ownerId),
              eq(venomOntologyConceptsTable.projectId, activeProjectId),
              sql`${venomOntologyConceptsTable.strength} >= ${DIGEST_MIN_STRENGTH}`,
            ),
          )
          .orderBy(
            sql`${venomOntologyConceptsTable.strength} DESC`,
            sql`${venomOntologyConceptsTable.lastUpdatedAt} DESC`,
          )
          .limit(DIGEST_PROJECT_LIMIT)
      : Promise.resolve([]),
  ]);

  const row = profileRows[0];
  const material: BondMaterial = {
    messageCount: row?.absorbedMessageCount ?? 0,
    charCount: row?.absorbedCharCount ?? 0,
  };

  const seen = new Set<string>();
  const entries: IdentityDigestEntry[] = [];
  for (const concept of [...overallRows, ...projectRows]) {
    if (seen.has(concept.conceptId)) continue;
    seen.add(concept.conceptId);
    entries.push({
      label: concept.label,
      category: concept.category,
      summary: concept.summary,
      strength: concept.strength,
      inActiveProject:
        activeProjectId !== null && concept.projectId === activeProjectId,
    });
  }
  entries.sort((a, b) => b.strength - a.strength);

  return {
    profile: row ? readStoredHostProfile(row.profile) : null,
    bondLevel: bondLevelFor(material),
    material,
    identityDigest: buildIdentityDigest(entries),
  };
}

// ---------------------------------------------------------------------------
// Absorption + periodic refresh
// ---------------------------------------------------------------------------

async function deriveProfileFromMessages(
  recentUserMessages: string[],
  previousProfile: HostStyleProfile | null,
): Promise<HostStyleProfile | null> {
  const completion = await openai.chat.completions.create({
    model: "gpt-5.6-terra",
    max_completion_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: HOST_PROFILE_EXTRACTION_PROMPT },
      {
        role: "user",
        content: buildProfileExtractionInput(
          recentUserMessages,
          previousProfile,
        ),
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return normalizeHostProfile(parsed);
}

/**
 * Count one host message into the bond and, when due, refresh the profile
 * from the request's own recent user messages. Fire-and-forget from the
 * chat route: every failure is contained here and only ever logged — the
 * bond deepening must never break or slow a chat response.
 */
export async function absorbHostMessage(input: {
  userId: string;
  messageChars: number;
  recentUserMessages: string[];
  log: PersonaLogger;
  now?: number;
  /** Test seam: replaces the model call. */
  derive?: (
    messages: string[],
    previous: HostStyleProfile | null,
  ) => Promise<HostStyleProfile | null>;
}): Promise<"absorbed" | "refreshed" | "refresh_failed"> {
  const owner = userOwner(input.userId);
  const now = input.now ?? Date.now();
  const chars = Math.max(
    0,
    Math.min(Math.floor(input.messageChars), ABSORB_CHARS_PER_MESSAGE_CAP),
  );

  const [row] = await db
    .insert(venomHostProfilesTable)
    .values({
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      absorbedMessageCount: 1,
      absorbedCharCount: chars,
    })
    .onConflictDoUpdate({
      target: [
        venomHostProfilesTable.ownerType,
        venomHostProfilesTable.ownerId,
      ],
      set: {
        absorbedMessageCount: sql`${venomHostProfilesTable.absorbedMessageCount} + 1`,
        absorbedCharCount: sql`${venomHostProfilesTable.absorbedCharCount} + ${chars}`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const previousProfile = readStoredHostProfile(row.profile);
  const due = shouldRefreshProfile({
    material: {
      messageCount: row.absorbedMessageCount,
      charCount: row.absorbedCharCount,
    },
    profiledMessageCount: row.profiledMessageCount,
    hasProfile: previousProfile !== null,
    lastRefreshAt: row.lastRefreshAt,
    now,
  });
  if (!due) return "absorbed";

  // Optimistic claim: only one concurrent request wins the refresh slot.
  const claimed = await db
    .update(venomHostProfilesTable)
    .set({ lastRefreshAt: now })
    .where(
      and(
        ownerFilter(owner),
        eq(venomHostProfilesTable.lastRefreshAt, row.lastRefreshAt),
      ),
    )
    .returning({ ownerId: venomHostProfilesTable.ownerId });
  if (claimed.length === 0) return "absorbed";

  try {
    const derive = input.derive ?? deriveProfileFromMessages;
    const profile = await derive(input.recentUserMessages, previousProfile);
    if (!profile) {
      input.log.warn(
        { hadProfile: previousProfile !== null },
        "Venom host profile refresh produced no usable profile",
      );
      return "refresh_failed";
    }
    await db
      .update(venomHostProfilesTable)
      .set({
        profile,
        profiledMessageCount: row.absorbedMessageCount,
        updatedAt: sql`now()`,
      })
      .where(ownerFilter(owner));
    input.log.info(
      {
        bondMessages: row.absorbedMessageCount,
        firstProfile: previousProfile === null,
      },
      "Venom host profile refreshed",
    );
    return "refreshed";
  } catch (error) {
    // The claim already advanced lastRefreshAt, so the next attempt waits
    // out the cooldown instead of hammering a failing provider.
    input.log.warn({ err: error }, "Venom host profile refresh failed");
    return "refresh_failed";
  }
}
