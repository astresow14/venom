import { expect, test, type Page } from "@playwright/test";

/**
 * Who Venom says you are, on the phone surface. The server identity record
 * (`GET /api/venom/identity`) is the same one stamped onto captured Brain
 * knowledge, so the Settings account card must render it, and the knowledge
 * map's Evidence rows must resolve each row's captor through the concept
 * detail's `people` array. The desktop shell was verified interactively; the
 * interactive tester cannot reach the Expo origin, so these stubbed specs are
 * the phone app's durable equivalent.
 */

const IDENTITY = {
  userId: "venom-ui-test",
  displayName: "Amara Okafor",
  email: "amara@acme.dev",
  provider: "google",
};

// The cited Brain fixture (`brainFixture=cited`) seeds exactly one cluster,
// id "1", carrying a chat-derived source — the shape whose selection fetches
// the server concept detail below.
const CONCEPT_ID = "1";

const CONCEPT_DETAIL = {
  concept: {
    id: CONCEPT_ID,
    projectId: "proj_default",
    label: "Core Intelligence",
    category: "core",
    strength: 1,
    x: 50,
    y: 50,
    links: [],
    description: "System design and structural patterns for the workspace.",
    summary: "Structure decisions for the mobile release.",
    mentionCount: 2,
    lastUpdatedAt: 1755600000000,
    sources: [
      {
        conversationId: "conv_release_planning",
        projectId: "proj_default",
        conversationTitle: "Release planning",
        messageIds: ["msg_release_planning"],
        excerpt: "The layout is described in the README.",
        updatedAt: 1755600000000,
        capturedByUserId: "user_jonah",
        capturedAt: 1755600000000,
      },
      {
        // Captured by an account the concept detail no longer lists (say, a
        // departed member): the row must fall back to the neutral label
        // instead of misattributing the evidence.
        conversationId: "conv_orphan_capture",
        projectId: "proj_default",
        conversationTitle: "Orphaned capture",
        messageIds: ["msg_orphan_capture"],
        excerpt: "Filed before its captor left the workspace.",
        updatedAt: 1755500000000,
        capturedByUserId: "user_departed",
        capturedAt: 1755500000000,
      },
    ],
  },
  neighbors: [],
  people: [{ userId: "user_jonah", displayName: "Jonah Reyes" }],
};

async function stubIdentity(page: Page) {
  await page.route("**/api/venom/identity", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(IDENTITY),
    }),
  );
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "Identity naming is verified on the phone surface.",
  );
});

test("settings names the recognized account from the server identity", async ({
  page,
}) => {
  await stubIdentity(page);

  await page.goto("/settings?venomUiTest=true");

  // The account card's name line is the server identity's display name, with
  // the account email on the line beneath it.
  const name = page.getByTestId("text-account-name");
  await expect(name).toHaveText(IDENTITY.displayName);
  const email = page.getByTestId("text-account-email");
  await expect(email).toHaveText(IDENTITY.email);

  const nameBox = await name.boundingBox();
  const emailBox = await email.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(emailBox).not.toBeNull();
  expect(emailBox!.y).toBeGreaterThan(nameBox!.y);
});

test("brain evidence names who captured each row from the concept detail", async ({
  page,
}) => {
  await page.route(`**/api/venom/ontology/concepts/${CONCEPT_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CONCEPT_DETAIL),
    }),
  );

  await page.goto("/knowledge?venomUiTest=true&brainFixture=cited");

  // Selecting the chat-derived cluster fetches the concept detail and renders
  // its evidence with attribution.
  const node = page.getByTestId(`knowledge-map-node-${CONCEPT_ID}`);
  await node.scrollIntoViewIfNeeded();
  await node.click();

  const detail = page.getByTestId("knowledge-map-detail");
  await expect(detail).toBeVisible();

  // The captor named by the concept detail's people array.
  const first = detail.getByTestId("knowledge-evidence-0");
  await expect(first).toContainText("Jonah Reyes");
  await expect(first).toContainText("Release planning");

  // A captor id the people array does not know stays a neutral label.
  const second = detail.getByTestId("knowledge-evidence-1");
  await expect(second).toContainText("Workspace member");
  await expect(second).toContainText("Orphaned capture");
  await expect(second).not.toContainText("Jonah Reyes");
});
