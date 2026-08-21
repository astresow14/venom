/**
 * Live two-client sync check: a deliberated answer survives the trip to a
 * second device (task: cross-device deliberation confirmation).
 *
 * What it does, against the REAL running dev servers and REAL API + database:
 *   1. Creates a fresh Clerk dev-instance test account (+clerk_test / 424242).
 *   2. Phone (Expo web, real signed-in mode): produces a deliberated turn.
 *      Only the AI endpoints (models/deliberation/respond/knowledge-extract)
 *      are stubbed for determinism — workspace GET/PUT flow through the real
 *      server. Waits until the deliberated message is actually uploaded.
 *   3. Desktop (Vite, real signed-in mode): signs into the same account,
 *      restores the cloud workspace, and must render the phone's deliberated
 *      message: collective answer, flagged disagreement, collapsible takes,
 *      citation markers resolved to archived labels (no raw [source:id]).
 *   4. Reverse trip: desktop produces its own deliberated turn (different
 *      voices/marker), waits for the upload, then the phone reloads and must
 *      render it.
 *   5. Legacy payload: strips every `deliberation` field from the cloud state
 *      via a raw revision-checked PUT, then fresh sign-ins on both clients
 *      must load the workspace cleanly (plain messages, no deliberation UI,
 *      no crash).
 *
 * Run (all three artifact dev workflows must be up):
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) \
 *     node scripts/live/cross-device-deliberation.mjs
 *
 * Not part of any CI suite: this is a live verification harness.
 */

import { chromium } from "@playwright/test";
import fs from "node:fs";

const EXPO_ORIGIN = `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`;
const DESKTOP_ORIGIN = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const SHOTS = "/tmp/task143";

if (!process.env.REPLIT_EXPO_DEV_DOMAIN || !process.env.REPLIT_DEV_DOMAIN) {
  console.error("Missing REPLIT_EXPO_DEV_DOMAIN / REPLIT_DEV_DOMAIN");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Fixtures: two deterministic deliberated turns, one per direction.
// voiceId and modelId are CLOSED server-schema enums (direct|skeptic|evidence,
// venom-*): anything else makes every workspace PUT fail with 400. The two
// turns are told apart by their unique take/collective text, not voice ids.
// Citation marker ids exist on no device, so rendering must fall back to the
// archived label — never the raw marker.
// ---------------------------------------------------------------------------

const ROSTER = [
  { voiceId: "direct", name: "First take", tagline: "Answers head-on", modelId: "venom-gpt", modelName: "Venom GPT" },
  { voiceId: "skeptic", name: "Skeptic", tagline: "Attacks assumptions", modelId: "venom-claude", modelName: "Venom Claude" },
  { voiceId: "evidence", name: "Evidence", tagline: "Sticks to sources", modelId: "venom-gemini", modelName: "Venom Gemini" },
];

const MOBILE = {
  collective: "Collective answer: launch the survey at dawn low water.",
  direct: "Ship the coastal survey now; the tide window is generous.",
  evidence: "The tide tables [source:m143-tide] say low water is at dawn.",
  disagreement:
    "First take wanted to launch at once; Evidence held out for the dawn low-water window.",
  prompt: "Should we launch the coastal survey?",
  roster: ROSTER,
};

const DESKTOP = {
  collective: "Collective answer: checksum the ledger, then fold it into the atlas.",
  direct: "Fold the archive into the atlas tonight; it is ready.",
  evidence: "The ledger [source:d143-ledger] wants a checksum pass first.",
  disagreement:
    "First take pushed to merge tonight; Evidence demanded the checksum pass first.",
  prompt: "Fold the archive into the atlas tonight?",
  roster: ROSTER,
};

function deliberationEvents({ roster, takes, failedVoiceId, collective, disagreements }) {
  const events = [
    { modelId: "venom-gpt", modelName: "Venom GPT", deliberation: { voices: roster } },
  ];
  for (const [voiceId, content] of takes) {
    events.push({ voice: voiceId, content });
    events.push({ voice: voiceId, voiceStatus: "ok" });
  }
  events.push({ voice: failedVoiceId, voiceStatus: "failed" });
  events.push({ stage: "synthesis" });
  events.push({ content: collective });
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
      disagreements,
    },
  });
  events.push({ done: true });
  return events;
}

