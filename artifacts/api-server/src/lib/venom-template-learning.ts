/**
 * Template learning: turns edits people make to template-derived build
 * packages into de-identified, per-template signals, and feeds the
 * above-threshold aggregate back into generation as bounded reference data.
 *
 * This tier rides the master ontology's machinery end to end:
 *
 * - Consent: signals are recorded only for tenants whose master-ontology
 *   contribution setting is on, re-checked inside a transaction holding the
 *   same per-tenant advisory lock the master tier uses, so a contribution
 *   cannot race an opt-out.
 * - De-identification: the ONLY content that can be recorded is a signal
 *   key from the compiled-in closed vocabulary below. Raw requirement or
 *   instruction text never leaves this module — free text is only ever
 *   regex-matched against the vocabulary's patterns, and the signal table
 *   has no columns for text, run ids, revision ids, or app ids.
 * - Anonymity threshold: aggregates are rebuilt by the master rebuild fence
 *   and keep only (template, signal) pairs seen across at least
 *   MASTER_MIN_DISTINCT_TENANTS distinct tenants. Below-threshold signals
 *   have no read path anywhere.
 * - Revocation: opting out of master contribution deletes the tenant's
 *   template edit signals in the same locked transaction as its ontology
 *   signals, and the shared rebuild removes their influence.
 *
 * Reads are additionally structurally safe: a stored key is looked up in
 * the compiled vocabulary and only the compiled title/guidance strings are
 * emitted, so even a hand-poisoned row could never surface its own text.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  venomTemplateEditSignalsTable,
  venomTemplateGuidanceTable,
  venomMasterContributionSettingsTable,
} from "@workspace/db";
import type { VenomBuildPackage } from "@workspace/api-zod";
import {
  isMasterContributionEnabled,
  MASTER_MIN_DISTINCT_TENANTS,
  rebuildMasterAggregates,
  withTenantMasterLock,
  type MasterTenant,
} from "./venom-master-ontology";

export const TEMPLATE_LEARNING_BOUNDS = {
  /** Max distinct signal keys recorded per approval event. */
  signalsPerApproval: 16,
  /** Max instruction strings scanned per approval event. */
  instructionsScanned: 8,
  /** Chars of each instruction the theme classifier considers. */
  instructionScanChars: 4_000,
  /** Max guidance entries injected into a generation or surfaced anywhere. */
  guidancePerTemplate: 8,
} as const;

type VocabularyEntry = {
  /** Short, human-readable name shown in run events and review surfaces. */
  title: string;
  /** One-sentence lesson injected into generation as reference data. */
  guidance: string;
};

/**
 * Structural-delta keys: which package sections reviewers changed between
 * the first generated revision and the one they approved. One key per
 * section per approval at most.
 */
