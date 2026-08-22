import {
  db,
  venomBuildTemplatesTable,
  type VenomBuildPackageRecord,
} from "@workspace/db";

type VenomBuildTemplateSeed = typeof venomBuildTemplatesTable.$inferInsert;

/**
 * Curated starter templates: a handful of sensible app and widget archetypes
 * so nobody faces a blank build form. Seeding is deliberately insert-only
 * (`onConflictDoNothing` on slug): the ops path — super-admin upserts by
 * slug — owns every later edit, and a redeploy must never revert one.
 */

const HUMAN_APPROVAL =
  "Human approval is required before any provisioning or external action.";
const NO_EXECUTION =
  "This package does not authorize code execution, deployment, publishing, purchases, DNS changes, credential access, data import, or customer contact.";

const bookingExamplePackage: VenomBuildPackageRecord = {
  formatVersion: 1,
  targetType: "app",
  title: "Client Booking App",
  productBrief: {
    summary:
      "A scheduling app where clients pick a service, see real availability, and book a time slot without back-and-forth messages. The owner manages services, working hours, and upcoming appointments from a simple dashboard.",
    audience: [
      "Solo service providers and small teams that take appointments",
      "Their clients booking from a phone",
    ],
    outcomes: [
      "Clients can book a slot in under a minute without creating an account",
      "Double bookings are impossible: availability reflects existing appointments",
      "The owner sees today's and this week's schedule at a glance",
    ],
  },
  functionalScope: [
    "Service catalog with name, duration, and price per service",
    "Availability engine derived from weekly working hours minus booked slots",
    "Booking flow: pick service, pick open slot, confirm with name and contact",
    "Owner dashboard listing upcoming appointments with cancel and reschedule",
    "Email-style confirmation content prepared for each booking (content only)",
  ],
  brandDirection: [
    "Calm, trustworthy, appointment-card visual language",
    "Large tap targets and a mobile-first booking flow",
  ],
  contentRequirements: [
    "Welcome copy explaining what can be booked and how long it takes",
    "Confirmation message template with date, time, and service name",
  ],
  serviceFlowRequirements: [],
  sourceReferences: [],
  sopReferences: [],
  dataNeeds: [
    "Service list with durations and prices",
    "Weekly working hours and blocked-out dates",
  ],
  integrationNeeds: [],
  permissionRequests: [],
  acceptanceChecks: [
    "Booking a slot removes it from availability immediately",
    "A client cannot book two overlapping appointments for the same provider",
    "The owner can cancel an appointment and the slot reopens",
  ],
  launchConstraints: [HUMAN_APPROVAL, NO_EXECUTION],
};

const testimonialExamplePackage: VenomBuildPackageRecord = {
  formatVersion: 1,
  targetType: "website",
  title: "Testimonial Wall Widget",
  productBrief: {
    summary:
      "An embeddable testimonial wall that shows curated customer quotes in a responsive grid, with a lightweight submission form feeding a moderation queue so only approved quotes appear.",
    audience: [
      "Site owners who want social proof on landing pages",
      "Visitors reading customer experiences",
    ],
    outcomes: [
      "Approved testimonials render in a clean, scannable wall",
      "New submissions never appear publicly before review",
    ],
  },
  functionalScope: [
    "Responsive testimonial grid with quote, name, and optional role",
    "Submission form collecting quote and attribution",
    "Moderation queue: pending, approved, and hidden states",
    "Embed-ready layout that adapts to narrow containers",
  ],
  brandDirection: [
    "Neutral by default so it inherits the host site's feel",
    "Typography-led cards; the words are the design",
  ],
  contentRequirements: [
    "Empty-state copy inviting the first testimonial",
    "Submission confirmation copy that mentions review before publication",
  ],
  serviceFlowRequirements: [],
  sourceReferences: [],
  sopReferences: [],
  dataNeeds: ["Existing testimonials to preload, if any"],
  integrationNeeds: [],
  permissionRequests: [],
  acceptanceChecks: [
    "Unreviewed submissions are not visible on the public wall",
    "The wall stays readable from phone width to full desktop width",
  ],
  launchConstraints: [HUMAN_APPROVAL, NO_EXECUTION],
};

