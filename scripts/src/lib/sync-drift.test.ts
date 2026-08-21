import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyDrift, type DriftFacts, type PullRequestFacts } from "./sync-drift";
import {
  EMPTY_STATE,
  describeAge,
  firstLine,
  nextState,
  readSyncState,
  recordSyncAttempt,
  type SyncAttempt,
  type SyncState,
} from "./sync-state";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function attempt(overrides: Partial<SyncAttempt> = {}): SyncAttempt {
  return {
    at: NOW.toISOString(),
    outcome: "success",
    repo: "astresow14/venom",
    branch: "replit-sync",
    headSha: "a".repeat(40),
    detail: "Pushed snapshot bbbbbbbb of workspace aaaaaaaa to replit-sync (pull request #7).",
    pullRequest: { number: 7, url: "https://github.com/astresow14/venom/pull/7" },
    ...overrides,
  };
}

function pull(overrides: Partial<PullRequestFacts> = {}): PullRequestFacts {
  return {
    number: 7,
    url: "https://github.com/astresow14/venom/pull/7",
    headSha: "b".repeat(40),
    carriesWorkspaceTree: true,
    mergeable: true,
    mergeableState: "blocked",
    ...overrides,
  };
}

/** Defaults describe a mirror that fully matches the workspace tree. */
function facts(overrides: Partial<DriftFacts> = {}): DriftFacts {
  const state: SyncState = { version: 1, lastAttempt: attempt(), lastSuccess: attempt() };
  return {
    baseBranch: "main",
    syncBranch: "replit-sync",
    headSha: "a".repeat(40),
    mirrorMatchesTree: true,
    mirrorMatchesExceptWorkflows: false,
    workflowChangesPending: 0,
    filesDiffering: 0,
    syncBranchExists: true,
    syncBranchCarriesTree: true,
    workingTreeDirty: false,
    pullRequest: null,
    state,
    now: NOW,
    ...overrides,
  };
}

/** Facts for a mirror whose base branch is behind the workspace tree. */
function behind(overrides: Partial<DriftFacts> = {}): DriftFacts {
  return facts({
    mirrorMatchesTree: false,
    filesDiffering: 12,
    ...overrides,
  });
}

test("a mirror that matches the workspace tree is OK with no next step", () => {
  const report = classifyDrift(facts());
  assert.equal(report.level, "ok");
  assert.match(report.headline, /^OK: GitHub `main` matches the workspace tree\./);
  assert.deepEqual(report.findings, []);
  assert.equal(report.nextStep, null);
});

test("an in-flight pull request carrying the tree is OK and waits for checks", () => {
  const report = classifyDrift(behind({ pullRequest: pull() }));
  assert.equal(report.level, "ok");
  assert.match(report.headline, /sync pull request is carrying the workspace tree/);
  assert.ok(report.findings.some((finding) => finding.includes("waiting for the required checks")));
  assert.equal(report.nextStep, null);
});

test("a pull request with green checks reads as ready to merge", () => {
  const report = classifyDrift(behind({ pullRequest: pull({ mergeableState: "clean" }) }));
  assert.equal(report.level, "ok");
  assert.ok(report.findings.some((finding) => finding.includes("ready to merge")));
});

test("a conflicting pull request is drift and points at a fresh sync", () => {
  const report = classifyDrift(
    behind({ pullRequest: pull({ mergeable: false, mergeableState: "dirty" }) }),
  );
  assert.equal(report.level, "drift");
  assert.ok(report.findings.some((finding) => finding.includes("conflicts with `main`")));
  assert.match(report.nextStep ?? "", /pnpm run sync:github/);
});