const DELTA_VOCABULARY: Record<string, VocabularyEntry> = {
  scope_expanded: {
    title: "Scope additions",
    guidance:
      "Approved packages usually add functional scope beyond the first draft — this template's skeleton tends to under-cover needed features, so err toward a slightly fuller functional scope.",
  },
  scope_trimmed: {
    title: "Scope trimmed",
    guidance:
      "Approved packages usually drop functional scope from the first draft — keep the functional scope tight and essential rather than broad.",
  },
  scope_reworked: {
    title: "Scope reworked",
    guidance:
      "Functional scope is usually rewritten before approval — favor concrete, requester-specific scope items over generic template features.",
  },
  brand_expanded: {
    title: "Brand detail added",
    guidance:
      "Reviewers usually add brand direction — include a fuller set of concrete brand cues (tone, palette, typography) on the first pass.",
  },
  brand_trimmed: {
    title: "Brand detail trimmed",
    guidance:
      "Reviewers usually cut brand direction — keep brand guidance short and let the requester's own brand language lead.",
  },
  brand_reworked: {
    title: "Brand reworked",
    guidance:
      "Brand direction is usually rewritten before approval — mirror the requester's stated brand instead of leaning on the template's default look.",
  },
  content_expanded: {
    title: "Content additions",
    guidance:
      "Approved packages usually add content requirements — spell out pages, sections, and copy needs more completely on the first pass.",
  },
  content_trimmed: {
    title: "Content trimmed",
    guidance:
      "Approved packages usually drop content requirements — keep the content list lean and only what the request clearly needs.",
  },
  content_reworked: {
    title: "Content reworked",
    guidance:
      "Content requirements are usually rewritten before approval — derive them from the requester's actual material rather than template defaults.",
  },
  service_flow_expanded: {
    title: "Service flow additions",
    guidance:
      "Reviewers usually add service-flow requirements — cover the full customer journey, including edge steps, on the first pass.",
  },
  service_flow_trimmed: {
    title: "Service flow trimmed",
    guidance:
      "Reviewers usually cut service-flow requirements — keep flows minimal and only as deep as the request demands.",
  },
  service_flow_reworked: {
    title: "Service flow reworked",
    guidance:
      "Service-flow requirements are usually rewritten before approval — model the requester's real process instead of the template's example flow.",
  },
  data_expanded: {
    title: "Data needs added",
    guidance:
      "Approved packages usually add data needs — enumerate the records and fields the product must hold more completely on the first pass.",
  },
  data_trimmed: {
    title: "Data needs trimmed",
    guidance:
      "Approved packages usually drop data needs — avoid speculative data requirements the request does not call for.",
  },
  data_reworked: {
    title: "Data needs reworked",
    guidance:
      "Data needs are usually rewritten before approval — name the requester's actual entities rather than generic template data.",
  },
  integrations_expanded: {
    title: "Integrations added",
    guidance:
      "Reviewers usually add integration needs — ask which external services matter and include them explicitly on the first pass.",
  },
  integrations_trimmed: {
    title: "Integrations trimmed",
    guidance:
      "Reviewers usually remove integration needs — do not assume integrations the request never mentioned.",
  },
  integrations_reworked: {
    title: "Integrations reworked",
    guidance:
      "Integration needs are usually rewritten before approval — match the requester's named services exactly instead of template suggestions.",
  },
  permissions_expanded: {
    title: "Permissions added",
    guidance:
      "Approved packages usually add permission requests — surface every capability the product will need up front for review.",
  },
  permissions_trimmed: {
    title: "Permissions trimmed",
    guidance:
      "Approved packages usually drop permission requests — request only capabilities the scope clearly justifies.",
  },
  permissions_reworked: {
    title: "Permissions reworked",
    guidance:
      "Permission requests are usually rewritten before approval — tie each capability to a concrete, requester-visible reason.",
  },
  acceptance_expanded: {
    title: "Acceptance checks added",
    guidance:
      "Reviewers usually add acceptance checks — include a fuller set of verifiable checks on the first pass.",
  },
  acceptance_trimmed: {
    title: "Acceptance checks trimmed",
    guidance:
      "Reviewers usually cut acceptance checks — prefer a few decisive checks over an exhaustive list.",
  },
  acceptance_reworked: {
    title: "Acceptance checks reworked",
    guidance:
      "Acceptance checks are usually rewritten before approval — phrase them as outcomes the requester can verify, not template boilerplate.",
  },
  constraints_expanded: {
    title: "Constraints added",
    guidance:
      "Approved packages usually add launch constraints — state operational and rollout limits explicitly on the first pass.",
  },
  constraints_trimmed: {
    title: "Constraints trimmed",
    guidance:
      "Approved packages usually drop launch constraints — keep constraints to what genuinely gates launch.",
  },
  constraints_reworked: {
    title: "Constraints reworked",
    guidance:
      "Launch constraints are usually rewritten before approval — align them with the requester's stated rollout plans.",
  },
  brief_reworked: {
    title: "Brief reworked",
    guidance:
      "The product brief is usually rewritten before approval — anchor summary, audience, and outcomes in the requester's own framing.",
  },
  title_reworked: {
    title: "Title changed",
    guidance:
      "The package title is usually changed before approval — reuse the requester's exact product name instead of a derived one.",
  },
};

/**
 * Revision-theme keys: what recurring intent the free-text revision and
 * iteration instructions expressed. Classification is a compiled
 * word-boundary regex per theme — instruction text itself is never stored,
 * quoted, or transformed into a label.
 */
const THEME_VOCABULARY: Record<
  string,
  VocabularyEntry & { pattern: RegExp }
