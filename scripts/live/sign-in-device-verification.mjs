/**
 * Live check: the redesigned sign-in screen's "Verify this device" step still
 * lets people in (task: email security-code check after the Strike-first
 * redesign).
 *
 * What it does, against the REAL Expo web dev server and REAL Clerk dev
 * instance (nothing is stubbed):
 *   1. Creates a fresh Clerk dev-instance test account (+clerk_test / 424242)
 *      via the Backend API — sign-ups from headless browsers trip CAPTCHA,
 *      and password sign-in from a fresh headless client is exactly what
 *      triggers the email-code device-trust requirement this task needs.
 *   2. Drives the real UI at a phone viewport: welcome -> "Continue with
 *      email" -> credentials -> "Verify this device".
 *   3. Wrong code first: shows an error, does not crash, stays on the step.
 *   4. "Start over" returns to the welcome state.
 *   5. Second pass reaches the step again; layout is asserted at phone width
 *      with the full viewport AND with a keyboard-sized viewport (focused
 *      code field must stay visible; actions must remain reachable; no
 *      horizontal overflow).
 *   6. The correct test code (424242) completes sign-in and lands in the
 *      signed-in app shell.
 *
 * Run (the `artifacts/venom: expo` workflow must be up; the API server
 * workflow should be up too so the post-sign-in shell loads cleanly):
 *   node scripts/live/sign-in-device-verification.mjs
 *
 * Not part of any CI suite: this is a live verification harness.
 */

import { chromium } from "@playwright/test";
import fs from "node:fs";

const EXPO_ORIGIN = `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}`;
const SHOTS = "/tmp/task133";

if (!process.env.REPLIT_EXPO_DEV_DOMAIN) {
  console.error("Missing REPLIT_EXPO_DEV_DOMAIN");
  process.exit(2);
}

const PHONE_VIEWPORT = { width: 400, height: 720 };
// A 720px phone with the soft keyboard open keeps roughly the top 400px of
// layout viewport; browsers shrink the viewport and scroll the focused field
// into view, which is what RN Web's ScrollView sees too.
const KEYBOARD_VIEWPORT = { width: 400, height: 400 };
const WRONG_CODE = "111111";
const TEST_CODE = "424242"; // fixed verification code for +clerk_test accounts

const account = {
  email: `venom.task133.${Date.now()}+clerk_test@example.com`,
  password: `Task133!DeviceTrust${Date.now() % 9973}`, // instance policy: >= 15 chars
  userId: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const results = [];
const pageErrors = [];
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

function wireDiagnostics(page, label) {
  const seen = new Map();
  const say = (key, line) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count <= 3) log(line + (count === 3 ? " (suppressing repeats)" : ""));
  };
  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.message ?? error));
    say(`pageerror:${error.message}`, `[${label}] pageerror: ${error.message.slice(0, 300)}`);
  });
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

async function createAccountViaBackendApi() {
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
  account.userId = body.id ?? null;
}

