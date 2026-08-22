/**
 * Live two-account shared-workspace check (task 164).
 *
 * Proves the full multi-account path with two REAL Clerk accounts against the
 * REAL running dev servers, API, and database — the layer no automated suite
 * exercises (api-server integration tests cover membership/roles/revocation on
 * the DB; browser suites pin the client eviction contract against stubs):
 *
 *   1. Owner (account A, desktop web): creates a shared workspace, adds the
 *      second account by user id (real Clerk directory lookup), and files
 *      knowledge from chat — extraction + workspace filing are LIVE server
 *      calls (real GPT extraction, real DB rows). Creates a workspace SOP.
 *   2. Member (account B, Expo mobile web): files personal knowledge from
 *      chat (live), then opens the workspaces screen, selects the shared
 *      space, and must see the same members, knowledge, and SOP.
 *   3. Member (account B, desktop web): signs in, selects the shared space,
 *      and must see the same knowledge and SOP.
 *   4. Owner removes B. B's next workspace-scoped request on EACH device must
 *      return the coded 403 and evict: desktop shows the "Shared workspace
 *      unavailable" toast and falls back to personal; mobile shows the
 *      access-lost notice and drops the cached rows. B's personal Brain must
 *      keep working on both devices; the owner keeps access.
 *
 * Only the AI chat endpoints (models/deliberation/respond) are stubbed for
 * determinism. Knowledge extraction (/api/venom/knowledge/extract), all
 * workspace endpoints, Clerk auth, and the sync blob are LIVE.
 *
 * Run (all three artifact dev workflows must be up):
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) \
 *     node scripts/live/shared-workspace-two-accounts.mjs
 *
 * Not part of any CI suite: this is a live verification harness.
 */

import { chromium } from "@playwright/test";
import fs from "node:fs";

const EXPO_ORIGIN = `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`;
const DESKTOP_ORIGIN = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const SHOTS = "/tmp/task164";

