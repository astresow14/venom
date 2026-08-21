import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSopContentSafety,
  flattenSopContent,
} from "./sop-content-safety.js";

// ---------------------------------------------------------------------------
// Private key detection
// ---------------------------------------------------------------------------
test("rejects PEM private key header", () => {
  const result = checkSopContentSafety(
    "Copy this key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCA...",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "private_key_detected");
});

test("rejects OpenSSH private key header", () => {
  const result = checkSopContentSafety(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC...",
  );
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// High-entropy token detection
// ---------------------------------------------------------------------------
test("rejects long hex token (≥40 chars)", () => {
  const result = checkSopContentSafety(
    "API_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "high_entropy_token_detected");
});

test("rejects JWT-shaped token", () => {
  // header.payload.signature pattern
  const result = checkSopContentSafety(
    "Token: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIiwiZXhwIjoxNjk5OTk5OTk5fQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  );
  assert.equal(result.ok, false);
});

test("rejects common provider credential prefixes", () => {
  // The provider-prefixed fixtures are assembled at runtime so no source blob
  // contains a literal that GitHub push protection would match when this file
  // syncs to the mirror; the strings the detector sees are unchanged.
  const examples = [
    "OPENAI_API_KEY=sk-proj-AbCdEf1234567890_ExampleValue",
    `GitHub token: ${["ghp", "1234567890abcdefghijABCDEFGHIJ"].join("_")}`,
    `Slack token: ${["xoxb", "1234567890", "abcdefghijklmnopqrstuv"].join("-")}`,
    "AWS access key: AKIAIOSFODNN7EXAMPLE",
  ];
  for (const example of examples) {
    assert.equal(checkSopContentSafety(example).ok, false, example);
  }
});

test("rejects plaintext credential assignments and basic-auth URLs", () => {
  assert.equal(
    checkSopContentSafety("password: Sup3rSecretValue").ok,
    false,
  );
  assert.equal(
    checkSopContentSafety("Open https://operator:secretpass@example.com/run").ok,
    false,
  );
});

test("rejects high-entropy base64 and base64url bearer material", () => {
  assert.equal(
    checkSopContentSafety(
      "Bearer material QWxhZGRpbjpvcGVuIHNlc2FtZV9BMTIzNDU2Nzg5",
    ).ok,
    false,
  );
  assert.equal(
    checkSopContentSafety(
      "secret key: vF9_gT2-aBcD3eFgH4iJkL5mNpQrS6tUvWxYz789",
    ).ok,
    false,
  );
});

test("allows secret-manager guidance without a credential value", () => {
  assert.equal(
    checkSopContentSafety(
      "Retrieve the API key from the approved secret manager at runtime. Never paste the key into this SOP.",
    ).ok,
    true,
  );
});

test("allows UUID-backed record identifiers and non-secret slugs", () => {
  assert.equal(
    checkSopContentSafety(
      "Review record sop-body-123e4567-e89b-12d3-a456-426614174000 before approval.",
    ).ok,
    true,
  );
});

// ---------------------------------------------------------------------------
// SSN detection
// ---------------------------------------------------------------------------
test("rejects US SSN pattern", () => {
  const result = checkSopContentSafety(
    "Customer SSN is 123-45-6789, handle carefully.",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "ssn_pattern_detected");
});

test("allows obviously safe SSN-like ranges", () => {
  // 000-xx-xxxx is excluded by pattern
  const result = checkSopContentSafety("See step 000-12-3456 for reference.");
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// PHI / health record detection
// ---------------------------------------------------------------------------
test("rejects patient id keyword", () => {
  const result = checkSopContentSafety(
    "Retrieve the patient id from the EHR system.",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "phi_indicator_detected");
});

test("rejects ICD-10 keyword", () => {
  const result = checkSopContentSafety("Look up the ICD-10 code for the visit.");
  assert.equal(result.ok, false);
});

test("rejects CPT code keyword", () => {
  const result = checkSopContentSafety("Assign CPT code 99213 to the claim.");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Credit / debit card detection
// ---------------------------------------------------------------------------
test("rejects Luhn-valid 16-digit card number", () => {
  // Luhn-valid Visa test number
  const result = checkSopContentSafety(
    "Charge card 4111 1111 1111 1111 for the fee.",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "card_number_detected");
});

test("does not reject 16-digit number that fails Luhn", () => {
  // Clearly invalid number
  const result = checkSopContentSafety(
    "Reference number 1234 5678 9012 3456 is the shipment ID.",
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test("allows clean SOP content", () => {
  const result = checkSopContentSafety(
    [
      "Onboarding procedure for new sales hires",
      "Complete the IT request form",
      "Receive laptop from facilities",
      "Set up two-factor authentication on your Okta account",
      "Complete mandatory compliance training in LMS",
    ].join("\n"),
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// flattenSopContent helper
// ---------------------------------------------------------------------------
test("flattenSopContent produces a scannable string", () => {
  const text = flattenSopContent(
    {
      purpose: "Define intake process",
      prerequisites: ["Access to CRM"],
      inputs: ["Lead form"],
      guidance: ["Step 1: log in", "Step 2: create record"],
      requiredApprovals: ["Manager sign-off"],
      acceptanceChecks: ["Record visible in pipeline"],
    },
    "Sales Intake SOP",
    "operations",
    ["sales", "intake"],
  );
  assert.ok(text.includes("Sales Intake SOP"));
  assert.ok(text.includes("Define intake process"));
  assert.ok(text.includes("intake"));
});
