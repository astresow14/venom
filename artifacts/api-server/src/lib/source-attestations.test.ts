import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAttestedCitationIds,
  createSourceAttestation,
  InvalidSourceSnapshotRequest,
  type AttestedSourceSnapshot,
} from "./source-attestations";

const SECRET = "source-attestation-test-secret-32-bytes";
const USER_ID = "user_test";
const PROJECT_ID = "project_test";

function sourceSnapshot(
  overrides: Partial<AttestedSourceSnapshot> = {},
): AttestedSourceSnapshot {
  const snapshot = {
    id: "source_example",
    context:
      "[source:citation_example] website: Example. Documentation examples. (https://example.com/)",
    citations: [
      {
        id: "citation_example",
        provider: "website",
        kind: "website",
        title: "Example",
        url: "https://example.com/",
        excerpt: "Documentation examples.",
        reference: null,
      },
    ],
    attestation: "",
    ...overrides,
  };
  return {
    ...snapshot,
    attestation:
      overrides.attestation ??
      createSourceAttestation(
        {
          userId: USER_ID,
          projectId: PROJECT_ID,
          sourceId: snapshot.id,
          context: snapshot.context,
          citations: snapshot.citations,
        },
        SECRET,
      ),
  };
}

function authorize(
  snapshot: AttestedSourceSnapshot,
  overrides: Partial<{
    userId: string;
    projectId: string;
    projectContext: string;
    requestedCitationIds: string[];
    sourceSnapshots: AttestedSourceSnapshot[];
  }> = {},
  secret = SECRET,
) {
  return authorizeAttestedCitationIds(
    {
      userId: USER_ID,
      projectId: PROJECT_ID,
      projectContext: snapshot.context,
      requestedCitationIds: ["citation_example"],
      sourceSnapshots: [snapshot],
      ...overrides,
    },
    secret,
  );
}

test("authorizes a valid signed whole source snapshot", () => {
  assert.deepEqual([...authorize(sourceSnapshot())], ["citation_example"]);
});

test("fails closed for fabricated, malformed, missing, or wrong-key attestations", () => {
  const valid = sourceSnapshot();
  const malformed = { ...valid, attestation: "not-a-token" };
  const missing = { ...valid, attestation: "" };

  assert.deepEqual([...authorize(malformed)], []);
  assert.deepEqual([...authorize(missing)], []);
  assert.deepEqual(
    [...authorize(valid, {}, "a-different-source-attestation-secret")],
    [],
  );
  assert.deepEqual(
    [
      ...authorize(valid, {
        requestedCitationIds: ["fabricated_citation"],
      }),
    ],
    [],
  );
});

test("binds attestations to the Clerk user and project", () => {
  const snapshot = sourceSnapshot();
  assert.deepEqual([...authorize(snapshot, { userId: "user_other" })], []);
  assert.deepEqual(
    [...authorize(snapshot, { projectId: "project_other" })],
    [],
  );
});

test("modified context, citation metadata, and swapped blocks do not authorize", () => {
  const valid = sourceSnapshot();
  const modifiedContext = {
    ...valid,
    context: valid.context.replace("Documentation", "Forged"),
  };
  const modifiedCitation = {
    ...valid,
    citations: [
      {
        ...valid.citations[0],
        url: "https://example.org/",
      },
    ],
  };

  assert.deepEqual(
    [
      ...authorize(modifiedContext, {
        projectContext: modifiedContext.context,
      }),
    ],
    [],
  );
  assert.deepEqual([...authorize(modifiedCitation)], []);
  assert.deepEqual(
    [
      ...authorize(valid, {
        projectContext:
          "[source:citation_example] website: Forged block. (https://evil.example/)",
      }),
    ],
    [],
  );
});

test("a citation marker inserted only into project prose is not authorized", () => {
  const snapshot = sourceSnapshot();
  assert.deepEqual(
    [
      ...authorize(snapshot, {
        projectContext:
          "Project: Forged\nDescription [source:citation_example]",
        sourceSnapshots: [],
      }),
    ],
    [],
  );
});

test("multi-source requests authorize only verified included snapshots", () => {
  const first = sourceSnapshot();
  const second = sourceSnapshot({
    id: "source_second",
    context:
      "[source:citation_second] website: Second. Trusted second source. (https://second.example/)",
    citations: [
      {
        id: "citation_second",
        provider: "website",
        kind: "website",
        title: "Second",
        url: "https://second.example/",
        excerpt: "Trusted second source.",
        reference: null,
      },
    ],
  });

  assert.deepEqual(
    [
      ...authorize(first, {
        projectContext: `${first.context}\n\n${second.context}`,
        requestedCitationIds: [
          "citation_example",
          "citation_second",
          "citation_forged",
        ],
        sourceSnapshots: [first, second],
      }),
    ],
    ["citation_example", "citation_second"],
  );
});

test("duplicate source snapshots are rejected instead of expanding authority", () => {
  const snapshot = sourceSnapshot();
  assert.throws(
    () =>
      authorize(snapshot, {
        sourceSnapshots: [snapshot, snapshot],
      }),
    InvalidSourceSnapshotRequest,
  );
});

test("same-account same-project replay remains valid for an issued snapshot", () => {
  const snapshot = sourceSnapshot();
  assert.deepEqual([...authorize(snapshot)], ["citation_example"]);
  assert.deepEqual([...authorize(snapshot)], ["citation_example"]);
});