async function deleteAccountViaBackendApi() {
  if (!account.userId || !process.env.CLERK_SECRET_KEY) return;
  await fetch(`https://api.clerk.com/v1/users/${account.userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
  }).catch(() => {});
}

/** Bounding box of a testid/locator, or null when detached. */
async function box(locator) {
  return await locator.boundingBox();
}

function within(b, viewport, slack = 1) {
  return (
    b &&
    b.x >= -slack &&
    b.y >= -slack &&
    b.x + b.width <= viewport.width + slack &&
    b.y + b.height <= viewport.height + slack
  );
}

/** Fill the credentials form and submit; assumes the email step is visible. */
async function submitCredentials(page) {
  await page.getByTestId("sign-in-email").fill(account.email);
  await page.getByTestId("sign-in-password").fill(account.password);
  await page.getByTestId("submit-sign-in").click();
}

async function waitForVerifyStep(page) {
  await page.getByText("Verify this device").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("We emailed you a code.").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("sign-in-code").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("verify-sign-in").waitFor({ state: "visible", timeout: 10_000 });
  await page
    .getByRole("button", { name: "Start sign-in over" })
    .waitFor({ state: "visible", timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  log("Live sign-in device-verification check");
  log(`  phone:   ${EXPO_ORIGIN}`);
  log(`  account: ${account.email}`);

  await step("test account exists (Clerk Backend API)", null, async () => {
    await createAccountViaBackendApi();
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({
    viewport: PHONE_VIEWPORT,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(120_000);
  wireDiagnostics(page, "phone");

  await step("signed-out phone lands on the welcome step", page, async () => {
    await page.goto(`${EXPO_ORIGIN}/`, { waitUntil: "domcontentloaded" });
    await page.getByText("Strike first").waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("continue-with-email").waitFor({ state: "visible" });
    await shot(page, "welcome");
  });

  await step("credentials submit reaches Verify this device", page, async () => {
    await page.getByTestId("continue-with-email").click();
    await page.getByTestId("sign-in-email").waitFor({ state: "visible", timeout: 10_000 });
    await submitCredentials(page);
    await waitForVerifyStep(page);
    await shot(page, "verify-step");
  });

  await step("wrong code shows an error without crashing", page, async () => {
    const errorsBefore = pageErrors.length;
    await page.getByTestId("sign-in-code").fill(WRONG_CODE);
    await page.getByTestId("verify-sign-in").click();
    const error = page.getByTestId("sign-in-error");
    await error.waitFor({ state: "visible", timeout: 20_000 });
    const text = ((await error.textContent()) ?? "").trim();
    if (!text) throw new Error("error element is visible but empty");
    log(`  error shown: "${text}"`);
    // Still on the verify step, still interactive, and no page crash.
    await page.getByText("Verify this device").waitFor({ state: "visible", timeout: 5_000 });
    await page.getByTestId("sign-in-code").waitFor({ state: "visible" });
    if (pageErrors.length > errorsBefore) {
      throw new Error(`page errors during wrong-code attempt: ${pageErrors.slice(errorsBefore).join(" | ")}`);
    }
    await shot(page, "verify-wrong-code-error");
  });

  await step("Start over returns to the welcome step", page, async () => {
    await page.getByRole("button", { name: "Start sign-in over" }).click();
    await page.getByText("Strike first").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("continue-with-email").waitFor({ state: "visible" });
    const staleCode = await page.getByTestId("sign-in-code").count();
    if (staleCode !== 0) throw new Error("code field still mounted after Start over");
    await shot(page, "back-on-welcome");
  });

  await step("second pass reaches the verify step again", page, async () => {
    await page.getByTestId("continue-with-email").click();
    await page.getByTestId("sign-in-email").waitFor({ state: "visible", timeout: 10_000 });
    await submitCredentials(page);
    await waitForVerifyStep(page);
  });

  await step("verify step lays out at phone width", page, async () => {
    // Everything on screen at once at 400x720 — no scrolling required.
    for (const [label, locator] of [
      ["headline", page.getByText("Verify this device")],
      ["support", page.getByText("We emailed you a code.")],
      ["code field", page.getByTestId("sign-in-code")],
      ["verify pill", page.getByTestId("verify-sign-in")],
      ["start over", page.getByRole("button", { name: "Start sign-in over" })],
    ]) {
      const b = await box(locator);
      if (!within(b, PHONE_VIEWPORT)) {
        throw new Error(`${label} not fully inside 400x720: ${JSON.stringify(b)}`);
      }
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px at phone width`);
  });

  await step("layout holds with the keyboard open", page, async () => {
    await page.setViewportSize(KEYBOARD_VIEWPORT);
    await page.getByTestId("sign-in-code").click(); // focus = keyboard up on device
    await page.waitForTimeout(400);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? el.getAttribute("data-testid") : null;
    });
    if (focused !== "sign-in-code") throw new Error(`focus went to ${focused ?? "nowhere"}`);
    // The focused field must be visible in the shrunken viewport.
    const codeBox = await box(page.getByTestId("sign-in-code"));
    if (!within(codeBox, KEYBOARD_VIEWPORT)) {
      throw new Error(`focused code field off-screen with keyboard open: ${JSON.stringify(codeBox)}`);
    }
    await shot(page, "keyboard-open-code-focused");
    // The actions must stay reachable by scrolling while the keyboard is up.
    await page.getByTestId("verify-sign-in").scrollIntoViewIfNeeded();
    const verifyBox = await box(page.getByTestId("verify-sign-in"));
    if (!within(verifyBox, KEYBOARD_VIEWPORT)) {
      throw new Error(`Verify device pill unreachable with keyboard open: ${JSON.stringify(verifyBox)}`);
    }
    const startOver = page.getByRole("button", { name: "Start sign-in over" });
    await startOver.scrollIntoViewIfNeeded();
    const startOverBox = await box(startOver);
    if (!within(startOverBox, KEYBOARD_VIEWPORT)) {
      throw new Error(`Start over unreachable with keyboard open: ${JSON.stringify(startOverBox)}`);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) throw new Error(`horizontal overflow of ${overflow}px with keyboard open`);
    await shot(page, "keyboard-open-actions-reachable");
    await page.setViewportSize(PHONE_VIEWPORT);
  });

  await step("correct code completes sign-in", page, async () => {
    await page.getByTestId("sign-in-code").fill(TEST_CODE);
    await page.getByTestId("verify-sign-in").click();
    // Sign-in completion lands in the app shell (chat input). The workspace
    // restore can lag on a cold API server; allow one reload like the other
    // live harness does.
    try {
      await page.getByTestId("chat-input").waitFor({ state: "visible", timeout: 45_000 });
    } catch {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("chat-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    const session = await page.evaluate(() => Boolean(globalThis.Clerk?.session));
    if (!session) throw new Error("no active Clerk session after verification");
    await shot(page, "signed-in-shell");
  });

  await step("no page crashes across the whole flow", page, async () => {
    if (pageErrors.length > 0) {
      throw new Error(`page errors seen: ${pageErrors.join(" | ").slice(0, 600)}`);
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
    await deleteAccountViaBackendApi();
    log("");
    log("=== Summary ===");
    for (const r of results) {
      log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error.slice(0, 200)}` : ""}`);
    }
    const failed = results.filter((r) => !r.pass).length;
    log(`${results.length - failed}/${results.length} steps passed`);
    if (failed > 0) process.exitCode = 1;
  });
