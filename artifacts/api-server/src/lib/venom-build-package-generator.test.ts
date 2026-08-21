import assert from "node:assert/strict";
import test from "node:test";
import { CreateVenomBuildRunBody } from "@workspace/api-zod";
import {
  buildPackageChecksum,
  buildPackageMarkdown,
  normalizeBuildPackage,
} from "./venom-build-package-generator";

const source = {
  appId: "11111111-1111-4111-8111-111111111111",
  appName: "Source app",
  sourceVersionId: "22222222-2222-4222-8222-222222222222",
  versionNumber: 4,
  checksumSha256: "a".repeat(64),
};
const sop = {
  sopId: "33333333-3333-4333-8333-333333333333",
  revisionId: "44444444-4444-4444-8444-444444444444",
  revisionNumber: 2,
  title: "Release review",
  checksumSha256: "b".repeat(64),
};
const input = {
  targetType: "website" as const,
  targetName: "Launch site",
  requirements: "Explain the product and collect qualified interest.",
  constraints: "No deployment.",
  brandDirection: "Quiet monochrome.",
  sourceReferences: [source],
  sopReferences: [sop],
};

test("generated build-run validator initializes before parsing requests", () => {
  const result = CreateVenomBuildRunBody.parse({
    targetType: "website",
    targetName: "Launch site",
    requirements: "Explain the product and collect qualified interest.",
    constraints: "No deployment.",
    brandDirection: "Quiet monochrome.",
    appId: null,
    sourceVersionId: null,
    projectId: null,
    sopRevisionIds: [],
    idempotencyKey: "build_run_test_0001",
  });

  assert.equal(result.targetName, "Launch site");
});

test("normalizes omissions and pins authorized references", () => {
  const result = normalizeBuildPackage(
    {
      title: "Launch site",
      productBrief: { summary: "A focused launch site." },
      sourceReferences: [{ appId: "forged" }],
      sopReferences: [{ revisionId: "forged" }],
      acceptanceChecks: ["Visitors understand the offer."],
    },
    input,
  );

  assert.deepEqual(result.sourceReferences, [source]);
  assert.deepEqual(result.sopReferences, [sop]);
  assert.equal(result.productBrief.audience.length, 1);
  assert.ok(
    result.launchConstraints.some((item) =>
      item.includes("Human approval is required"),
    ),
  );
  assert.ok(
    result.launchConstraints.some((item) =>
      item.includes("does not authorize code execution"),
    ),
  );
});

test("bounds malformed model arrays and permission fields", () => {
  const result = normalizeBuildPackage(
    {
      functionalScope: Array.from({ length: 100 }, (_, index) =>
        `Scope ${index}`,
      ),
      permissionRequests: [
        { capability: "Publish", reason: "Needs review", required: true },
        { capability: "", reason: "ignored", required: true },
      ],
      acceptanceChecks: ["Works"],
    },
    input,
  );
  assert.equal(result.functionalScope.length, 40);
  assert.deepEqual(result.permissionRequests, [
    { capability: "Publish", reason: "Needs review", required: true },
  ]);
});

test("portable exports preserve the validated package", () => {
  const result = normalizeBuildPackage(
    { acceptanceChecks: ["Works"] },
    input,
  );
  const checksum = buildPackageChecksum(result);
  const markdown = buildPackageMarkdown(result, 1, checksum);
  assert.match(checksum, /^[a-f0-9]{64}$/);
  assert.match(markdown, /# Launch site/);
  assert.match(markdown, new RegExp(source.sourceVersionId));
  assert.match(markdown, new RegExp(sop.revisionId));
});