> = {
  theme_simplify: {
    title: "Simplification requests",
    guidance:
      "Revision requests on this template often ask to simplify — prefer fewer, sharper items over breadth in every section.",
    pattern:
      /\b(simplif\w*|simpler|fewer|less|remove|cut|trim\w*|shorten\w*|reduce\w*|overwhelm\w*|clutter\w*|minimal\w*|too (?:many|much|long|complex)|pare)\b/,
  },
  theme_expand_features: {
    title: "Feature additions",
    guidance:
      "Revision requests often add missing features — probe the request for implied capabilities and cover them in the first draft.",
    pattern:
      /\b(add|include|missing|extend\w*|expand\w*|also (?:need|want)|support for|forgot|leave[s]? out|left out)\b/,
  },
  theme_visual_design: {
    title: "Visual and brand adjustments",
    guidance:
      "Revision requests often adjust look-and-feel — follow the requester's stated brand closely and keep visual direction concrete.",
    pattern:
      /\b(brand\w*|tone|color\w*|colour\w*|styl\w*|look|feel|design\w*|font\w*|logo\w*|visual\w*|aesthetic\w*|modern\w*|polish\w*|dark mode|layout)\b/,
  },
  theme_copy_tone: {
    title: "Copy and wording changes",
    guidance:
      "Revision requests often rework copy — write headlines and messaging in the requester's voice rather than template phrasing.",
    pattern:
      /\b(copy|wording|reword\w*|rewrite|rewritten|headline\w*|tagline\w*|phrasing|messaging|jargon|plain language)\b/,
  },
  theme_audience_fit: {
    title: "Audience refinements",
    guidance:
      "Revision requests often correct the audience — pin down who the product serves before drafting scope and content.",
    pattern:
      /\b(audience\w*|customer\w*|persona\w*|demographic\w*|target market|visitor\w*|clientele|b2b|b2c)\b/,
  },
  theme_pricing_payments: {
    title: "Pricing and payments focus",
    guidance:
      "Revision requests often touch pricing or payments — treat commerce details (plans, checkout, currencies) as first-class requirements.",
    pattern:
      /\b(pric\w*|payment\w*|pay|checkout|billing|subscription\w*|invoice\w*|tip\w*|deposit\w*|refund\w*)\b/,
  },
  theme_data_fields: {
    title: "Data and form changes",
    guidance:
      "Revision requests often reshape data and forms — confirm the exact records and fields the requester tracks.",
    pattern:
      /\b(field\w*|form\w*|database|record\w*|data model|column\w*|spreadsheet|intake|entry|entries)\b/,
  },
  theme_integrations: {
    title: "Integration requests",
    guidance:
      "Revision requests often add or correct integrations — name the requester's actual services and avoid inventing connections.",
    pattern:
      /\b(integrat\w*|connect\w*|api\w*|sync\w*|webhook\w*|import\w*|export\w*|zapier|calendar sync)\b/,
  },
  theme_accessibility: {
    title: "Accessibility asks",
    guidance:
      "Revision requests often raise accessibility — include contrast, keyboard, and screen-reader expectations in acceptance checks.",
    pattern:
      /\b(accessib\w*|a11y|contrast|screen reader\w*|wcag|keyboard nav\w*|alt text)\b/,
  },
  theme_mobile_experience: {
    title: "Mobile experience asks",
    guidance:
      "Revision requests often stress mobile — call out responsive behavior and small-screen flows explicitly.",
    pattern:
      /\b(mobile|phone\w*|responsive\w*|tablet\w*|small screen\w*|touch)\b/,
  },
  theme_performance: {
    title: "Performance concerns",
    guidance:
      "Revision requests often raise speed — include load-time and responsiveness expectations in acceptance checks.",
    pattern:
      /\b(slow\w*|fast\w*|performance|speed\w*|load(?:ing)? time\w*|lag\w*|snappy)\b/,
  },
  theme_privacy_permissions: {
    title: "Privacy and security asks",
    guidance:
      "Revision requests often tighten privacy or security — make data handling, consent, and permission scopes explicit.",
    pattern:
      /\b(privacy|permission\w*|consent|gdpr|data protection|secur\w*|encrypt\w*|compliance|hipaa)\b/,
  },
  theme_onboarding: {
    title: "Onboarding focus",
    guidance:
      "Revision requests often refine onboarding — describe the first-run and sign-up experience concretely.",
    pattern:
      /\b(onboard\w*|sign[- ]?up\w*|first run|tutorial\w*|walkthrough\w*|getting started|welcome flow)\b/,
  },
  theme_notifications: {
    title: "Notification requests",
    guidance:
      "Revision requests often adjust notifications — specify which updates reach people, on what channel, and how often.",
    pattern:
      /\b(notification\w*|notify\w*|remind\w*|alert\w*|push message\w*|email update\w*|digest\w*)\b/,
  },
  theme_search_navigation: {
    title: "Search and navigation changes",
    guidance:
      "Revision requests often rework finding and moving around — define search, filtering, and navigation expectations up front.",
    pattern:
      /\b(search\w*|filter\w*|sort\w*|navigat\w*|menu\w*|findab\w*|browse)\b/,
  },
  theme_localization: {
    title: "Language and locale asks",
    guidance:
      "Revision requests often add languages or locales — ask which languages, currencies, and formats matter.",
    pattern:
      /\b(language\w*|translat\w*|localiz\w*|locale\w*|multilingual|spanish|french|german|bilingual)\b/,
  },
  theme_scheduling_booking: {
    title: "Scheduling and booking focus",
    guidance:
      "Revision requests often refine scheduling — model availability, time zones, and booking rules explicitly.",
    pattern:
      /\b(schedul\w*|calendar\w*|booking\w*|appointment\w*|availab\w*|reservation\w*|time ?slot\w*|time ?zone\w*)\b/,
  },
  theme_analytics_reporting: {
    title: "Analytics and reporting asks",
    guidance:
      "Revision requests often add reporting — include the metrics and dashboards owners need to see.",
    pattern:
      /\b(analytic\w*|report\w*|dashboard\w*|metric\w*|tracking|stats|kpi\w*)\b/,
  },
};

