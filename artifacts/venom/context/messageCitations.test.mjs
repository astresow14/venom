import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVED_CITATION_LABEL,
  archivedCitationsFromRemovedSource,
  archivedCitationsFromRetired,
  citedCitationIds,
  messageCitationPlainText,
  messageCitationSegments,
  remapConversationCitations,
  remapMessageCitations,
  restoredCitationRemap,
  retiredCitationRemap,
} from "./messageCitations.ts";

function citation(overrides) {
  return {
    id: "cite_old",
    provider: "github",
    kind: "issue",
    title: "Fix the drawer",
    url: "https://github.com/acme/venom/issues/12",
    excerpt: "Drawer stays open on mobile.",
    reference: "acme/venom#12",
    ...overrides,
  };
}

test("maps retired citation ids onto the refreshed citation for the same item", () => {
  const remap = retiredCitationRemap(
    [
      citation(),
      citation({
        id: "cite_gone",
        kind: "pull_request",
        title: "Closed pull request",
        url: "https://github.com/acme/venom/pull/4",
        reference: "acme/venom#4",
      }),
    ],
    [
      citation({ id: "cite_new", excerpt: "Drawer stays open on mobile (v2)." }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_new"]]);
});

test("remaps by url when the refresh renamed the cited item's reference", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_renumbered",
        reference: "acme/venom#4012",
        title: "Fix the drawer (moved)",
      }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_renumbered"]]);
});

test("remaps by url when the refresh dropped the reference entirely", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [citation({ id: "cite_unreferenced", reference: null })],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_unreferenced"]]);
});

test("prefers the reference match over another citation on the same url", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({ id: "cite_same_page", reference: "acme/venom#99" }),
      citation({ id: "cite_by_reference", title: "Fix the drawer (v2)" }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_by_reference"]]);
});

test("does not fall back to a url several refreshed citations share", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({ id: "cite_first_item", reference: "acme/venom#40" }),
      citation({ id: "cite_second_item", reference: "acme/venom#41" }),
    ],
  );

  assert.equal(remap.size, 0);
});

test("does not fall back onto a citation another item already matches", () => {
  // The refresh kept issue #13 (same page) and dropped #12; the retired #12
  // must not be pointed at #13 just because they share a URL.
  const remap = retiredCitationRemap(
    [citation(), citation({ id: "cite_neighbor", reference: "acme/venom#13" })],
    [citation({ id: "cite_neighbor_new", reference: "acme/venom#13" })],
  );

  assert.deepEqual([...remap], [["cite_neighbor", "cite_neighbor_new"]]);
});

test("does not collapse two renamed items that share one refreshed url", () => {
  // Both cited items lost their reference, and only one refreshed citation
  // covers the page: there is no way to tell which one it is, so neither may
  // claim it.
  const remap = retiredCitationRemap(
    [citation(), citation({ id: "cite_neighbor", reference: "acme/venom#13" })],
    [citation({ id: "cite_renumbered", reference: "acme/venom#4012" })],
  );

  assert.equal(remap.size, 0);
});

test("remaps duplicate ids for one unreferenced item onto the refreshed page", () => {
  const remap = retiredCitationRemap(
    [
      citation({ id: "cite_dup_a", reference: null }),
      citation({ id: "cite_dup_b", reference: null }),
    ],
    [citation({ id: "cite_page_new", reference: null })],
  );

  assert.deepEqual(
    [...remap],
    [
      ["cite_dup_a", "cite_page_new"],
      ["cite_dup_b", "cite_page_new"],
    ],
  );
});

test("does not remap across citation kinds that share a url", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_other_kind",
        kind: "pull_request",
        reference: "acme/venom#77",
      }),
    ],
  );

  assert.equal(remap.size, 0);
});

test("remaps by title when the refresh moved the cited item to a new address", () => {
  // The site restructured: new URL, renamed reference. Only the title (modulo
  // case and whitespace) still names the item, and it is unique.
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_moved",
        title: "  Fix   the DRAWER ",
        url: "https://github.com/acme/venom-archive/issues/12",
        reference: "acme/venom-archive#12",
      }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_moved"]]);
});

test("remaps by title when the moved item's reference was never set", () => {
  const remap = retiredCitationRemap(
    [citation({ reference: null })],
    [
      citation({
        id: "cite_moved",
        url: "https://github.com/acme/venom-archive/issues/12",
        reference: null,
      }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_moved"]]);
});

test("does not remap by title when several refreshed citations share it", () => {
  // Two refreshed items of the same kind carry the cited title: there is no
  // way to tell which one the older answer meant, so neither may claim it.
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_moved_a",
        url: "https://github.com/acme/venom-archive/issues/12",
        reference: null,
      }),
      citation({
        id: "cite_moved_b",
        url: "https://github.com/acme/venom-mirror/issues/12",
        reference: null,
      }),
    ],
  );

  assert.equal(remap.size, 0);
});

