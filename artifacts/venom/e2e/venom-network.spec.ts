import { expect, test, type Page } from "@playwright/test";

/**
 * The Venom network layer on the phone: the anonymous master map is a third
 * Brain layer next to My Brain and any companies, and the personal layer
 * shows dismissible "Related in the Venom network" chips.
 *
 * Everything is stubbed — the master map and suggestion reads and the
 * apply/dismiss writes — so the spec proves the client contract only. The
 * org UI-test flag doubles as the "brain layers live" switch, exactly as the
 * company-layer suite uses it.
 */

const MASTER_BRAIN = {
  concepts: [
    {
      id: "master:kubernetes",
      label: "Kubernetes",
      category: "technology",
      strength: 0.9,
      x: 40,
      y: 20,
    },
    {
      id: "master:observability",
      label: "Observability",
      category: "practice",
      strength: 0.7,
      x: -60,
      y: -40,
    },
  ],
  links: [{ a: "master:kubernetes", b: "master:observability", strength: 0.6 }],
};

const SUGGESTIONS = {
  suggestions: [
    {
      label: "Incident response",
      category: "practice",
      strength: 0.8,
      relatedToLabels: [],
    },
    {
      label: "Postmortems",
      category: "practice",
      strength: 0.5,
      relatedToLabels: [],
    },
  ],
};

const EMPTY_DIRECTORY = { orgs: [], invites: [] };

/** The org machinery opens a membership event stream; keep it quiet. */
async function stubOrgEventsStream(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes("/api/venom/orgs/events")) {
        return originalFetch(input as RequestInfo, init);
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof window.fetch;
  });
}

async function stubJsonGet(page: Page, url: string, body: unknown) {
  await page.route(url, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

function acmeDirectory(role: "admin" | "member") {
  return {
    orgs: [
      {
        id: "org_acme",
        name: "Acme Co",
        role,
        memberCount: 2,
        createdAt: 1700000000000,
      },
    ],
    invites: [],
  };
}

/** The company screen loads members, projects, sources, and consent. */
async function stubAcmeDetail(page: Page, options: { enabled: boolean }) {
  await stubJsonGet(page, "**/api/venom/orgs/org_acme/members", {
    members: [
      {
        userId: "user_admin",
        name: "Admin",
        email: "admin@acme.co",
        role: "admin",
        isSelf: false,
      },
      {
        userId: "user_self",
        name: "Self",
        email: "self@acme.co",
        role: "member",
        isSelf: true,
      },
    ],
    invites: [],
  });
  await stubJsonGet(page, "**/api/venom/orgs/org_acme/projects", {
    projects: [],
  });
  await stubJsonGet(page, "**/api/venom/orgs/org_acme/sources", {
    sources: [],
  });
  await stubJsonGet(page, "**/api/venom/orgs/org_acme/contribution", {
    enabled: options.enabled,
  });
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The network layer is exercised at the mobile viewport.",
  );
});

