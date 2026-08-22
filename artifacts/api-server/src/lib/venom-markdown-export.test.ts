/**
 * Unit tests for the markdown export generators: citation-marker rendering,
 * policy-driven withholding with explicit statements, and the plain
 * "Marked sensitive" labeling when the policy allows sensitive content out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { OntologyConcept } from "./venom-ontology-core";
import {
  exportFileName,
  knowledgeMarkdown,
  renderKnowledgeText,
  sopsMarkdown,
  type ExportableSop,
} from "./venom-markdown-export";

const lookup = {
  liveTitles: new Map([["cit_live", "Payments API docs"]]),
  archivedTitles: new Map([["cit_gone", "Old runbook"]]),
};

test("renderKnowledgeText resolves markers like the clients do", () => {
  assert.equal(
    renderKnowledgeText("See [source:cit_live] for details", lookup),
    "See Payments API docs for details",
  );
  assert.equal(
    renderKnowledgeText("Was in [source:cit_gone]", lookup),
    "Was in Old runbook (archived)",
  );
  assert.equal(
    renderKnowledgeText("Ref [source:cit_unknown] here", lookup),
    "Ref (archived source) here",
  );
  // An unterminated marker (truncated stream) is dropped, never leaked.
  assert.equal(
    renderKnowledgeText("Cut off [source:cit_liv", lookup),
    "Cut off",
  );
});

function conceptFixture(
  overrides: Partial<OntologyConcept> = {},
): OntologyConcept {
  return {
    id: "cluster_1",
    projectId: null,
    label: "Vendor escalation",
    category: "topic",
    strength: 0.8,
    x: 0,
    y: 0,
    links: [],
    summary: "Escalate via [source:cit_live].",
    mentionCount: 3,
    lastUpdatedAt: Date.UTC(2026, 7, 20),
    sources: [
      {
        conversationId: "conv_a",
        projectId: null,
        conversationTitle: "Ops sync",
        messageIds: ["m1"],
        excerpt: "Vendor SLA is 4 hours.",
        updatedAt: Date.UTC(2026, 7, 19),
        capturedByUserId: null,
        capturedAt: null,
      },
      {
        conversationId: "conv_b",
        projectId: null,
        conversationTitle: "Payroll",
        messageIds: ["m2"],
        excerpt: "Account ends in 4242.",
        updatedAt: Date.UTC(2026, 7, 18),
        capturedByUserId: null,
        capturedAt: null,
        sensitive: true,
      },
    ],
    ...overrides,
  };
}

test("knowledgeMarkdown includes and labels sensitive items when allowed", () => {
  const { markdown, withheldCount } = knowledgeMarkdown(
    [conceptFixture({ sensitive: true })],
    {
      scopeTitle: "Workspace \"Ops\"",
      allowSensitive: true,
      includeRestricted: true,
      citationLookup: lookup,
    },
  );
  assert.equal(withheldCount, 0);
  assert.match(markdown, /## Vendor escalation/);
  assert.match(markdown, /Escalate via Payments API docs\./);
  assert.match(markdown, /- Marked sensitive/);
  assert.match(markdown, /_\(marked sensitive\)_/);
  assert.doesNotMatch(markdown, /withheld/);
});

test("knowledgeMarkdown withholds locked items with an explicit statement", () => {
  const { markdown, withheldCount } = knowledgeMarkdown(
    [
      conceptFixture(),
      conceptFixture({ id: "cluster_2", label: "Payroll details", sensitive: true }),
    ],
    {
      scopeTitle: "Workspace \"Ops\"",
      allowSensitive: false,
      includeRestricted: true,
      citationLookup: lookup,
    },
  );
  // One locked cluster plus one locked evidence entry in the kept cluster.
  assert.equal(withheldCount, 2);
  assert.match(
    markdown,
    /\*\*2 sensitive items were withheld by the workspace export policy\.\*\*/,
  );
  assert.doesNotMatch(markdown, /Payroll details/);
  assert.doesNotMatch(markdown, /Account ends in 4242/);
  assert.match(markdown, /Vendor SLA is 4 hours\./);
  assert.match(
    markdown,
    /_1 sensitive evidence entry withheld by the workspace export policy\._/,
  );
});

const sopFixture = (overrides: Partial<ExportableSop> = {}): ExportableSop => ({
  title: "Refund handling",
  lifecycle: "active",
  category: "operations",
  tags: ["refunds"],
  updatedAt: new Date(Date.UTC(2026, 7, 20)),
  content: {
    purpose: "Approve refunds safely",
    prerequisites: ["Order access"],
    inputs: ["Order id"],
    guidance: ["Verify order", "Refund under 100 USD"],
    requiredApprovals: [],
    acceptanceChecks: ["Customer notified"],
  },
  ...overrides,
});