export const VENOM_BUILD_TEMPLATE_SEEDS: VenomBuildTemplateSeed[] = [
  {
    slug: "client-booking-app",
    name: "Client Booking App",
    category: "app",
    description:
      "Let clients pick a service and book real openings themselves — no message ping-pong, no double bookings.",
    previewSummary:
      "You get a booking flow for clients (service, open slot, confirm) plus an owner dashboard of upcoming appointments with cancel and reschedule. Availability comes from your working hours minus existing bookings, so a taken slot disappears instantly.",
    targetType: "app",
    targetName: "Client Booking App",
    requirements:
      "Build an appointment booking app. Clients choose a service (each with a duration and price), see genuinely open time slots computed from weekly working hours minus existing bookings, and confirm with their name and contact details — no client account required. The owner manages services, working hours, and blocked-out dates, and sees upcoming appointments for today and this week with cancel and reschedule. Double bookings must be impossible.",
    constraints:
      "No payment processing in the first version. Keep the booking flow to three steps or fewer.",
    brandDirection:
      "Calm and trustworthy, appointment-card visual language, mobile-first with large tap targets.",
    acceptanceChecks: [
      "Booking a slot removes it from availability immediately",
      "Overlapping appointments for the same provider are impossible",
      "Cancelling an appointment reopens its slot",
    ],
    examplePackage: bookingExamplePackage,
    sortOrder: 10,
  },
  {
    slug: "customer-feedback-hub",
    name: "Customer Feedback Hub",
    category: "app",
    description:
      "Collect feature requests and bug reports in one place, let customers vote, and show what you're working on.",
    previewSummary:
      "You get a public board where customers post ideas and problems, vote on what matters, and follow status as items move from Under review to Planned, In progress, and Shipped. You triage from a simple internal view.",
    targetType: "app",
    targetName: "Customer Feedback Hub",
    requirements:
      "Build a customer feedback hub. Visitors submit feature requests or bug reports with a title and description, browse existing posts to avoid duplicates, and upvote what they care about. Each post has a status (under review, planned, in progress, shipped, declined) that the owner sets from an internal triage view. The public board is sortable by votes and recency, and filterable by status and type.",
    constraints:
      "Submissions need a lightweight duplicate nudge (show similar titles before posting). No login for voting in the first version; rate-limit instead.",
    brandDirection:
      "Straightforward and product-serious; the board should read like a well-kept changelog, not a forum.",
    acceptanceChecks: [
      "A new submission appears on the board without a page reload",
      "Vote counts persist and a visitor cannot vote twice in a session",
      "Status changes are immediately visible on the public board",
    ],
    examplePackage: null,
    sortOrder: 20,
  },
  {
    slug: "team-knowledge-base",
    name: "Team Knowledge Base",
    category: "app",
    description:
      "A searchable home for how-tos and internal docs, organized by topic so answers stop living in chat threads.",
    previewSummary:
      "You get an article library organized by topic with fast search, an editor for writing and updating articles, and freshness signals so stale docs are easy to spot and fix.",
    targetType: "app",
    targetName: "Team Knowledge Base",
    requirements:
      "Build a team knowledge base. Members write articles with a title, topic, and rich text body; browse by topic; and find answers through full-text search over titles and bodies. Every article shows when it was last updated, and a freshness view lists articles untouched for a configurable number of days so owners can review them. Include an archive state so outdated articles leave browse and search without being deleted.",
    constraints:
      "Keep the editor simple: headings, lists, links, and code blocks are enough. No external sharing in the first version.",
    brandDirection:
      "Quiet, library-like, typography-first; reading comfort beats decoration.",
    acceptanceChecks: [
      "Search finds an article by a phrase in its body, not just its title",
      "Archived articles disappear from browse and search but remain restorable",
      "The freshness view lists articles older than the configured threshold",
    ],
    examplePackage: null,
    sortOrder: 30,
  },
  {
    slug: "testimonial-wall-widget",
    name: "Testimonial Wall Widget",
    category: "widget",
    description:
      "An embeddable wall of customer quotes with a submission form and a moderation queue — only approved words go public.",
    previewSummary:
      "You get a responsive testimonial grid ready to drop into a landing page, a lightweight submission form, and a moderation queue so nothing appears publicly before you approve it.",
    targetType: "website",
    targetName: "Testimonial Wall Widget",
    requirements:
      "Build an embeddable testimonial wall. Approved testimonials (quote, name, optional role or company) render in a responsive grid that stays readable from phone width to desktop. Visitors can submit a testimonial through a short form; submissions land in a moderation queue with pending, approved, and hidden states, and only approved entries appear publicly. Include an empty state that invites the first submission.",
    constraints:
      "The widget must look at home inside a host page: no fixed heights, no horizontal scrolling, inherit the page font when possible.",
    brandDirection:
      "Neutral, typography-led cards that let the customer's words carry the design.",
    acceptanceChecks: [
      "Unreviewed submissions never appear on the public wall",
      "The grid reflows cleanly at narrow container widths",
    ],
    examplePackage: testimonialExamplePackage,
    sortOrder: 40,
  },
  {
    slug: "pricing-calculator-widget",
    name: "Pricing Calculator Widget",
    category: "widget",
    description:
      "Let visitors self-serve a price estimate from a few sliders and toggles, with a clear breakdown of what drives the number.",
    previewSummary:
      "You get an interactive estimator — quantity sliders, option toggles, plan tiers — that updates a running total live and shows a line-item breakdown, ending in a call-to-action you control.",
    targetType: "app",
    targetName: "Pricing Calculator Widget",
    requirements:
      "Build a pricing calculator widget. Visitors adjust a small set of inputs (quantity slider, option toggles, plan tier choice) and see the estimated total update instantly, with a line-item breakdown explaining each contribution. Pricing rules (base price, per-unit rates, option surcharges, tier multipliers) live in one editable configuration so the owner can change numbers without touching layout. End with a configurable call-to-action.",
    constraints:
      "All pricing math happens client-side from the configuration; no checkout or payment collection. Keep the widget embeddable in a marketing page section.",
    brandDirection:
      "Confident and precise; the total is the hero, the breakdown earns trust.",
    acceptanceChecks: [
      "Changing any input updates the total without a page reload",
      "The breakdown always sums to the displayed total",
      "Editing the pricing configuration changes results without layout edits",
    ],
    examplePackage: null,
    sortOrder: 50,
  },
  {
    slug: "faq-assistant-widget",
    name: "FAQ Assistant Widget",
    category: "widget",
    description:
      "Answer routine customer questions from your own FAQ content, and hand off gracefully when the answer isn't there.",
    previewSummary:
      "You get a question-answering flow grounded in your curated FAQ entries: visitors ask in their own words, get the matching answer with a link to the full entry, and reach a human handoff path when nothing matches.",
    targetType: "customer_service_flow",
    targetName: "FAQ Assistant Widget",
    requirements:
      "Design a customer service flow for an FAQ assistant widget. Visitors type a question in their own words; the flow matches it against a curated set of FAQ entries (question, answer, category) and responds with the best matching answer plus related entries. When confidence is low or nothing matches, the flow says so plainly and offers a handoff path (contact form or email) instead of guessing. Owners manage FAQ entries and can review unanswered questions to grow the FAQ.",
    constraints:
      "Answers must come only from the curated FAQ content — the assistant never invents policy. Every response shows which FAQ entry it came from.",
    brandDirection:
      "Helpful and honest; admitting 'that's not in the FAQ yet' is part of the brand.",
    acceptanceChecks: [
      "A question matching an FAQ entry returns that entry's answer with attribution",
      "An unmatchable question produces the handoff path, never a fabricated answer",
      "Unanswered questions are captured for FAQ review",
    ],
    examplePackage: null,
    sortOrder: 60,
  },
];

/**
 * Insert-only startup seeding keyed on slug. Idempotent: existing rows —
 * including ops-edited ones — are never touched.
 */
export async function ensureVenomBuildTemplateSeed(): Promise<void> {
  await db
    .insert(venomBuildTemplatesTable)
    .values(VENOM_BUILD_TEMPLATE_SEEDS)
    .onConflictDoNothing({ target: venomBuildTemplatesTable.slug });
}