test("does not remap by title onto a citation another item already matches", () => {
  // The refresh kept issue #13, which happens to share the retired #12's
  // title; #12 must not be pointed at #13's refreshed citation just because
  // nothing else carries the name.
  const remap = retiredCitationRemap(
    [
      citation(),
      citation({
        id: "cite_neighbor",
        reference: "acme/venom#13",
        url: "https://github.com/acme/venom/issues/13",
      }),
    ],
    [
      citation({
        id: "cite_neighbor_new",
        reference: "acme/venom#13",
        url: "https://github.com/acme/venom/issues/13-moved",
      }),
    ],
  );

  assert.deepEqual([...remap], [["cite_neighbor", "cite_neighbor_new"]]);
});

test("does not collapse two retired items that share a title", () => {
  // Both cited items lost their reference and URL, and only one refreshed
  // citation carries the shared name: neither may claim it.
  const remap = retiredCitationRemap(
    [
      citation(),
      citation({
        id: "cite_twin",
        reference: "acme/venom#14",
        url: "https://github.com/acme/venom/issues/14",
      }),
    ],
    [
      citation({
        id: "cite_moved",
        url: "https://github.com/acme/venom-archive/issues/12",
        reference: null,
      }),
    ],
  );

  assert.equal(remap.size, 0);
});

test("does not remap by title across citation kinds", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_other_kind_moved",
        kind: "pull_request",
        url: "https://github.com/acme/venom/pull/12",
        reference: null,
      }),
    ],
  );

  assert.equal(remap.size, 0);
});

test("prefers the url match over a title match elsewhere", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_same_page",
        title: "Fix the drawer (rewritten)",
        reference: "acme/venom#99",
      }),
      citation({
        id: "cite_same_title",
        url: "https://github.com/acme/venom/discussions/12",
        reference: null,
      }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_same_page"]]);
});

test("prefers the reference match over a title match elsewhere", () => {
  const remap = retiredCitationRemap(
    [citation()],
    [
      citation({
        id: "cite_renamed",
        title: "Fix the drawer, renamed",
        url: "https://github.com/acme/venom-archive/issues/12",
      }),
      citation({
        id: "cite_same_title",
        url: "https://github.com/acme/venom/discussions/12",
        reference: null,
      }),
    ],
  );

  assert.deepEqual([...remap], [["cite_old", "cite_renamed"]]);
});

test("remaps duplicate ids for one moved unreferenced item onto its new address", () => {
  const remap = retiredCitationRemap(
    [
      citation({ id: "cite_dup_a", reference: null }),
      citation({ id: "cite_dup_b", reference: null }),
    ],
    [
      citation({
        id: "cite_moved",
        url: "https://github.com/acme/venom-archive/issues/12",
        reference: null,
      }),
    ],
  );

  assert.deepEqual(
    [...remap],
    [
      ["cite_dup_a", "cite_moved"],
      ["cite_dup_b", "cite_moved"],
    ],
  );
});

test("leaves citation ids that survived the refresh untouched", () => {
  const unchanged = citation({ id: "cite_stable" });
  const remap = retiredCitationRemap(
    [unchanged],
    [{ ...unchanged, excerpt: "Refreshed excerpt." }],
  );

  assert.equal(remap.size, 0);
});

test("rewrites only the inline markers of an already-saved answer", () => {
  const content =
    "The drawer bug [source:cite_old] is open, unlike [source:cite_gone].";

  assert.equal(
    remapMessageCitations(content, new Map([["cite_old", "cite_new"]])),
    "The drawer bug [source:cite_new] is open, unlike [source:cite_gone].",
  );
});

test("remaps saved answers for the refreshed project only, keeping timestamps", () => {
  const conversations = [
    {
      id: "conv_1",
      title: "Mobile",
      projectId: "proj_1",
      updatedAt: 100,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "What is open? [source:cite_old]",
          createdAt: 1,
          status: "sent",
        },
        {
          id: "m2",
          role: "assistant",
          content: "One issue [source:cite_old].",
          createdAt: 2,
          status: "sent",
        },
      ],
    },
    {
      id: "conv_2",
      title: "Other project",
      projectId: "proj_2",
      updatedAt: 50,
      messages: [
        {
          id: "m3",
          role: "assistant",
          content: "Elsewhere [source:cite_old].",
          createdAt: 3,
          status: "sent",
        },
      ],
    },
  ];

  const next = remapConversationCitations(
    conversations,
    "proj_1",
    new Map([["cite_old", "cite_new"]]),
  );

  assert.equal(next[0].updatedAt, 100);
  assert.equal(next[0].messages[0].content, "What is open? [source:cite_old]");
  assert.equal(next[0].messages[1].content, "One issue [source:cite_new].");
  assert.equal(next[1], conversations[1]);
});