/** The full closed vocabulary; the only keys that can ever be stored. */
export const TEMPLATE_EDIT_SIGNAL_VOCABULARY: Record<string, VocabularyEntry> =
  {
    ...DELTA_VOCABULARY,
    ...Object.fromEntries(
      Object.entries(THEME_VOCABULARY).map(([key, { title, guidance }]) => [
        key,
        { title, guidance },
      ]),
    ),
  };

const stringSet = (values: readonly string[]): Set<string> =>
  new Set(
    values
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );

function listDeltaKey(
  section: string,
  first: readonly string[],
  approved: readonly string[],
): string | null {
  const before = stringSet(first);
  const after = stringSet(approved);
  let added = 0;
  let removed = 0;
  for (const value of after) if (!before.has(value)) added += 1;
  for (const value of before) if (!after.has(value)) removed += 1;
  if (added > 0 && removed > 0) return `${section}_reworked`;
  if (added > 0) return `${section}_expanded`;
  if (removed > 0) return `${section}_trimmed`;
  return null;
}

const asPackage = (value: unknown): VenomBuildPackage | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as VenomBuildPackage;
};

export type TemplateEditSignalSource = {
  /** Package from the run's first generated revision. */
  firstPackage: unknown;
  /** Package from the revision the reviewer approved. */
  approvedPackage: unknown;
  /** Free-text revision instructions issued during review. Never stored. */
  revisionInstructions: readonly string[];
  /** The iteration instruction, for post-release iteration runs. */
  iterationInstruction?: string | null;
};

/**
 * Derive concept-level signal keys from one approval event. Pure and
 * deterministic; every returned key is a member of the closed vocabulary,
 * so the output structurally cannot contain user text.
 */
export function deriveTemplateEditSignals(
  source: TemplateEditSignalSource,
): string[] {
  const keys: string[] = [];
  const first = asPackage(source.firstPackage);
  const approved = asPackage(source.approvedPackage);
  if (first && approved && first !== approved) {
    const sections: Array<[string, readonly string[], readonly string[]]> = [
      ["scope", first.functionalScope, approved.functionalScope],
      ["brand", first.brandDirection, approved.brandDirection],
      ["content", first.contentRequirements, approved.contentRequirements],
      [
        "service_flow",
        first.serviceFlowRequirements,
        approved.serviceFlowRequirements,
      ],
      ["data", first.dataNeeds, approved.dataNeeds],
      ["integrations", first.integrationNeeds, approved.integrationNeeds],
      [
        "permissions",
        first.permissionRequests.map((request) => request.capability),
        approved.permissionRequests.map((request) => request.capability),
      ],
      ["acceptance", first.acceptanceChecks, approved.acceptanceChecks],
      ["constraints", first.launchConstraints, approved.launchConstraints],
    ];
    for (const [section, before, after] of sections) {
      const key = listDeltaKey(section, before, after);
      if (key) keys.push(key);
    }
    if (JSON.stringify(first.productBrief) !== JSON.stringify(approved.productBrief)) {
      keys.push("brief_reworked");
    }
    if (first.title.trim() !== approved.title.trim()) {
      keys.push("title_reworked");
    }
  }

  const instructions = [
    ...source.revisionInstructions,
    ...(source.iterationInstruction ? [source.iterationInstruction] : []),
  ]
    .filter((instruction) => instruction.trim().length > 0)
    .slice(0, TEMPLATE_LEARNING_BOUNDS.instructionsScanned);
  if (instructions.length > 0) {
    const scanned = instructions.map((instruction) =>
      instruction
        .slice(0, TEMPLATE_LEARNING_BOUNDS.instructionScanChars)
        .toLowerCase(),
    );
    for (const [key, theme] of Object.entries(THEME_VOCABULARY)) {
      if (scanned.some((instruction) => theme.pattern.test(instruction))) {
        keys.push(key);
      }
    }
  }

  // Belt and braces: only vocabulary keys survive, deduped and capped.
  const unique: string[] = [];
  for (const key of keys) {
    if (!TEMPLATE_EDIT_SIGNAL_VOCABULARY[key]) continue;
    if (unique.includes(key)) continue;
    unique.push(key);
    if (unique.length >= TEMPLATE_LEARNING_BOUNDS.signalsPerApproval) break;
  }
  return unique;
}

