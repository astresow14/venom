/**
 * Pure, side-effect-free helper that rejects SOP content containing obvious
 * plaintext secrets or regulated data patterns.
 *
 * Rules:
 *  - Private keys (PEM, OpenSSH)
 *  - High-entropy API-key-style tokens (hex ≥40, base64url ≥32)
 *  - Credit/debit card numbers (Luhn-valid 13-19 digit sequences)
 *  - US Social Security Numbers
 *  - Health record indicators (ICD/CPT codes, PHI keywords)
 *
 * The function never receives or logs individual field values; callers pass
 * the joined text blob so no structured content leaks into logs.
 *
 * Returns a rejection reason string if the content is unsafe, or null if OK.
 */

// PEM private key header
const RE_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

// Raw high-entropy tokens (≥40 hex chars)
const RE_HEX_TOKEN = /\b[0-9a-f]{40,}\b/i;
// JWT: header.payload.signature where each segment is base64url
// header is short (typ/alg), payload ≥8 chars, signature ≥20 chars
const RE_BASE64URL_TOKEN = /\bey[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}\b/;
const RE_PREFIXED_SECRET =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/i;
const RE_AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const RE_CREDENTIAL_ASSIGNMENT =
  /\b(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?[_ -]?token|bearer[_ -]?token|client[_ -]?secret|password|passwd|secret[_ -]?key)\b\s*(?:=|:|\bis\b)\s*(?:bearer\s+)?["']?([A-Za-z0-9+/_=-]{8,})/gi;
const RE_BASIC_AUTH_URL =
  /\bhttps?:\/\/[^/\s:@]{1,128}:[^/\s@]{4,128}@/i;
const RE_ENTROPY_TOKEN = /\b[A-Za-z0-9+/_=-]{32,}\b/g;

// US Social Security Number: NNN-NN-NNNN (excluding obviously fake e.g. 000-xx-xxxx)
const RE_SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/;

// Health record keywords
const RE_PHI = /\b(?:patient(?:\s+id)?|mrn|medical\s+record\s+number|icd[-\s]?(?:9|10|11)|cpt\s*code)\b/i;

// Credit card: 13–19 consecutive digits (may be spaced/dashed every 4)
const RE_CARD_RAW = /\b(\d[ -]?){13,19}\d\b/g;

/**
 * Run the Luhn algorithm on a string of digits.
 */
function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Extract digit-only strings from potential card matches and Luhn-validate.
 */
function containsCardNumber(text: string): boolean {
  const matches = text.match(RE_CARD_RAW);
  if (!matches) return false;
  for (const match of matches) {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      return true;
    }
  }
  return false;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function containsLikelyEncodedSecret(text: string): boolean {
  const candidates = text.match(RE_ENTROPY_TOKEN) ?? [];
  return candidates.some((candidate) => {
    const hasMixedAlphanumeric =
      /[a-z]/.test(candidate) &&
      /[A-Z]/.test(candidate) &&
      /\d/.test(candidate);
    return hasMixedAlphanumeric && shannonEntropy(candidate) >= 3.5;
  });
}

export type SafetyCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check a blob of SOP text for obvious sensitive patterns.
 * Callers must NOT log the text argument.
 */
export function checkSopContentSafety(text: string): SafetyCheckResult {
  if (RE_PRIVATE_KEY.test(text)) {
    return { ok: false, reason: "private_key_detected" };
  }
  if (RE_HEX_TOKEN.test(text)) {
    return { ok: false, reason: "high_entropy_token_detected" };
  }
  if (RE_BASE64URL_TOKEN.test(text)) {
    return { ok: false, reason: "jwt_or_token_detected" };
  }
  if (RE_PREFIXED_SECRET.test(text) || RE_AWS_ACCESS_KEY.test(text)) {
    return { ok: false, reason: "credential_pattern_detected" };
  }
  RE_CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  if (RE_CREDENTIAL_ASSIGNMENT.test(text) || RE_BASIC_AUTH_URL.test(text)) {
    return { ok: false, reason: "plaintext_credential_detected" };
  }
  if (containsLikelyEncodedSecret(text)) {
    return { ok: false, reason: "encoded_secret_detected" };
  }
  if (RE_SSN.test(text)) {
    return { ok: false, reason: "ssn_pattern_detected" };
  }
  if (RE_PHI.test(text)) {
    return { ok: false, reason: "phi_indicator_detected" };
  }
  if (containsCardNumber(text)) {
    return { ok: false, reason: "card_number_detected" };
  }
  return { ok: true };
}

/**
 * Flatten a VenomSopContent-shaped object into a single text blob for scanning.
 * No individual field values are passed by callers into logs.
 */
export function flattenSopContent(content: {
  purpose: string;
  prerequisites: string[];
  inputs: string[];
  guidance: string[];
  requiredApprovals: string[];
  acceptanceChecks: string[];
}, title: string, category: string, tags: string[]): string {
  return [
    title,
    category,
    ...tags,
    content.purpose,
    ...content.prerequisites,
    ...content.inputs,
    ...content.guidance,
    ...content.requiredApprovals,
    ...content.acceptanceChecks,
  ].join("\n");
}