test("archives retired citations that the refresh could not remap", () => {
  const previous = [
    citation(),
    citation({
      id: "cite_gone",
      kind: "pull_request",
      title: "Closed pull request",
      url: "https://github.com/acme/venom/pull/4",
      reference: "acme/venom#4",
    }),
  ];
  const refreshed = [citation({ id: "cite_new" })];
  const remap = retiredCitationRemap(previous, refreshed);

  assert.deepEqual(
    archivedCitationsFromRetired(previous, refreshed, remap, 1_700),
    [
      {
        id: "cite_gone",
        title: "Closed pull request",
        url: "https://github.com/acme/venom/pull/4",
        retiredAt: 1_700,
      },
    ],
  );
});

test("does not archive citations that survived or were remapped by the refresh", () => {
  const stable = citation({ id: "cite_stable" });
  const previous = [stable, citation({ id: "cite_old" })];
  const refreshed = [stable, citation({ id: "cite_new" })];
  const remap = retiredCitationRemap(previous, refreshed);

  assert.deepEqual(
    archivedCitationsFromRetired(previous, refreshed, remap, 1_700),
    [],
  );
});

test("keeps archived citation fields inside the schema limits", () => {
  const [archived] = archivedCitationsFromRetired(
    [
      citation({
        id: "cite_long",
        title: "T".repeat(500),
        url: `https://example.com/${"u".repeat(4000)}`,
      }),
    ],
    [],
    new Map(),
    5,
  );

  assert.equal(archived.title.length, 300);
  assert.equal(archived.url.length, 2048);
});

test("archives every citation of a disconnected source", () => {
  assert.deepEqual(
    archivedCitationsFromRemovedSource(
      [
        citation(),
        citation({
          id: "cite_pr",
          kind: "pull_request",
          title: "Closed pull request",
          url: "https://github.com/acme/venom/pull/4",
          reference: "acme/venom#4",
        }),
        // A duplicate id must not produce a duplicate archive entry.
        citation(),
      ],
      2_400,
    ),
    [
      {
        id: "cite_old",
        title: "Fix the drawer",
        url: "https://github.com/acme/venom/issues/12",
        retiredAt: 2_400,
      },
      {
        id: "cite_pr",
        title: "Closed pull request",
        url: "https://github.com/acme/venom/pull/4",
        retiredAt: 2_400,
      },
    ],
  );
});

test("keeps a removed source's archived fields inside the schema limits", () => {
  const [archived] = archivedCitationsFromRemovedSource(
    [
      citation({
        id: "cite_long",
        title: "T".repeat(500),
        url: `https://example.com/${"u".repeat(4000)}`,
      }),
    ],
    5,
  );

  assert.equal(archived.title.length, 300);
  assert.equal(archived.url.length, 2048);
});

test("maps archived citations onto the refreshed citation that restored them", () => {
  const archived = [
    {
      id: "cite_gone",
      title: "Closed pull request",
      url: "https://github.com/acme/venom/pull/4",
      retiredAt: 1_700,
    },
    {
      id: "cite_still_gone",
      title: "Deleted page",
      url: "https://example.com/removed",
      retiredAt: 1_800,
    },
  ];
  const refreshed = [
    citation({
      id: "cite_back",
      kind: "pull_request",
      title: "Reopened pull request",
      url: "https://GitHub.com/acme/venom/pull/4 ",
      reference: "acme/venom#4",
    }),
  ];

  assert.deepEqual(
    [...restoredCitationRemap(archived, refreshed)],
    [["cite_gone", "cite_back"]],
  );
});

test("leaves archived citations alone when the refresh reuses their id", () => {
  const archived = [
    {
      id: "cite_back",
      title: "Reopened issue",
      url: "https://github.com/acme/venom/issues/12",
      retiredAt: 1_700,
    },
  ];

  // Citation ids are deterministic, so a restored item usually comes back under
  // its original id: the renderer prefers the live citation, no remap needed.
  const remap = restoredCitationRemap(archived, [citation({ id: "cite_back" })]);

  assert.equal(remap.size, 0);
});