const MOBILE_EVENTS = deliberationEvents({
  roster: MOBILE.roster,
  takes: [
    ["direct", MOBILE.direct],
    ["evidence", MOBILE.evidence],
  ],
  failedVoiceId: "skeptic",
  collective: MOBILE.collective,
  disagreements: [MOBILE.disagreement],
});

const DESKTOP_EVENTS = deliberationEvents({
  roster: DESKTOP.roster,
  takes: [
    ["direct", DESKTOP.direct],
    ["evidence", DESKTOP.evidence],
  ],
  failedVoiceId: "skeptic",
  collective: DESKTOP.collective,
  disagreements: [DESKTOP.disagreement],
});

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

/** Stub only the AI endpoints; the workspace sync stays live. */
async function stubAiEndpoints(page, { roster, events, mode = "multi-model" }) {
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
        mode,
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
  await page.route("**/api/venom/knowledge/extract", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ clusters: [] }),
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

/**
 * Programmatic sign-UP from a headless browser trips Clerk's invisible
 * CAPTCHA (captcha_invalid). Bot protection only applies to sign-ups, so the
 * test account is created server-side via the Backend API instead, and both
 * clients only ever sign IN with the password.
 */
async function createAccountViaBackendApi(email, password) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not available");
  const response = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email_address: [email], password }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Clerk user creation failed (${response.status}): ${detail.slice(0, 400)}`);
  }
}

/**
 * Password sign-in; a fresh headless client is untrusted, so Clerk may demand
 * an email-code trust step — +clerk_test accounts accept 424242 for it (the
 * same flow the mobile sign-in screen implements).
 */
async function clerkSignIn(page, email, password) {
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
    { email, password },
  );
  if (!outcome.ok) throw new Error(`Clerk sign-in failed: ${outcome.detail}`);
}

/** Resolve once a workspace PUT whose body contains `needle` succeeds. */
function workspacePutWaiter(page, needle, timeout = 90_000) {
  return page.waitForResponse(
    (response) => {
      try {
        return (
          response.url().includes("/api/venom/workspace") &&
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

function workspaceGetWaiter(page, timeout = 60_000) {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/api/venom/workspace") &&
      response.request().method() === "GET" &&
      response.status() === 200,
    { timeout },
  );
}

async function textVisible(page, text, timeout = 20_000) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
}

async function lastTestIdContains(page, testId, needle) {
  const el = page.getByTestId(testId).last();
  await el.waitFor({ state: "visible", timeout: 15_000 });
  const content = (await el.textContent()) ?? "";
  if (!content.includes(needle)) {
    throw new Error(`[${testId}] expected to contain "${needle}", got: ${content.slice(0, 400)}`);
  }
  return content;
}

async function noRawMarker(page, testId) {
  const el = page.getByTestId(testId).last();
  const content = (await el.textContent()) ?? "";
  if (content.includes("[source:")) {
    throw new Error(`[${testId}] renders a raw citation marker: ${content.slice(0, 400)}`);
  }
}

/** Scroll the mobile chat list to the bottom (RN Web nested scroll views). */
async function scrollMobileChatToBottom(page) {
  await page
    .getByTestId("workspace-chat")
    .first()
    .evaluate((root) => {
      const scrollables = [root, ...root.querySelectorAll("*")].filter(
        (el) => el.scrollHeight > el.clientHeight + 4,
      );
      for (const el of scrollables) el.scrollTop = el.scrollHeight;
    })
    .catch(() => {});
}

/** Iterate desktop projects/conversations until `needle` is on screen. */
async function findOnDesktop(page, needle) {
  const probe = async () =>
    await page
      .getByText(needle, { exact: false })
      .first()
      .isVisible()
      .catch(() => false);
  if (await probe()) return;
  const select = page.getByTestId("select-project-desktop");
  await select.waitFor({ state: "visible", timeout: 45_000 });
  const values = await select
    .locator("option")
    .evaluateAll((options) => options.map((o) => o.value));
  for (const value of values) {
    await select.selectOption(value);
    await page.waitForTimeout(700);
    if (await probe()) return;
    const conversations = page.locator('[data-testid^="button-conversation-"]');
    const count = await conversations.count();
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      await conversations.nth(i).click();
      try {
        await page
          .getByText(needle, { exact: false })
          .first()
          .waitFor({ state: "visible", timeout: 2_500 });
        return;
      } catch {
        /* try the next conversation */
      }
    }
  }
  throw new Error(`Not found in any project/conversation: "${needle}"`);
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const account = {
  email: `venom.task143.${Date.now()}+clerk_test@example.com`,
  password: `Task143!SymbioteSync${Date.now() % 9973}`,
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  log("Live cross-device deliberation check");
  log(`  phone:   ${EXPO_ORIGIN}`);
  log(`  desktop: ${DESKTOP_ORIGIN}`);
  log(`  account: ${account.email}`);

  await step("test account exists (Clerk Backend API)", null, async () => {
    await createAccountViaBackendApi(account.email, account.password);
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  const phoneContext = await browser.newContext({
    viewport: { width: 400, height: 720 },
    ignoreHTTPSErrors: true,
  });
  const phone = await phoneContext.newPage();
  phone.setDefaultTimeout(30_000);
  phone.setDefaultNavigationTimeout(120_000);
  wireDiagnostics(phone, "phone");
  await stubAiEndpoints(phone, { roster: MOBILE.roster, events: MOBILE_EVENTS });

  // -- Phone: fresh account, real signed-in shell --------------------------
  await step("phone loads and Clerk is ready", phone, async () => {
    await phone.goto(`${EXPO_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitForClerk(phone);
  });

  await step("phone signs into the test account", phone, async () => {
    await clerkSignIn(phone, account.email, account.password);
    try {
      await phone.getByTestId("chat-input").waitFor({ state: "visible", timeout: 20_000 });
    } catch {
      await phone.reload({ waitUntil: "domcontentloaded" });
      await phone.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await shot(phone, "phone-signed-in");
  });

  // -- Phone: deliberated turn, then wait for the real upload --------------
  let phonePut;
  await step("phone produces a deliberated turn", phone, async () => {
    const toggle = phone.getByTestId("toggle-deliberation");
    await toggle.waitFor({ state: "visible", timeout: 30_000 });
    await toggle.click();
    await phone.getByTestId("chat-input").fill(MOBILE.prompt);
    phonePut = workspacePutWaiter(phone, MOBILE.collective);
    await phone.getByTestId("send-message-button").click();
    await textVisible(phone, MOBILE.collective, 45_000);
    await lastTestIdContains(phone, "deliberation-disagreements", MOBILE.disagreement);
    await shot(phone, "phone-deliberated-turn");
  });

  await step("phone uploads the deliberated message to the cloud", phone, async () => {
    await phonePut;
  });

  // -- Desktop: same account, restore from the cloud ------------------------
  const desktopContext = await browser.newContext({
    viewport: { width: 1360, height: 880 },
    ignoreHTTPSErrors: true,
  });
  const desktop = await desktopContext.newPage();
  desktop.setDefaultTimeout(30_000);
  desktop.setDefaultNavigationTimeout(90_000);
  wireDiagnostics(desktop, "desktop");
  await stubAiEndpoints(desktop, { roster: DESKTOP.roster, events: DESKTOP_EVENTS });

  await step("desktop signs into the same account", desktop, async () => {
    await desktop.goto(`${DESKTOP_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await waitForClerk(desktop);
    await clerkSignIn(desktop, account.email, account.password);
  });

  await step("desktop restores the cloud workspace", desktop, async () => {
    const restore = workspaceGetWaiter(desktop);
    await desktop.goto(`${DESKTOP_ORIGIN}/workspace/chat`, { waitUntil: "domcontentloaded" });
    await restore;
    await desktop.getByTestId("input-message").waitFor({ state: "visible", timeout: 45_000 });
  });

  await step("desktop shows the phone's collective answer", desktop, async () => {
    await findOnDesktop(desktop, MOBILE.collective);
    await shot(desktop, "desktop-synced-message");
  });

  await step("desktop flags the phone turn's disagreement", desktop, async () => {
    await desktop.getByTestId("deliberation-result").last().waitFor({ state: "visible" });
    await lastTestIdContains(desktop, "deliberation-disagreements", MOBILE.disagreement);
  });

  await step("desktop expands the phone turn's takes intact", desktop, async () => {
    await desktop.getByTestId("button-toggle-takes").last().click();
    await lastTestIdContains(desktop, "deliberation-take-direct", "Ship the coastal survey");
    await lastTestIdContains(desktop, "deliberation-take-direct", "Venom GPT");
    await lastTestIdContains(
      desktop,
      "deliberation-take-skeptic",
      "This voice didn't finish its take.",
    );
    await shot(desktop, "desktop-takes-expanded");
  });

  await step("desktop resolves synced markers to archived labels", desktop, async () => {
    await lastTestIdContains(desktop, "deliberation-take-evidence", "(archived source)");
    await noRawMarker(desktop, "deliberation-take-evidence");
    await noRawMarker(desktop, "deliberation-result");
    const rawMarkers = await desktop.getByText("[source:", { exact: false }).count();
    if (rawMarkers !== 0) {
      throw new Error(`raw citation markers present on the desktop: ${rawMarkers}`);
    }
  });

  // -- Reverse trip: desktop deliberates, phone reloads ---------------------
  let desktopPut;
  await step("desktop produces its own deliberated turn", desktop, async () => {
    const toggle = desktop.getByTestId("button-deliberate-toggle");
    await toggle.waitFor({ state: "visible", timeout: 30_000 });
    await toggle.click();
    const composer = desktop.getByTestId("input-message");
    await composer.fill(DESKTOP.prompt);
    desktopPut = workspacePutWaiter(desktop, DESKTOP.collective);
    await composer.press("Enter");
    await textVisible(desktop, DESKTOP.collective, 45_000);
    await shot(desktop, "desktop-own-deliberated-turn");
  });

  await step("desktop uploads its deliberated message", desktop, async () => {
    await desktopPut;
  });

  await step("phone reloads and shows the desktop collective answer", phone, async () => {
    const restore = workspaceGetWaiter(phone);
    await phone.reload({ waitUntil: "domcontentloaded" });
    await restore;
    await phone.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });
    await scrollMobileChatToBottom(phone);
    await textVisible(phone, DESKTOP.collective, 30_000);
    await shot(phone, "phone-synced-desktop-message");
  });

  await step("phone renders the synced disagreement and takes", phone, async () => {
    await textVisible(phone, DESKTOP.disagreement, 15_000);
    await scrollMobileChatToBottom(phone);
    // Both deliberated messages share the enum voice ids and the list's DOM
    // order is not guaranteed to be oldest-first, so expand every message's
    // takes and assert by unique take text instead of position.
    const toggles = phone.getByTestId("toggle-deliberation-takes");
    const toggleCount = await toggles.count();
    if (toggleCount < 2) {
      throw new Error(`expected 2 deliberated messages on the phone, saw ${toggleCount}`);
    }
    for (let i = 0; i < toggleCount; i += 1) await toggles.nth(i).click();
    await phone
      .getByTestId("deliberation-take-direct")
      .filter({ hasText: "Fold the archive" })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    const desktopEvidence = phone
      .getByTestId("deliberation-take-evidence")
      .filter({ hasText: "ledger" })
      .first();
    await desktopEvidence.waitFor({ state: "visible", timeout: 10_000 });
    const evidenceText = (await desktopEvidence.textContent()) ?? "";
    if (!evidenceText.includes("(archived source)")) {
      throw new Error(`desktop evidence take lacks archived label: ${evidenceText.slice(0, 300)}`);
    }
    const failedTakes = await phone
      .getByTestId("deliberation-take-skeptic")
      .filter({ hasText: "This voice didn't finish its take." })
      .count();
    if (failedTakes !== 2) {
      throw new Error(`expected both turns' skeptic takes to read failed, saw ${failedTakes}`);
    }
    const rawMarkers = await phone.getByText("[source:", { exact: false }).count();
    if (rawMarkers !== 0) {
      throw new Error(`raw citation markers present on the phone: ${rawMarkers}`);
    }
    await shot(phone, "phone-takes-expanded");
  });

  // -- Legacy payload: strip `deliberation` everywhere, fresh loads ---------
  await step("cloud accepts a legacy payload without the field", desktop, async () => {
    const outcome = await desktop.evaluate(async () => {
      const current = await fetch("/api/venom/workspace").then((r) => r.json());
      const stripped = JSON.parse(
        JSON.stringify(current.state, (key, value) =>
          key === "deliberation" ? undefined : value,
        ),
      );
      const response = await fetch("/api/venom/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: stripped, baseRevision: current.revision }),
      });
      return { status: response.status, hadField: JSON.stringify(current.state).includes('"deliberation"') };
    });
    if (!outcome.hadField) throw new Error("precondition: cloud state had no deliberation field");
    if (outcome.status !== 200) throw new Error(`stripped PUT rejected: ${outcome.status}`);
  });

  await step("fresh desktop loads the legacy payload cleanly", desktop, async () => {
    const freshContext = await browser.newContext({
      viewport: { width: 1360, height: 880 },
      ignoreHTTPSErrors: true,
    });
    const fresh = await freshContext.newPage();
    fresh.setDefaultTimeout(30_000);
    wireDiagnostics(fresh, "desktop-fresh");
    try {
      await fresh.goto(`${DESKTOP_ORIGIN}/`, { waitUntil: "domcontentloaded" });
      await waitForClerk(fresh);
      await clerkSignIn(fresh, account.email, account.password);
      const restore = workspaceGetWaiter(fresh);
      await fresh.goto(`${DESKTOP_ORIGIN}/workspace/chat`, { waitUntil: "domcontentloaded" });
      await restore;
      await fresh.getByTestId("input-message").waitFor({ state: "visible", timeout: 45_000 });
      await findOnDesktop(fresh, MOBILE.collective);
      await textVisible(fresh, DESKTOP.collective, 10_000);
      const deliberationBlocks = await fresh.getByTestId("deliberation-result").count();
      if (deliberationBlocks !== 0) {
        throw new Error(`expected no deliberation UI, found ${deliberationBlocks}`);
      }
      await shot(fresh, "desktop-legacy-clean");
    } finally {
      await freshContext.close();
    }
  });

  await step("fresh phone loads the legacy payload cleanly", phone, async () => {
    const freshContext = await browser.newContext({
      viewport: { width: 400, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const fresh = await freshContext.newPage();
    fresh.setDefaultTimeout(30_000);
    fresh.setDefaultNavigationTimeout(120_000);
    wireDiagnostics(fresh, "phone-fresh");
    try {
      await fresh.goto(`${EXPO_ORIGIN}/`, { waitUntil: "domcontentloaded" });
      await waitForClerk(fresh);
      const restore = workspaceGetWaiter(fresh);
      await clerkSignIn(fresh, account.email, account.password);
      await restore.catch(() => {});
      await fresh.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });
      await scrollMobileChatToBottom(fresh);
      await fresh
        .getByText(DESKTOP.collective, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: 30_000 });
      const deliberationBlocks = await fresh.getByTestId("deliberation-result").count();
      if (deliberationBlocks !== 0) {
        throw new Error(`expected no deliberation UI, found ${deliberationBlocks}`);
      }
      await shot(fresh, "phone-legacy-clean");
    } finally {
      await freshContext.close();
    }
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
    log("");
    log("=== Summary ===");
    for (const r of results) log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error.slice(0, 200)}` : ""}`);
    const failed = results.filter((r) => !r.pass).length;
    log(`${results.length - failed}/${results.length} steps passed`);
    if (failed > 0) process.exitCode = 1;
  });