/**
 * Record signal keys for an opted-in tenant against a template, then fold
 * them into the aggregates. No-op (returning false) when the tenant has not
 * opted in to master contribution. Same locking discipline as the master
 * tier: fast-path consent read, then an authoritative re-read inside the
 * tenant's advisory-lock transaction, so a write cannot race an opt-out.
 */
export async function contributeTemplateEditSignals(input: {
  tenant: MasterTenant;
  templateId: string;
  signalKeys: readonly string[];
  now?: number;
}): Promise<boolean> {
  const keys = [...new Set(input.signalKeys)]
    .filter((key) => TEMPLATE_EDIT_SIGNAL_VOCABULARY[key] !== undefined)
    .slice(0, TEMPLATE_LEARNING_BOUNDS.signalsPerApproval);
  if (keys.length === 0) return false;
  const enabled = await isMasterContributionEnabled(input.tenant);
  if (!enabled) return false;
  const now = input.now ?? Date.now();

  const wrote = await withTenantMasterLock(input.tenant, async (tx) => {
    const settingRows = await tx
      .select({ enabled: venomMasterContributionSettingsTable.enabled })
      .from(venomMasterContributionSettingsTable)
      .where(
        and(
          eq(
            venomMasterContributionSettingsTable.tenantType,
            input.tenant.tenantType,
          ),
          eq(
            venomMasterContributionSettingsTable.tenantId,
            input.tenant.tenantId,
          ),
        ),
      )
      .limit(1);
    if (settingRows[0]?.enabled !== true) return false;
    await tx
      .insert(venomTemplateEditSignalsTable)
      .values(
        keys.map((signalKey) => ({
          tenantType: input.tenant.tenantType,
          tenantId: input.tenant.tenantId,
          templateId: input.templateId,
          signalKey,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          venomTemplateEditSignalsTable.tenantType,
          venomTemplateEditSignalsTable.tenantId,
          venomTemplateEditSignalsTable.templateId,
          venomTemplateEditSignalsTable.signalKey,
        ],
        set: { lastSeenAt: now },
      });
    return true;
  });
  if (!wrote) return false;
  await rebuildMasterAggregates();
  return true;
}

export type TemplateGuidanceEntry = {
  key: string;
  title: string;
  guidance: string;
  /** Distinct opted-in tenants behind this lesson (>= the master floor). */
  tenantCount: number;
};

async function loadGuidance(
  templateId: string,
): Promise<TemplateGuidanceEntry[]> {
  const rows = await db
    .select()
    .from(venomTemplateGuidanceTable)
    .where(eq(venomTemplateGuidanceTable.templateId, templateId));
  return rows
    .filter((row) => row.tenantCount >= MASTER_MIN_DISTINCT_TENANTS)
    .flatMap((row) => {
      // Reads only ever emit compiled vocabulary strings. A row whose key
      // is not in the vocabulary (e.g. after a vocabulary retirement) has
      // no surface.
      const entry = TEMPLATE_EDIT_SIGNAL_VOCABULARY[row.signalKey];
      if (!entry) return [];
      return [
        {
          key: row.signalKey,
          title: entry.title,
          guidance: entry.guidance,
          tenantCount: row.tenantCount,
        },
      ];
    })
    .sort(
      (a, b) => b.tenantCount - a.tenantCount || a.key.localeCompare(b.key),
    );
}

/**
 * Above-threshold guidance for one template, strongest lessons first,
 * bounded for injection into generation.
 */
export async function getTemplateGuidance(
  templateId: string,
): Promise<TemplateGuidanceEntry[]> {
  const entries = await loadGuidance(templateId);
  return entries.slice(0, TEMPLATE_LEARNING_BOUNDS.guidancePerTemplate);
}

/**
 * How many above-threshold lessons a template has learned from the
 * network. A plain count for the template detail note — no tenant traces.
 */
export async function countTemplateGuidance(
  templateId: string,
): Promise<number> {
  return (await loadGuidance(templateId)).length;
}