test("sopsMarkdown enforces the same policy contract", () => {
  const allowed = sopsMarkdown(
    [sopFixture(), sopFixture({ title: "Key rotation", sensitive: true })],
    { scopeTitle: "Personal", allowSensitive: true, includeRestricted: true },
  );
  assert.equal(allowed.withheldCount, 0);
  assert.match(allowed.markdown, /## Key rotation/);
  assert.match(allowed.markdown, /- Marked sensitive/);
  assert.match(allowed.markdown, /1\. Verify order/);

  const guarded = sopsMarkdown(
    [sopFixture(), sopFixture({ title: "Key rotation", sensitive: true })],
    {
      scopeTitle: "Workspace \"Ops\"",
      allowSensitive: false,
      includeRestricted: true,
    },
  );
  assert.equal(guarded.withheldCount, 1);
  assert.doesNotMatch(guarded.markdown, /Key rotation/);
  assert.match(
    guarded.markdown,
    /\*\*1 sensitive item was withheld by the workspace export policy\.\*\*/,
  );
});

test("admin-only items are withheld for members and labeled for admins", () => {
  const clusters = [
    conceptFixture(),
    conceptFixture({
      id: "cluster_r",
      label: "Board compensation plan",
      adminOnly: true,
    }),
  ];

  const memberView = knowledgeMarkdown(clusters, {
    scopeTitle: "Workspace \"Ops\"",
    allowSensitive: true,
    includeRestricted: false,
    citationLookup: lookup,
  });
  assert.equal(memberView.restrictedWithheldCount, 1);
  assert.equal(memberView.withheldCount, 0);
  assert.doesNotMatch(memberView.markdown, /Board compensation plan/);
  assert.match(
    memberView.markdown,
    /\*\*1 admin-only item was withheld from this export\.\*\*/,
  );

  const adminView = knowledgeMarkdown(clusters, {
    scopeTitle: "Workspace \"Ops\"",
    allowSensitive: true,
    includeRestricted: true,
    citationLookup: lookup,
  });
  assert.equal(adminView.restrictedWithheldCount, 0);
  assert.match(adminView.markdown, /## Board compensation plan/);
  assert.match(adminView.markdown, /- Admin-only/);
  assert.doesNotMatch(adminView.markdown, /withheld from this export/);

  // Role outranks the sensitivity policy: a restricted cluster stays out of
  // a member's file even when sensitive content is allowed to leave, and
  // both statements can coexist.
  const bothWithheld = knowledgeMarkdown(
    [
      conceptFixture({ id: "cluster_s", label: "Payroll", sensitive: true, sources: [] }),
      conceptFixture({ id: "cluster_r2", label: "Acquisition target", adminOnly: true, sensitive: true, sources: [] }),
    ],
    {
      scopeTitle: "Workspace \"Ops\"",
      allowSensitive: false,
      includeRestricted: false,
      citationLookup: lookup,
    },
  );
  assert.equal(bothWithheld.restrictedWithheldCount, 1);
  assert.equal(bothWithheld.withheldCount, 1);
  assert.match(
    bothWithheld.markdown,
    /\*\*1 sensitive item was withheld by the workspace export policy\.\*\*/,
  );
  assert.match(
    bothWithheld.markdown,
    /\*\*1 admin-only item was withheld from this export\.\*\*/,
  );

  const memberSops = sopsMarkdown(
    [sopFixture(), sopFixture({ title: "Exec offboarding", adminOnly: true })],
    { scopeTitle: "Workspace \"Ops\"", allowSensitive: true, includeRestricted: false },
  );
  assert.equal(memberSops.restrictedWithheldCount, 1);
  assert.doesNotMatch(memberSops.markdown, /Exec offboarding/);
  assert.match(
    memberSops.markdown,
    /\*\*1 admin-only item was withheld from this export\.\*\*/,
  );

  const adminSops = sopsMarkdown(
    [sopFixture(), sopFixture({ title: "Exec offboarding", adminOnly: true })],
    { scopeTitle: "Workspace \"Ops\"", allowSensitive: true, includeRestricted: true },
  );
  assert.equal(adminSops.restrictedWithheldCount, 0);
  assert.match(adminSops.markdown, /## Exec offboarding/);
  assert.match(adminSops.markdown, /- Admin-only/);
});

test("empty exports still say so instead of shipping a blank file", () => {
  const { markdown } = knowledgeMarkdown([], {
    scopeTitle: "Personal",
    allowSensitive: true,
    includeRestricted: true,
  });
  assert.match(markdown, /No knowledge captured yet\./);
});

test("exportFileName stays filesystem-safe", () => {
  assert.match(
    exportFileName("Größe & Ops!", "brain", Date.UTC(2026, 7, 21)),
    /^venom-gr-e-ops-brain-2026-08-21\.md$/,
  );
  assert.equal(
    exportFileName("///", "sops", Date.UTC(2026, 7, 21)),
    "venom-export-sops-2026-08-21.md",
  );
});