if (!process.env.REPLIT_EXPO_DEV_DOMAIN || !process.env.REPLIT_DEV_DOMAIN) {
  console.error("Missing REPLIT_EXPO_DEV_DOMAIN / REPLIT_DEV_DOMAIN");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Accounts: created via the Clerk Backend API (headless sign-UP is
// CAPTCHA-blocked; sign-IN is not), deleted again in cleanup.
// ---------------------------------------------------------------------------

const runTag = Date.now();
const owner = {
  label: "owner",
  email: `venom.task164.owner.${runTag}+clerk_test@example.com`,
  password: `Task164!OwnerSymbiote${runTag % 9973}`,
  id: null,
};
const member = {
  label: "member",
  email: `venom.task164.member.${runTag}+clerk_test@example.com`,
  password: `Task164!MemberSymbiote${runTag % 9973}`,
  id: null,
};

// ---------------------------------------------------------------------------
// Chat fixtures. voiceId/modelId are CLOSED server-schema enums — invented
// ids poison every workspace PUT with 400s. The user prompts carry the
// factual payload the LIVE extraction runs on.
// ---------------------------------------------------------------------------

const ROSTER = [
  { voiceId: "direct", name: "First take", tagline: "Answers head-on", modelId: "venom-gpt", modelName: "Venom GPT" },
  { voiceId: "skeptic", name: "Skeptic", tagline: "Attacks assumptions", modelId: "venom-claude", modelName: "Venom Claude" },
  { voiceId: "evidence", name: "Evidence", tagline: "Sticks to sources", modelId: "venom-gemini", modelName: "Venom Gemini" },
];

const OWNER_TURN = {
  prompt:
    "Please remember this team knowledge: Acme Logistics runs its weekly dispatch review every Tuesday at 09:00 UTC. The ops lead owns the dispatch checklist, and the fallback dispatcher is paged through the road-ops rota.",
  retryPrompt:
    "One more team fact to keep: Acme Logistics freezes route changes every Friday at 15:00 UTC, and the dispatch supervisor signs off the freeze list.",
  collective:
    "Collective answer: the dispatch cadence is locked in — Tuesdays at 09:00 UTC with the ops lead on the checklist.",
  direct: "Tuesday 09:00 UTC dispatch review, ops lead runs the checklist.",
  evidence: "The rota confirms the fallback dispatcher is paged via road-ops.",
  disagreement:
    "First take called the cadence settled; Evidence wanted the rota double-checked.",
};

const MEMBER_TURN = {
  prompt:
    "Note for my personal brain: my espresso dial-in recipe is 18 grams of beans in, 36 grams of yield out, pulled in 28 seconds on the Gaggia at grinder setting 2.4.",
  retryPrompt:
    "Another personal note: my espresso backup recipe is 17 grams in, 34 grams out, in 26 seconds when the beans are fresh.",
  collective:
    "Collective answer: your espresso recipe is dialed — 18 grams in, 36 out, 28 seconds flat.",
  direct: "18 in, 36 out, 28 seconds — that shot is dialed.",
  evidence: "Grinder setting 2.4 matches the 28 second pull you logged.",
  disagreement:
    "First take called the shot dialed; Evidence wanted the grind logged first.",
};

const SOP_TITLE = `DAWN DISPATCH CHECKLIST ${runTag % 10_000}`;

function deliberationEvents({ roster, turn }) {
  const takes = [
    ["direct", turn.direct],
    ["evidence", turn.evidence],
  ];
  const events = [
    { modelId: "venom-gpt", modelName: "Venom GPT", deliberation: { voices: roster } },
  ];
  for (const [voiceId, content] of takes) {
    events.push({ voice: voiceId, content });
    events.push({ voice: voiceId, voiceStatus: "ok" });
  }
  events.push({ voice: "skeptic", voiceStatus: "failed" });
  events.push({ stage: "synthesis" });
  events.push({ content: turn.collective });
  events.push({
    deliberation: {
      voices: roster.map((voice) => {
        const take = takes.find(([id]) => id === voice.voiceId);
        return {
          voiceId: voice.voiceId,
          name: voice.name,
          modelId: voice.modelId,
          modelName: voice.modelName,
          content: take ? take[1] : "",
          status: take ? "ok" : "failed",
        };
      }),
      disagreements: [turn.disagreement],
    },
  });
  events.push({ done: true });
  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const results = [];
let shotIndex = 0;
let browser;

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

async function shot(page, name) {
  try {
    shotIndex += 1;
    const file = `${SHOTS}/${String(shotIndex).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: file, fullPage: false });
    log(`  shot: ${file}`);
  } catch {
    /* screenshots are evidence, not assertions */
  }
}

async function step(name, page, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error: String(error) });
    log(`FAIL ${name}: ${error?.message ?? error}`);
    if (page) await shot(page, `FAIL-${name.replace(/\W+/g, "-")}`);
    throw error;
  }
}

function sseBody(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/**
 * Stub ONLY the AI chat endpoints. Knowledge extraction is deliberately LIVE
 * here (unlike the cross-device deliberation harness): the whole point is
 * real server-side extraction + workspace filing + membership re-checks.
 */
async function stubAiChatEndpoints(page, { roster, events }) {
  await page.route("**/api/venom/models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "venom-gpt",
          provider: "openai",
          name: "Venom GPT",
          family: "GPT",
          summary: "OpenAI managed model",
          available: true,
          availabilityText: "Ready",
        },
      ]),
    }),
  );
  await page.route("**/api/venom/deliberation", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        mode: "multi-model",
        voices: roster.map(({ voiceId, name, tagline }) => ({ voiceId, name, tagline })),
      }),
    }),
  );
  await page.route("**/api/venom/respond", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: sseBody(events),
    }),
  );
}

async function waitForClerk(page, timeout = 90_000) {
  await page.waitForFunction(
    () => Boolean(globalThis.Clerk && globalThis.Clerk.loaded),
    null,
    { timeout },
  );
}

async function createAccountViaBackendApi(account) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not available");
  const response = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email_address: [account.email], password: account.password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Clerk user creation failed (${response.status}): ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  account.id = body.id;
  if (!account.id) throw new Error("Clerk user creation returned no id");
}

async function deleteAccountViaBackendApi(account) {
  if (!account.id) return;
  const secretKey = process.env.CLERK_SECRET_KEY;
  await fetch(`https://api.clerk.com/v1/users/${account.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${secretKey}` },
  }).catch(() => {});
}

/**
 * Password sign-in; a fresh headless client is untrusted, so Clerk may demand
 * an email-code trust step — +clerk_test accounts accept 424242 for it.
 */
async function clerkSignIn(page, account) {
  const outcome = await page.evaluate(
    async ({ email, password }) => {
      const describe = (error) =>
        error?.errors?.map((e) => `${e.code}: ${e.longMessage || e.message}`).join("; ") ||
        String(error);
      try {
        const clerk = globalThis.Clerk;
        let signIn = await clerk.client.signIn.create({ identifier: email, password });
        if (
          signIn.status === "needs_client_trust" ||
          signIn.status === "needs_second_factor"
        ) {
          const factor = (signIn.supportedSecondFactors || []).find(
            (f) => f.strategy === "email_code",
          );
          await signIn.prepareSecondFactor({
            strategy: "email_code",
            ...(factor?.emailAddressId ? { emailAddressId: factor.emailAddressId } : {}),
          });
          signIn = await signIn.attemptSecondFactor({
            strategy: "email_code",
            code: "424242",
          });
        } else if (signIn.status === "needs_first_factor") {
          const factor = (signIn.supportedFirstFactors || []).find(
            (f) => f.strategy === "email_code",
          );
          await signIn.prepareFirstFactor({
            strategy: "email_code",
            ...(factor?.emailAddressId ? { emailAddressId: factor.emailAddressId } : {}),
          });
          signIn = await signIn.attemptFirstFactor({
            strategy: "email_code",
            code: "424242",
          });
        }
        if (signIn.status !== "complete") {
          return { ok: false, detail: `signIn status ${signIn.status}` };
        }
        await clerk.setActive({ session: signIn.createdSessionId });
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: describe(error) };
      }
    },
    { email: account.email, password: account.password },
  );
  if (!outcome.ok) {
    throw new Error(`Clerk sign-in failed for ${account.label}: ${outcome.detail}`);
  }
}

function extractResponseWaiter(page, timeout = 180_000) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/venom/knowledge/extract") &&
      response.request().method() === "POST",
    { timeout },
  );
}

