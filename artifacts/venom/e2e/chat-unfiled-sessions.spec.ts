import { expect, test, type Page } from "@playwright/test";

/**
 * A way back for sessions that belong to no project.
 *
 * The sessions sheet lists strictly the on-screen project's own sessions,
 * and a project-less session is never adopted by a project — which is
 * correct, but left sessions stranded with projectId null (the old desktop
 * behaviour, or a restored/merged cloud snapshot) listed nowhere once any
 * project exists. The sheet's Unfiled section lists them again: reopening
 * one shows its words without adopting it, and the explicit "File" action is
 * the only path that gives it a home — in the project on screen. Filing
 * rewrites projectId through the same scoped device storage every other edit
 * uses (`@venom_state_v2:<userId>`), with an updatedAt bump so the
 * cross-device merge keeps the new home.
 */

const STORAGE_KEY = "@venom_state_v2:venom-ui-test";
const NOW = 1_755_600_000_000; // fixed timestamp keeps the seed deterministic

const ORPHAN_NOTE = "Loose thought with no project";

/** One project with only its current session, plus a stranded session. */
const WORKSPACE_STATE = {
  projects: [
    {
      id: "proj_alpha",
      name: "Aurora Systems",
      description: "Active research workspace",
      accent: "#73736f",
      sourceCount: 0,
      updatedAt: NOW,
    },
  ],
  conversations: [
    {
      id: "conv_alpha",
      title: "Alpha planning",
      projectId: "proj_alpha",
      updatedAt: NOW - 7_200_000,
      messages: [
        {
          id: "msg_alpha_q",
          role: "user",
          content: "Where did the alpha survey land?",
          createdAt: NOW - 7_200_000,
          status: "sent",
        },
      ],
    },
    {
      // Stranded by the old behaviour (or a restored snapshot): the newest
      // session of all, belonging to no project, and therefore absent from
      // every project's session list.
      id: "conv_orphan",
      title: "Scratch notes",
      projectId: null,
      updatedAt: NOW,
      messages: [
        {
          id: "msg_orphan",
          role: "user",
          content: ORPHAN_NOTE,
          createdAt: NOW,
          status: "sent",
        },
      ],
    },
  ],
  clusters: [],
  sources: [],
  activeProjectId: "proj_alpha",
  activeConversationId: "conv_alpha",
};

function readOrphanFiling(page: Page) {
  return page.evaluate(
    ({ key, seededAt }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const state = JSON.parse(raw) as {
        activeProjectId: string | null;
        activeConversationId: string | null;
        conversations: Array<{
          id: string;
          projectId: string | null;
          updatedAt: number;
          messages: Array<{ id: string }>;
        }>;
      };
      const orphan = state.conversations.find(
        (conversation) => conversation.id === "conv_orphan",
      );
      return {
        orphanProject: orphan ? orphan.projectId : "missing",
        // Filing must move updatedAt forward or the cross-device merge
        // would let a stale stranded copy win the session back.
        orphanUpdatedAtBumped: (orphan?.updatedAt ?? 0) > seededAt,
        orphanMessageCount: orphan?.messages.length ?? -1,
        activeProjectId: state.activeProjectId,
        activeConversationId: state.activeConversationId,
      };
    },
    { key: STORAGE_KEY, seededAt: NOW },
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The sessions sheet journey is covered at the mobile viewport.",
  );
});

test("a stranded session is listed under Unfiled, reopens without being adopted, and filing moves it into the on-screen project", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: JSON.stringify(WORKSPACE_STATE) },
  );

  await page.goto("/?venomUiTest=true");
  await expect(page.getByTestId("chat-input")).toBeVisible();
  // Hydration finished once the seeded project is the one on screen.
  await expect(page.getByTestId("open-projects")).toContainText(
    "Aurora Systems",
  );

  // The project's only session is the current one, so nothing is reopenable
  // inside the project — the Sessions pill appears because the stranded
  // session still needs a way back.
  await page.getByTestId("open-session-history").click();
  await expect(page.getByTestId("session-history-sheet")).toBeVisible();
  await expect(page.getByTestId("session-unfiled-section")).toBeVisible();
  const unfiledRow = page.getByTestId("session-unfiled-item-conv_orphan");
  await expect(unfiledRow).toContainText("Scratch notes");
  // Not adopted: the stranded session is not one of the project's own rows.
  await expect(
    page.getByTestId("session-history-item-conv_orphan"),
  ).toHaveCount(0);

  // Reopening shows the stranded words but files nothing: the project on
  // screen stays selected and the session stays project-less.
  await unfiledRow.click();
  await expect(page.getByTestId("session-history-sheet")).toHaveCount(0);
  await expect(
    page.getByTestId("workspace-chat").getByText(ORPHAN_NOTE, { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("open-projects")).toContainText(
    "Aurora Systems",
  );
  await expect
    .poll(async () => (await readOrphanFiling(page))?.orphanProject)
    .toBeNull();

  // Filing is explicit: the row's File action moves the session into the
  // project on screen.
  await page.getByTestId("open-session-history").click();
  await page.getByTestId("file-unfiled-session-conv_orphan").click();
  await expect(page.getByTestId("session-history-sheet")).toHaveCount(0);

  // The scoped device storage carries the filing the way every other edit
  // is carried, so the cross-device merge keeps it.
  await expect.poll(async () => readOrphanFiling(page)).toEqual({
    orphanProject: "proj_alpha",
    orphanUpdatedAtBumped: true,
    orphanMessageCount: 1,
    activeProjectId: "proj_alpha",
    activeConversationId: "conv_orphan",
  });

  // The filed session now belongs to the project's own history: a regular
  // session row, with nothing left under Unfiled.
  await page.getByTestId("open-session-history").click();
  await expect(
    page.getByTestId("session-history-item-conv_orphan"),
  ).toBeVisible();
  await expect(page.getByTestId("session-unfiled-section")).toHaveCount(0);
});