test("a stale pull request head is drift even when it could merge", () => {
  const report = classifyDrift(
    behind({ pullRequest: pull({ carriesWorkspaceTree: false, mergeableState: "clean" }) }),
  );
  assert.equal(report.level, "drift");
  assert.ok(report.findings.some((finding) => /#7 is stale: its head bbbbbbbb/.test(finding)));
  assert.match(report.nextStep ?? "", /pnpm run sync:github/);
});

test("a pull request head this checkout cannot inspect is a warning", () => {
  const report = classifyDrift(behind({ pullRequest: pull({ carriesWorkspaceTree: null }) }));
  assert.equal(report.level, "warning");
  assert.ok(report.findings.some((finding) => finding.includes("cannot inspect")));
  assert.match(report.nextStep ?? "", /pnpm run sync:github/);
});

test("a behind mirror with no pull request is drift", () => {
  const report = classifyDrift(behind({ syncBranchCarriesTree: true }));
  assert.equal(report.level, "drift");
  assert.ok(
    report.findings.some((finding) => finding.includes("no pull request is open to land it")),
  );
});

test("a behind mirror with neither branch nor pull request counts the differing files", () => {
  const report = classifyDrift(
    behind({ syncBranchExists: false, syncBranchCarriesTree: false, filesDiffering: 1 }),
  );
  assert.equal(report.level, "drift");
  assert.ok(report.findings.some((finding) => finding.includes("1 file behind the workspace tree")));
  assert.ok(report.findings.some((finding) => finding.includes("does not exist on GitHub")));
});

test("held-back workflow files are a warning that asks for a credential", () => {
  const report = classifyDrift(
    facts({
      mirrorMatchesTree: false,
      mirrorMatchesExceptWorkflows: true,
      workflowChangesPending: 3,
      filesDiffering: 3,
    }),
  );
  assert.equal(report.level, "warning");
  assert.ok(report.findings.some((finding) => finding.includes("except 3 workflow files")));
  assert.match(report.nextStep ?? "", /workflow-capable credential/);
});

test("a leftover open pull request is flagged once the mirror matches", () => {
  const report = classifyDrift(facts({ pullRequest: pull() }));
  assert.equal(report.level, "warning");
  assert.ok(report.findings.some((finding) => finding.includes("it can be closed")));
});

test("a recorded failure surfaces even when the mirror matches", () => {
  const failed = attempt({
    outcome: "failed",
    at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
    detail: "GitHub rejected the replit-connector credential (HTTP 401).",
  });
  const report = classifyDrift(
    facts({ state: { version: 1, lastAttempt: failed, lastSuccess: attempt() } }),
  );

  assert.equal(report.level, "drift");
  assert.ok(
    report.findings.some((finding) =>
      finding.includes("last sync attempt failed 2 days ago: GitHub rejected"),
    ),
  );
});

test("a recorded skip is a warning when nothing is missing", () => {
  const skipped = attempt({
    outcome: "skipped",
    detail: "VENOM_SKIP_GITHUB_SYNC=1 was set for this run.",
  });
  const report = classifyDrift(
    facts({ state: { version: 1, lastAttempt: skipped, lastSuccess: attempt() } }),
  );

  assert.equal(report.level, "warning");
  assert.ok(report.findings.some((finding) => finding.includes("last sync was skipped")));
});

test("an old successful sync is worth mentioning", () => {
  const old = attempt({ at: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() });
  const report = classifyDrift(facts({ state: { version: 1, lastAttempt: old, lastSuccess: old } }));

  assert.equal(report.level, "warning");
  assert.ok(report.findings.some((finding) => finding.includes("30 days ago")));
});

test("no recorded history at all is a warning", () => {
  const report = classifyDrift(facts({ state: EMPTY_STATE }));
  assert.equal(report.level, "warning");
  assert.ok(report.findings.some((finding) => finding.includes("No sync attempt has been recorded")));
});

test("a dirty working tree changes the suggested next step", () => {
  const report = classifyDrift(facts({ workingTreeDirty: true }));
  assert.equal(report.level, "warning");
  assert.match(report.nextStep ?? "", /Commit or stash/);
});

test("the marker keeps the last success across a later failure", () => {
  const success = attempt();
  const failure = attempt({ outcome: "failed", detail: "network unreachable" });
  const state = nextState(nextState(EMPTY_STATE, success), failure);

  assert.equal(state.lastAttempt?.outcome, "failed");
  assert.equal(state.lastSuccess?.detail, success.detail);
});

test("the marker round-trips through disk and tolerates a missing file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "venom-sync-state-")), "github-sync.json");
  assert.deepEqual(readSyncState(path), EMPTY_STATE);

  recordSyncAttempt(path, attempt({ outcome: "failed", detail: "boom" }));
  const state = readSyncState(path);

  assert.equal(state.lastAttempt?.outcome, "failed");
  assert.equal(state.lastSuccess, null);
});

test("age and detail formatting stay readable", () => {
  assert.equal(describeAge(new Date(NOW.getTime() - 90_000).toISOString(), NOW), "1 minute ago");
  assert.equal(describeAge(new Date(NOW.getTime() - 3_600_000).toISOString(), NOW), "1 hour ago");
  assert.equal(describeAge("not a date", NOW), "at an unknown time");
  assert.equal(firstLine("\n  first line \nsecond line"), "first line");
  assert.equal(firstLine("x".repeat(300)).length, 200);
});