/** Resolve once a sync-blob PUT whose body contains `needle` succeeds. */
function workspacePutWaiter(page, needle, timeout = 120_000) {
  return page.waitForResponse(
    (response) => {
      try {
        return (
          new URL(response.url()).pathname.endsWith("/api/venom/workspace") &&
          response.request().method() === "PUT" &&
          response.status() === 200 &&
          (response.request().postData() || "").includes(needle)
        );
      } catch {
        return false;
      }
    },
    { timeout },
  );
}

async function textVisible(page, text, timeout = 20_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

function wireDiagnostics(page, label) {
  const seen = new Map();
  const say = (key, line) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count <= 3) log(line + (count === 3 ? " (suppressing repeats)" : ""));
  };
  page.on("pageerror", (error) =>
    say(`pageerror:${error.message}`, `[${label}] pageerror: ${error.message.slice(0, 300)}`),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("net::ERR") || text.includes("favicon") || text.startsWith("%c")) return;
    say(`console:${text.slice(0, 80)}`, `[${label}] console.error: ${text.slice(0, 300)}`);
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const path = new URL(response.url()).pathname;
    if (path.includes("favicon")) return;
    say(
      `http:${status}:${path}`,
      `[${label}] HTTP ${status} ${response.request().method()} ${path}`,
    );
  });
}

/**
 * Drive one chat turn and wait for the LIVE extraction round-trip. Retries
 * once with a second prompt when the model files nothing (extraction quality
 * is non-deterministic; filing correctness is what this harness pins).
 */
