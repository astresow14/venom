import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHIVED_CITATION_LABEL,
  messageCitationSegments,
  remapConversationCitations,
  remapMessageCitations,
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

test("keeps answers without citations as a single text segment", () => {
  assert.deepEqual(messageCitationSegments("Plain answer.", new Map()), [
    { kind: "text", text: "Plain answer." },
  ]);
});
