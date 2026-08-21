import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExtractedClusters,
  stripCitationMarkers,
} from "./venom-knowledge.ts";

const messages = new Map([
  ["m1", "The release is blocked by [source:cite_live] until Friday."],
  ["m2", "Nothing cited here."],
]);

test("cluster labels never keep an inline source marker", () => {
  const clusters = normalizeExtractedClusters(
    {
      clusters: [
        {
          label: "Release Blocker [source:cite_live]",
          category: "risk",
          confidence: 0.8,
          summary: "The mobile release is blocked.",
          sourceMessageIds: ["m1"],
          relatedLabels: ["Drawer Fix [source:cite_live]", "[source:cite_live]"],
        },
      ],
    },
    messages,
  );

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].label, "Release Blocker");
  assert.deepEqual(clusters[0].relatedLabels, ["Drawer Fix"]);
});

test("summaries keep markers so the client can name the source", () => {
  const [modelSummary, fallbackSummary] = normalizeExtractedClusters(
    {
      clusters: [
        {
          label: "Release Blocker",
          summary: "  Blocked by [source:cite_live].  ",
          sourceMessageIds: ["m1"],
        },
        {
          label: "Fallback",
          sourceMessageIds: ["m1"],
        },
      ],
    },
    messages,
  );

  assert.equal(modelSummary.summary, "Blocked by [source:cite_live].");
  assert.equal(
    fallbackSummary.summary,
    "The release is blocked by [source:cite_live] until Friday.",
  );
});

test("marker stripping drops unterminated markers and tidies spacing", () => {
  assert.equal(
    stripCitationMarkers("Blocked by [source:cite_live] until [source:cite"),
    "Blocked by until",
  );
  assert.equal(stripCitationMarkers("[source:cite_live]"), "");
});

test("clusters without a supplied source message id are dropped", () => {
  const clusters = normalizeExtractedClusters(
    {
      clusters: [
        { label: "Ghost", sourceMessageIds: ["unknown"] },
        { label: "[source:cite_live]", sourceMessageIds: ["m1"] },
        { label: "Kept", sourceMessageIds: ["m2", "unknown"] },
      ],
    },
    messages,
  );

  assert.deepEqual(
    clusters.map((cluster) => cluster.label),
    ["Kept"],
  );
  assert.deepEqual(clusters[0].sourceMessageIds, ["m2"]);
  assert.equal(clusters[0].category, "topic");
  assert.equal(clusters[0].confidence, 0.68);
});

test("malformed extraction payloads normalize to no clusters", () => {
  assert.deepEqual(normalizeExtractedClusters(null, messages), []);
  assert.deepEqual(normalizeExtractedClusters({ clusters: "nope" }, messages), []);
  assert.deepEqual(normalizeExtractedClusters({ clusters: [42] }, messages), []);
});