async function chatTurnWithLiveFiling(page, ui, turn, verdict) {
  const sendTurn = async (prompt) => {
    const waiter = extractResponseWaiter(page);
    await page.getByTestId(ui.input).fill(prompt);
    if (ui.send === "enter") {
      await page.getByTestId(ui.input).press("Enter");
    } else {
      await page.getByTestId(ui.send).click();
    }
    await textVisible(page, turn.collective, 60_000);
    const response = await waiter;
    if (response.status() !== 200) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `live extraction returned HTTP ${response.status()}: ${body.slice(0, 300)}`,
      );
    }
    return response.json();
  };

  let json = await sendTurn(turn.prompt);
  if (!verdict(json)) {
    log("  (extraction filed nothing on the first turn; retrying once)");
    json = await sendTurn(turn.retryPrompt);
  }
  if (!verdict(json)) {
    throw new Error(
      `extraction never filed: ${JSON.stringify(json).slice(0, 400)}`,
    );
  }
  return json;
}

/** Close the topmost open dialog and wait until it is really gone. */
async function closeDialog(page) {
  const dialog = page.locator('[role="dialog"]').last();
  const close = dialog.getByRole("button", { name: "Close" }).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  } else {
    await page.keyboard.press("Escape");
  }
  await page
    .locator('[role="dialog"]')
    .last()
    .waitFor({ state: "hidden", timeout: 10_000 });
}

async function fetchJsonInPage(page, url) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: "include" });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }, url);
}

function clustersOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.clusters)) return body.clusters;
  if (Array.isArray(body?.knowledge)) return body.knowledge;
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  log("Live two-account shared-workspace check (task 164)");
  log(`  desktop: ${DESKTOP_ORIGIN}`);
  log(`  phone:   ${EXPO_ORIGIN}`);
  log(`  owner:   ${owner.email}`);
  log(`  member:  ${member.email}`);

  await step("both test accounts exist (Clerk Backend API)", null, async () => {
    await createAccountViaBackendApi(owner);
    await createAccountViaBackendApi(member);
    log(`  owner id:  ${owner.id}`);
    log(`  member id: ${member.id}`);
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  // -- Owner desktop ---------------------------------------------------------
  const ownerContext = await browser.newContext({
    viewport: { width: 1360, height: 880 },
    ignoreHTTPSErrors: true,
  });
  const ownerPage = await ownerContext.newPage();
  ownerPage.setDefaultTimeout(30_000);
  ownerPage.setDefaultNavigationTimeout(90_000);
  wireDiagnostics(ownerPage, "owner-desktop");
  await stubAiChatEndpoints(ownerPage, {
    roster: ROSTER,
    events: deliberationEvents({ roster: ROSTER, turn: OWNER_TURN }),
  });

  await step("owner signs in on desktop", ownerPage, async () => {
    await ownerPage.goto(`${DESKTOP_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitForClerk(ownerPage);
    await clerkSignIn(ownerPage, owner);
    await ownerPage.goto(`${DESKTOP_ORIGIN}/workspace/chat`, { waitUntil: "domcontentloaded" });
    await ownerPage.getByTestId("input-message").waitFor({ state: "visible", timeout: 45_000 });
  });

  let wsId = null;
  const wsName = `Live Team ${runTag % 10_000}`;
  await step("owner creates the shared workspace", ownerPage, async () => {
    await ownerPage.getByTestId("button-new-shared-space-desktop").click();
    await ownerPage.getByTestId("input-shared-workspace-name").fill(wsName);
    const created = ownerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/venom/workspaces") &&
        response.request().method() === "POST",
    );
    await ownerPage.getByTestId("button-create-shared-workspace").click();
    const response = await created;
    if (response.status() !== 201) {
      throw new Error(`workspace create returned HTTP ${response.status()}`);
    }
    const body = await response.json();
    wsId = body.id;
    if (!wsId) throw new Error(`workspace create response had no id: ${JSON.stringify(body)}`);
    await ownerPage.getByTestId("chip-shared-space").waitFor({ state: "visible", timeout: 20_000 });
    log(`  workspace id: ${wsId}`);
    await shot(ownerPage, "owner-workspace-created");
  });

  await step("owner adds the member by account id (live directory lookup)", ownerPage, async () => {
    await ownerPage.getByTestId("button-space-members-desktop").click();
    await ownerPage.getByTestId("input-new-member-id").waitFor({ state: "visible", timeout: 15_000 });
    await ownerPage.getByTestId("input-new-member-id").fill(member.id);
    const added = ownerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/api/venom/workspaces/${wsId}/members`) &&
        response.request().method() === "POST",
    );
    await ownerPage.getByTestId("button-add-member").click();
    const response = await added;
    if (response.status() !== 200 && response.status() !== 201) {
      const body = await response.text().catch(() => "");
      throw new Error(`add-member returned HTTP ${response.status()}: ${body.slice(0, 300)}`);
    }
    const row = ownerPage.getByTestId(`row-member-${member.id}`);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    log(`  member row: ${((await row.textContent()) ?? "").slice(0, 120)}`);
    await shot(ownerPage, "owner-added-member");
    await closeDialog(ownerPage);
  });

  await step("owner chat turn files knowledge into the workspace (live extraction)", ownerPage, async () => {
    // Default Talk mode: extraction runs for every non-debate turn.
    const json = await chatTurnWithLiveFiling(
      ownerPage,
      { input: "input-message", send: "enter" },
      OWNER_TURN,
      (data) => data.filedWorkspaceId === wsId && clustersOf(data).length > 0,
    );
    log(`  filedWorkspaceId: ${json.filedWorkspaceId}, clusters: ${clustersOf(json).length}`);
    await shot(ownerPage, "owner-chat-filed");
  });

  let sharedCluster = null;
  await step("workspace knowledge endpoint holds the filed concept", ownerPage, async () => {
    const { status, body } = await fetchJsonInPage(
      ownerPage,
      `/api/venom/workspaces/${wsId}/knowledge`,
    );
    if (status !== 200) throw new Error(`knowledge GET returned ${status}`);
    const clusters = clustersOf(body);
    if (clusters.length === 0) throw new Error("workspace knowledge is empty after filing");
    sharedCluster = { id: clusters[0].id, label: clusters[0].label };
    if (!sharedCluster.id || !sharedCluster.label) {
      throw new Error(`unexpected cluster shape: ${JSON.stringify(clusters[0]).slice(0, 300)}`);
    }
    log(`  shared concept: "${sharedCluster.label}" (${sharedCluster.id})`);
  });

  await step("owner Brain renders the shared concept", ownerPage, async () => {
    await ownerPage.getByTestId("link-nav-brain").click();
    await ownerPage.getByTestId("badge-workspace-brain").waitFor({ state: "visible", timeout: 20_000 });
    // Map nodes carry aria-label "Node: <label>"; search rows are only for
    // cross-project matches, so the map itself is the assertion surface.
    await ownerPage
      .getByLabel(`Node: ${sharedCluster.label}`)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await shot(ownerPage, "owner-brain-shared-concept");
  });

  await step("owner creates a workspace SOP", ownerPage, async () => {
    await ownerPage.getByTestId("link-nav-sops").click();
    await ownerPage.getByTestId("badge-workspace-sops").waitFor({ state: "visible", timeout: 20_000 });
    await ownerPage.locator('button:visible', { hasText: "New SOP" }).first().click();
    await ownerPage.getByPlaceholder("e.g. INCIDENT RESPONSE").fill(SOP_TITLE);
    const created = ownerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/api/venom/workspaces/${wsId}/sops`) &&
        response.request().method() === "POST",
    );
    await ownerPage.locator('[role="dialog"] button[type="submit"]').click();
    const response = await created;
    if (response.status() !== 200 && response.status() !== 201) {
      throw new Error(`SOP create returned HTTP ${response.status()}`);
    }
    await ownerPage
      .locator('[data-testid^="card-workspace-sop-"]')
      .filter({ hasText: SOP_TITLE })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await shot(ownerPage, "owner-sop-created");
  });

  // -- Member mobile (Expo web) ----------------------------------------------
  const mobileContext = await browser.newContext({
    viewport: { width: 400, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const mobile = await mobileContext.newPage();
  mobile.setDefaultTimeout(30_000);
  mobile.setDefaultNavigationTimeout(120_000);
  wireDiagnostics(mobile, "member-mobile");
  await stubAiChatEndpoints(mobile, {
    roster: ROSTER,
    events: deliberationEvents({ roster: ROSTER, turn: MEMBER_TURN }),
  });

  await step("member signs in on mobile", mobile, async () => {
    await mobile.goto(`${EXPO_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitForClerk(mobile);
    await clerkSignIn(mobile, member);
    try {
      await mobile.getByTestId("chat-input").waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      await mobile.reload({ waitUntil: "domcontentloaded" });
      await mobile.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await shot(mobile, "member-mobile-signed-in");
  });

  let personalLabel = null;
  await step("member mobile files personal knowledge (live extraction)", mobile, async () => {
    // Default Talk mode: extraction runs for every non-debate turn.
    const blobSynced = workspacePutWaiter(mobile, "espresso");
    const json = await chatTurnWithLiveFiling(
      mobile,
      { input: "chat-input", send: "send-message-button" },
      MEMBER_TURN,
      (data) => Array.isArray(data.filed) && data.filed.length > 0,
    );
    personalLabel = json.filed[0].label ?? json.filed[0].name;
    if (!personalLabel) {
      throw new Error(`filed record has no label: ${JSON.stringify(json.filed[0]).slice(0, 300)}`);
    }
    log(`  personal concept: "${personalLabel}"`);
    await blobSynced;
    await shot(mobile, "member-mobile-personal-filed");
  });

  await step("member mobile sees the shared workspace and its members", mobile, async () => {
    await mobile.goto(`${EXPO_ORIGIN}/workspaces`, { waitUntil: "domcontentloaded" });
    try {
      await mobile.getByTestId("select-space-personal").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      // Fallback: reach the screen the way a user does, via Settings.
      await mobile.goto(`${EXPO_ORIGIN}/settings`, { waitUntil: "domcontentloaded" });
      await mobile.getByTestId("open-shared-workspaces").click();
      await mobile.getByTestId("select-space-personal").waitFor({ state: "visible", timeout: 30_000 });
    }
    await mobile.getByTestId(`select-space-${wsId}`).waitFor({ state: "visible", timeout: 30_000 });
    await mobile.getByTestId(`select-space-${wsId}`).click();
    await mobile.getByTestId(`row-member-${owner.id}`).waitFor({ state: "visible", timeout: 30_000 });
    await mobile.getByTestId(`row-member-${member.id}`).waitFor({ state: "visible", timeout: 15_000 });
    await shot(mobile, "member-mobile-workspace-selected");
  });

  await step("member mobile sees the shared knowledge and SOP", mobile, async () => {
    await mobile
      .locator(`[data-testid="row-workspace-cluster-${sharedCluster.id}"]`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await mobile
      .locator('[data-testid^="row-workspace-cluster-"]')
      .filter({ hasText: sharedCluster.label.slice(0, 20) })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await mobile
      .locator('[data-testid^="row-workspace-sop-"]')
      .filter({ hasText: SOP_TITLE })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await shot(mobile, "member-mobile-shared-content");
  });

  // -- Member desktop ---------------------------------------------------------
  const memberDesktopContext = await browser.newContext({
    viewport: { width: 1360, height: 880 },
    ignoreHTTPSErrors: true,
  });
  const memberDesktop = await memberDesktopContext.newPage();
  memberDesktop.setDefaultTimeout(30_000);
  memberDesktop.setDefaultNavigationTimeout(90_000);
  wireDiagnostics(memberDesktop, "member-desktop");
  await stubAiChatEndpoints(memberDesktop, {
    roster: ROSTER,
    events: deliberationEvents({ roster: ROSTER, turn: MEMBER_TURN }),
  });

  await step("member signs in on desktop and selects the shared space", memberDesktop, async () => {
    await memberDesktop.goto(`${DESKTOP_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitForClerk(memberDesktop);
    await clerkSignIn(memberDesktop, member);
    await memberDesktop.goto(`${DESKTOP_ORIGIN}/workspace/chat`, { waitUntil: "domcontentloaded" });
    await memberDesktop.getByTestId("input-message").waitFor({ state: "visible", timeout: 45_000 });
    await memberDesktop
      .locator(`[data-testid="select-shared-space-desktop"] option[value="${wsId}"]`)
      .waitFor({ state: "attached", timeout: 30_000 });
    await memberDesktop.getByTestId("select-shared-space-desktop").selectOption(wsId);
    await memberDesktop.getByTestId("chip-shared-space").waitFor({ state: "visible", timeout: 20_000 });
    await shot(memberDesktop, "member-desktop-shared-selected");
  });

  await step("member desktop Brain shows the shared concept", memberDesktop, async () => {
    await memberDesktop.getByTestId("link-nav-brain").click();
    await memberDesktop.getByTestId("badge-workspace-brain").waitFor({ state: "visible", timeout: 20_000 });
    await memberDesktop
      .getByLabel(`Node: ${sharedCluster.label}`)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await shot(memberDesktop, "member-desktop-shared-concept");
  });

  await step("member desktop sees the shared SOP", memberDesktop, async () => {
    await memberDesktop.getByTestId("link-nav-sops").click();
    await memberDesktop
      .locator('[data-testid^="card-workspace-sop-"]')
      .filter({ hasText: SOP_TITLE })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await shot(memberDesktop, "member-desktop-shared-sop");
  });

  // -- Removal ---------------------------------------------------------------
  await step("owner removes the member", ownerPage, async () => {
    await ownerPage.getByTestId("button-space-members-desktop").click();
    const row = ownerPage.getByTestId(`row-member-${member.id}`);
    await row.waitFor({ state: "visible", timeout: 15_000 });
    const removed = ownerPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(
          `/api/venom/workspaces/${wsId}/members/${member.id}`,
        ) && response.request().method() === "DELETE",
    );
    await ownerPage.getByTestId(`button-remove-member-${member.id}`).click();
    const response = await removed;
    if (response.status() !== 200 && response.status() !== 204) {
      throw new Error(`remove-member returned HTTP ${response.status()}`);
    }
    await row.waitFor({ state: "detached", timeout: 15_000 });
    await shot(ownerPage, "owner-removed-member");
    await closeDialog(ownerPage);
  });

  await step("member desktop next request is denied and evicts to personal", memberDesktop, async () => {
    const denied = memberDesktop.waitForResponse(
      (response) =>
        response.url().includes(`/api/venom/workspaces/${wsId}`) &&
        response.status() === 403,
      { timeout: 30_000 },
    );
    // Client-side navigation: the workspace-scoped Brain query remounts and
    // refetches; the workspace LIST query does not (provider stays mounted),
    // so the coded 403 — not a silent list fallback — must do the eviction.
    await memberDesktop.getByTestId("link-nav-brain").click();
    await denied;
    await textVisible(memberDesktop, "Shared workspace unavailable", 15_000);
    await memberDesktop
      .getByTestId("badge-workspace-brain")
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(async () => {
        const count = await memberDesktop.getByTestId("badge-workspace-brain").count();
        if (count > 0) throw new Error("workspace badge still rendered after eviction");
      });
    const selection = await memberDesktop
      .getByTestId("select-shared-space-desktop")
      .inputValue();
    // The personal option is the "__personal__" sentinel.
    if (selection !== "__personal__" && selection !== "") {
      throw new Error(`switcher still holds "${selection}" after eviction`);
    }
    await shot(memberDesktop, "member-desktop-evicted");
  });

  await step("member desktop personal Brain still works", memberDesktop, async () => {
    // After eviction the Brain page falls back to the personal map, which is
    // fed by the synced blob restored at sign-in (espresso filed on mobile).
    await memberDesktop
      .getByLabel(`Node: ${personalLabel}`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await shot(memberDesktop, "member-desktop-personal-brain");
  });

  await step("denial contract: coded 403 and the list drops the workspace", memberDesktop, async () => {
    const knowledge = await fetchJsonInPage(
      memberDesktop,
      `/api/venom/workspaces/${wsId}/knowledge`,
    );
    if (knowledge.status !== 403) {
      throw new Error(`expected 403, got ${knowledge.status}`);
    }
    if (knowledge.body?.code !== "workspace_access_denied") {
      throw new Error(`403 body missing code: ${JSON.stringify(knowledge.body).slice(0, 200)}`);
    }
    const list = await fetchJsonInPage(memberDesktop, "/api/venom/workspaces");
    if (list.status !== 200) throw new Error(`workspace list returned ${list.status}`);
    const entries = Array.isArray(list.body) ? list.body : list.body?.workspaces ?? [];
    if (entries.some((entry) => entry.id === wsId)) {
      throw new Error("removed workspace still present in the member's list");
    }
  });

  await step("member mobile next contact drops the cached workspace content", mobile, async () => {
    const denied = mobile.waitForResponse(
      (response) =>
        response.url().includes(`/venom/workspaces/${wsId}`) &&
        response.status() === 403,
      { timeout: 30_000 },
    );
    const toggle = mobile.getByTestId(`button-toggle-cluster-sensitivity-${sharedCluster.id}`);
    if ((await toggle.count()) > 0) {
      // A member-authorized mutation is the next server contact.
      await toggle.first().click();
    } else {
      // Fallback: a window focus refetches the workspace-scoped queries.
      await mobile.evaluate(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
    }
    await denied;
    await mobile.getByTestId("notice-access-lost").waitFor({ state: "visible", timeout: 20_000 });
    await mobile
      .getByTestId(`select-space-${wsId}`)
      .waitFor({ state: "detached", timeout: 30_000 });
    const clusterRows = await mobile.locator('[data-testid^="row-workspace-cluster-"]').count();
    if (clusterRows !== 0) {
      throw new Error(`workspace knowledge rows still rendered: ${clusterRows}`);
    }
    await shot(mobile, "member-mobile-evicted");
  });

  await step("member mobile personal Brain still works", mobile, async () => {
    await mobile.goto(`${EXPO_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await mobile.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });
    await mobile.getByTestId("workspace-tab-brain").click();
    await mobile.getByTestId("brain-search-input").waitFor({ state: "visible", timeout: 20_000 });
    await mobile.getByTestId("brain-search-input").fill(personalLabel.slice(0, 30));
    // Scope to the search-result rows: the hidden chat transcript also
    // contains the espresso text and would satisfy a bare getByText.
    await mobile
      .locator('[data-testid^="brain-search-result-"]')
      .filter({ hasText: personalLabel.slice(0, 24) })
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await shot(mobile, "member-mobile-personal-brain");
  });

  await step("owner keeps workspace access after the removal", ownerPage, async () => {
    const { status, body } = await fetchJsonInPage(
      ownerPage,
      `/api/venom/workspaces/${wsId}/knowledge`,
    );
    if (status !== 200) throw new Error(`owner knowledge GET returned ${status}`);
    if (clustersOf(body).length === 0) throw new Error("owner sees no workspace knowledge");
  });

  await browser.close();
}

main()
  .catch((error) => {
    log("RUN FAILED:", error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close().catch(() => {});
    await deleteAccountViaBackendApi(owner);
    await deleteAccountViaBackendApi(member);
    log("");
    log("=== Summary ===");
    for (const r of results) log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error.slice(0, 200)}` : ""}`);
    const failed = results.filter((r) => !r.pass).length;
    log(`${results.length - failed}/${results.length} steps passed`);
    if (failed > 0) process.exitCode = 1;
  });