test("collects the citation ids saved answers still point at", () => {
  const conversations = [
    {
      id: "conv_1",
      title: "Mobile",
      projectId: "proj_1",
      updatedAt: 100,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "What is open?",
          createdAt: 1,
          status: "sent",
        },
        {
          id: "m2",
          role: "assistant",
          content: "One issue [source:cite_live], one gone [source:cite_gone].",
          createdAt: 2,
          status: "sent",
        },
      ],
    },
    {
      id: "conv_2",
      title: "Other",
      projectId: "proj_2",
      updatedAt: 50,
      messages: [
        {
          id: "m3",
          role: "assistant",
          content: "Elsewhere [source:cite_live].",
          createdAt: 3,
          status: "sent",
        },
      ],
    },
  ];

  assert.deepEqual(
    [...citedCitationIds(conversations)].sort(),
    ["cite_gone", "cite_live"],
  );
  assert.deepEqual([...citedCitationIds([])], []);
});

test("renders live citations as links and retired ones as archived references", () => {
  const live = citation({ id: "cite_new" });
  const segments = messageCitationSegments(
    "Live [source:cite_new] and retired [source:cite_gone] evidence.",
    new Map([[live.id, live]]),
  );

  assert.deepEqual(segments, [
    { kind: "text", text: "Live " },
    { kind: "citation", citation: live },
    { kind: "text", text: " and retired " },
    {
      kind: "archived",
      citationId: "cite_gone",
      label: ARCHIVED_CITATION_LABEL,
      archived: null,
    },
    { kind: "text", text: " evidence." },
  ]);
  assert.equal(
    segments.some(
      (segment) => segment.kind === "text" && segment.text.includes("[source:"),
    ),
    false,
  );
});

test("renders an archived citation with its original title and target", () => {
  const archived = {
    id: "cite_gone",
    title: "Closed pull request",
    url: "https://github.com/acme/venom/pull/4",
    retiredAt: 1_700,
  };
  const segments = messageCitationSegments(
    "Based on [source:cite_gone].",
    new Map(),
    new Map([[archived.id, archived]]),
  );

  assert.deepEqual(segments, [
    { kind: "text", text: "Based on " },
    {
      kind: "archived",
      citationId: "cite_gone",
      label: "Closed pull request (archived)",
      archived,
    },
    { kind: "text", text: "." },
  ]);
});

test("keeps answers without citations as a single text segment", () => {
  assert.deepEqual(messageCitationSegments("Plain answer.", new Map()), [
    { kind: "text", text: "Plain answer." },
  ]);
});

test("previews an answer with live citations as readable text", () => {
  const live = citation({ id: "cite_repository_overview" });
  const preview = messageCitationPlainText(
    "Sync runs hourly. [source:cite_repository_overview]",
    new Map([[live.id, live]]),
  );

  assert.equal(preview, "Sync runs hourly. Fix the drawer");
  assert.equal(preview.includes("[source:"), false);
});

test("previews an answer whose source was disconnected", () => {
  const archived = {
    id: "cite_gone",
    title: "Closed pull request",
    url: "https://github.com/acme/venom/pull/4",
    retiredAt: 1_700,
  };

  assert.equal(
    messageCitationPlainText(
      "Based on [source:cite_gone] the drawer is fixed.",
      new Map(),
      new Map([[archived.id, archived]]),
    ),
    "Based on Closed pull request (archived) the drawer is fixed.",
  );
  assert.equal(
    messageCitationPlainText(
      "Based on [source:cite_unknown] the drawer is fixed.",
      new Map(),
    ),
    `Based on ${ARCHIVED_CITATION_LABEL} the drawer is fixed.`,
  );
});

test("never leaks a raw source marker into a preview", () => {
  const overlong = `Answer [source:${"x".repeat(200)}] with a long id.`;
  const overlongPreview = messageCitationPlainText(overlong, new Map());
  assert.equal(overlongPreview.includes("[source:"), false);
  assert.equal(overlongPreview, "Answer with a long id.");

  // A truncated stream flushes an unfinished marker into the saved answer.
  const unfinished = messageCitationPlainText(
    "Active work lives in the drawer fix [source:cite_unfin",
    new Map(),
  );
  assert.equal(unfinished.includes("[source:"), false);
  assert.equal(unfinished, "Active work lives in the drawer fix");

  // An unfinished marker followed by a later closing bracket must not eat the
  // whole answer, and must still not show the marker.
  const partial = messageCitationPlainText(
    "Answer [source:cite_unfin and [more] context.",
    new Map(),
  );
  assert.equal(partial.includes("[source:"), false);
  assert.equal(partial, "Answer context.");
});
