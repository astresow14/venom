import { expect, test, type Page } from "@playwright/test";

/**
 * Blast-radius contract for the always-mounted workspace pager.
 *
 * Every workspace surface stays mounted from startup, so a render- or
 * effect-time throw in ONE of them used to escape to the root error
 * boundary and replace the entire app with "Something went wrong" — the
 * shape of the original slime incident, where a hidden Brain layer's
 * startup throw blanked chat and feed too. Each surface now sits behind
 * its own boundary (WorkspaceErrorBoundary): the broken surface degrades
 * to a scoped fallback with a retry, and everything else keeps working.
 *
 * Crashes are forced through the boundary's UI-test probe: setting
 * `__venomCrashWorkspace` before any app code runs makes exactly one
 * surface throw, at effect time by default or during render with the
 * `:render` suffix.
 */

declare global {
  interface Window {
    __venomCrashWorkspace?: string;
  }
}

const ROOT_FALLBACK_TEXT = "Please reload the app to continue.";
const SURFACES = ["chat", "feed", "notifications", "brain", "todo"] as const;

function armCrash(page: Page, directive: string) {
  return page.addInitScript((value) => {
    window.__venomCrashWorkspace = value;
  }, directive);
}

function workspaceTab(page: Page, title: string) {
  return page.getByRole("tab", { name: `Open ${title} workspace` });
}

/** The whole-app failure state this suite exists to rule out. */
async function expectShellAlive(page: Page) {
  await expect(page.getByRole("tab")).toHaveCount(5);
  await expect(page.getByText(ROOT_FALLBACK_TEXT)).toHaveCount(0);
}

test("an effect crash in the hidden Feed surface degrades only Feed", async ({
  page,
}) => {
  await armCrash(page, "feed");
  await page.goto("/?venomUiTest=true&brainFixture=dense");

  // Feed's effect already threw during startup (all surfaces mount
  // immediately), yet the app still boots into a working Chat workspace.
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expectShellAlive(page);

  // The broken surface shows its own scoped fallback, inside a live shell.
  await workspaceTab(page, "Feed").click();
  const fallback = page.getByTestId("workspace-error-feed");
  await expect(fallback).toBeVisible();
  await expect(fallback.getByText("Feed hit a problem")).toBeVisible();
  await expect(
    fallback.getByRole("button", { name: "Retry the Feed workspace" }),
  ).toBeVisible();
  await expectShellAlive(page);

  // Only the feed boundary tripped — no other surface shows a fallback.
  for (const surface of SURFACES) {
    if (surface === "feed") continue;
    await expect(page.getByTestId(`workspace-error-${surface}`)).toHaveCount(0);
  }

  // Neighbouring workspaces are not just visible but interactive: the board
  // renders its controls, and Chat still offers its composer.
  await workspaceTab(page, "To-Do").click();
  await expect(page.getByTestId("board-settings-button")).toBeVisible();
  await workspaceTab(page, "Chat").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
});

test("a crashed workspace recovers in place through its own retry", async ({
  page,
}) => {
  await armCrash(page, "feed");
  await page.goto("/?venomUiTest=true");

  await workspaceTab(page, "Feed").click();
  await expect(page.getByTestId("workspace-error-feed")).toBeVisible();

  // Once the fault clears, retry remounts the surface — no app reload.
  await page.evaluate(() => {
    window.__venomCrashWorkspace = undefined;
  });
  await page.getByTestId("workspace-error-retry-feed").click();

  await expect(page.getByTestId("community-briefing")).toBeVisible();
  await expect(page.getByTestId("workspace-error-feed")).toHaveCount(0);
  await expectShellAlive(page);
});

test("a render crash in Brain leaves Chat and Feed fully usable", async ({
  page,
}) => {
  await armCrash(page, "brain:render");
  await page.goto("/?venomUiTest=true");

  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expectShellAlive(page);

  // Brain never mounted its map — only its scoped fallback renders.
  await workspaceTab(page, "Brain").click();
  await expect(page.getByTestId("workspace-error-brain")).toBeVisible();
  await expect(page.getByTestId("knowledge-map")).toHaveCount(0);

  // The rest of the app still works end-to-end.
  await workspaceTab(page, "Feed").click();
  await expect(page.getByTestId("community-briefing")).toBeVisible();
  await workspaceTab(page, "Chat").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expectShellAlive(page);
});