test("the network layer renders the anonymous map and suggestions apply and dismiss", async ({
  page,
}) => {
  let applied = 0;
  let dismissed = 0;
  await page.route("**/api/venom/orgs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_DIRECTORY),
    });
  });
  await page.route("**/api/venom/master/brain", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MASTER_BRAIN),
    }),
  );
  await page.route("**/api/venom/master/suggestions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SUGGESTIONS),
    }),
  );
  await page.route("**/api/venom/master/suggestions/apply", async (route) => {
    applied += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        filedScope: { ownerType: "user" },
        filed: [
          {
            id: "cl_incident_response",
            projectId: null,
            label: "Incident response",
            category: "practice",
            strength: 0.6,
            x: 10,
            y: -10,
            links: [],
            summary: "Suggested by the Venom network.",
            mentionCount: 1,
            lastUpdatedAt: 1700000000000,
            sources: [],
          },
        ],
      }),
    });
  });
  await page.route(
    "**/api/venom/master/suggestions/dismiss",
    async (route) => {
      dismissed += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    },
  );
  await stubOrgEventsStream(page);

  // slimeTier=off: the anonymous network map never touches the goo layer.
  await page.goto("/?venomUiTest=true&venomUiTestOrgs=1&slimeTier=off");

  const brainTab = page.getByRole("tab", { name: "Open Brain workspace" });
  await brainTab.click();
  await expect(brainTab).toHaveAttribute("aria-selected", "true");

  // Even without any company membership the switcher renders now: the
  // network layer belongs to every account.
  await expect(page.getByTestId("brain-layer-switcher")).toBeVisible();

  // Suggestion chips ride the personal layer, marked as network-sourced.
  const strip = page.getByTestId("network-suggestions");
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("Related in the Venom network");

  // Apply files it server-side and the chip leaves the strip.
  await page.getByTestId("suggestion-apply-Incident response").click();
  await expect(
    page.getByTestId("suggestion-apply-Incident response"),
  ).toHaveCount(0);
  await expect.poll(() => applied).toBe(1);

  // Dismiss is remembered server-side; the chip goes immediately.
  await page.getByTestId("suggestion-dismiss-Postmortems").click();
  await expect(
    page.getByTestId("suggestion-dismiss-Postmortems"),
  ).toHaveCount(0);
  await expect.poll(() => dismissed).toBe(1);

  // The third layer: anonymous aggregate concepts on the same living map.
  await page.getByTestId("brain-layer-network").click();
  const masterCluster = page.getByTestId(
    "knowledge-cluster-master:kubernetes",
  );
  await expect(masterCluster).toBeVisible();

  // Details are read-only reference: provenance instead of evidence, no
  // rename/merge/delete affordances.
  await masterCluster.click();
  const details = page.getByTestId("knowledge-cluster-details");
  await expect(details).toBeVisible();
  await expect(
    page.getByTestId("knowledge-network-provenance"),
  ).toContainText("anonymous");
  await expect(details).toContainText("Sources · none by design");
  await expect(
    page.getByTestId("knowledge-rename-cluster-button"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("knowledge-delete-cluster-button"),
  ).toHaveCount(0);
});

test("the settings consent toggle turns contribution on", async ({ page }) => {
  let putBody: unknown = null;
  await page.route("**/api/venom/master/contribution", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fallback();
      return;
    }
    putBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: true }),
    });
  });

  await page.goto("/?venomUiTest=true");
  await page.getByTestId("open-settings").click();

  const section = page.getByTestId("settings-network-section");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("Venom network");

  // Off until the account opts in — the copy states the boundary plainly.
  const state = page.getByTestId("network-contribution-state");
  await expect(state).toHaveText("Off");
  await expect(section).toContainText("never leave your account");

  await page.getByTestId("network-contribution-toggle").click();
  await expect(state).toHaveText("Contributing");
  expect(putBody).toEqual({ enabled: true });
});

test("a company admin flips the company contribution toggle on the phone", async ({
  page,
}) => {
  let putBody: unknown = null;
  await stubJsonGet(page, "**/api/venom/orgs", acmeDirectory("admin"));
  await stubAcmeDetail(page, { enabled: false });
  await page.route(
    "**/api/venom/orgs/org_acme/contribution",
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      putBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true }),
      });
    },
  );
  await stubOrgEventsStream(page);

  await page.goto("/company?venomUiTest=true&venomUiTestOrgs=1");

  const section = page.getByTestId("company-network-contribution");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("Never shared");

  const toggle = page.getByTestId("company-network-toggle");
  await expect(toggle).toContainText("Off");
  await toggle.click();
  await expect(toggle).toContainText("Contributing");
  expect(putBody).toEqual({ enabled: true });
});

test("a company member sees the contribution state read-only on the phone", async ({
  page,
}) => {
  let putCalls = 0;
  await stubJsonGet(page, "**/api/venom/orgs", acmeDirectory("member"));
  await stubAcmeDetail(page, { enabled: true });
  await page.route(
    "**/api/venom/orgs/org_acme/contribution",
    async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fallback();
        return;
      }
      putCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: false }),
      });
    },
  );
  await stubOrgEventsStream(page);

  await page.goto("/company?venomUiTest=true&venomUiTestOrgs=1");

  const section = page.getByTestId("company-network-contribution");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toContainText("Only admins can change this.");
  await expect(page.getByTestId("company-network-state")).toContainText(
    "Contributing",
  );
  await expect(page.getByTestId("company-network-toggle")).toHaveCount(0);
  expect(putCalls).toBe(0);
});
