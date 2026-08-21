/**
 * Refuse to mirror credential-shaped files to GitHub.
 *
 * A GitHub App private key was once uploaded straight into `attached_assets/`,
 * a tracked directory the sync pushes verbatim. Ignore rules stop such a file
 * from being staged by accident, but they cannot help once something is already
 * committed, so the sync checks the tree it is about to push and stops instead.
 *
 * Two independent signals mark a file as key material:
 *
 *  - its name (a `.pem`/`.p12`/`.jks` extension, an `id_rsa`-style SSH key, a
 *    real `.env` file), which catches a key that was never opened, and
 *  - its leading bytes (a PEM `PRIVATE KEY` banner, a PuTTY key header), which
 *    catches a key hidden under an innocent name such as `notes.txt`.
 *
 * Nothing here ever reports file contents: a finding names the path and the
 * reason only, so the refusal itself cannot leak the secret it just caught.
 */

import { openSync, readSync, closeSync } from "node:fs";
import { basename, join } from "node:path";

import { git, gitRaw, gitStatus } from "./git";

/** One credential-shaped file, described without quoting anything from it. */
export interface CredentialFinding {
  path: string;
  reason: string;
  /** Where it was found: the working tree, or the commit that still carries it. */
  where: string;
}

/** Extensions that only ever belong to key material or a keystore. */
const CREDENTIAL_EXTENSIONS = new Map<string, string>([
  ["pem", "PEM key material"],
  ["key", "private key file"],
  ["p12", "PKCS#12 keystore"],
  ["pfx", "PKCS#12 keystore"],
  ["p8", "PKCS#8 private key"],
  ["jks", "Java keystore"],
  ["keystore", "keystore"],
  ["ppk", "PuTTY private key"],
]);

/** Bare OpenSSH private keys; the matching `.pub` files are harmless. */
const SSH_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "identity"]);

/**
 * `.env.example` and friends are documentation, not credentials.
 *
 * This list is mirrored by the negated `.env.*` rules in the repository's
 * `.gitignore`; the two have to allow exactly the same names, or a file the
 * guard permits would still be untrackable (or worse, the reverse).
 */
const ENV_TEMPLATE_SUFFIXES = ["example", "sample", "template"];

/** How many leading bytes are enough to recognise a key banner. */
const LEADING_BYTES = 256;

/**
 * Blobs up to this size are read together in one batch; larger ones one by one.
 *
 * This is a memory trade-off, never a skip: every blob is inspected regardless
 * of size, because a key pasted at the top of an otherwise large file is still
 * a key.
 */
const BULK_READ_BYTES = 64 * 1024;

const PRIVATE_KEY_BANNER = /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/;
const PUTTY_KEY_BANNER = /^PuTTY-User-Key-File-\d/;

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return null;
  }
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Why this path looks like key material, or `null` when the name is innocent.
 *
 * The rules are anchored to the extension or the whole basename on purpose: a
 * note called `private-key-rotation.md` documents a key, it does not contain
 * one, and blocking it would teach people to work around the guard.
 */
export function credentialNameReason(path: string): string | null {
  const name = basename(path);
  const lower = name.toLowerCase();

  if (lower.endsWith(".pub")) {
    return null;
  }

  const extension = extensionOf(lower);
  if (extension) {
    const reason = CREDENTIAL_EXTENSIONS.get(extension);
    if (reason) {
      return reason;
    }
  }

  if (SSH_KEY_NAMES.has(lower)) {
    return "OpenSSH private key";
  }

  if (lower === ".env") {
    return "environment file";
  }
  if (lower.startsWith(".env.")) {
    const suffix = lower.slice(".env.".length);
    const isTemplate = ENV_TEMPLATE_SUFFIXES.some(
      (allowed) => suffix === allowed || suffix.endsWith(`.${allowed}`),
    );
    return isTemplate ? null : "environment file";
  }

  return null;
}

/**
 * Why these leading bytes look like key material, or `null` when they do not.
 *
 * The banner has to open the file — it is matched against the first non-blank
 * line, which is how a real key is written. A runbook, a redaction fixture, or
 * a test that quotes a banner further in is discussing key material rather than
 * being it, and blocking those would only teach people to bypass the guard.
 */
export function credentialContentReason(leading: string): string | null {
  const firstLine = leading.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

  if (PRIVATE_KEY_BANNER.test(firstLine)) {
    return "file begins with a private key banner";
  }
  if (PUTTY_KEY_BANNER.test(firstLine)) {
    return "file begins with a PuTTY private key header";
  }
  return null;
}

/** Read the first bytes of a file as text; unreadable or binary files read as "". */
function readLeadingBytes(absolutePath: string): string {
  let handle: number;
  try {
    handle = openSync(absolutePath, "r");
  } catch {
    return "";
  }

  try {
    const buffer = Buffer.alloc(LEADING_BYTES);
    const read = readSync(handle, buffer, 0, LEADING_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(handle);
  }
}

/**
 * Inspect `paths` (repository-relative) and report every credential-shaped one.
 *
 * `readLeading` is injected so the scan can be exercised without a repository;
 * it returns the first bytes of a file, or "" when there is nothing to read.
 */
export function findCredentialFiles(
  paths: string[],
  readLeading: (path: string) => string,
  where = "working tree",
): CredentialFinding[] {
  const findings: CredentialFinding[] = [];

  for (const path of paths) {
    const byName = credentialNameReason(path);
    if (byName) {
      findings.push({ path, reason: byName, where });
      continue;
    }

    const byContent = credentialContentReason(readLeading(path));
    if (byContent) {
      findings.push({ path, reason: byContent, where });
    }
  }

  return findings;
}

/** Scan files inside `repoRoot`, reading each one's leading bytes from disk. */
export function scanForCredentialFiles(
  repoRoot: string,
  paths: string[],
): CredentialFinding[] {
  return findCredentialFiles(paths, (path) => readLeadingBytes(join(repoRoot, path)));
}

/** One blob reachable from the revisions being published. */
interface ReachableBlob {
  sha: string;
  paths: Set<string>;
  size: number;
}

/**
 * Every blob reachable from `revisions`, with the paths it was stored under.
 *
 * `rev-list --objects` walks the commits and their trees, so this covers files
 * that were deleted later: the blob stays reachable through the commit that
 * added it, and a push carries that commit too.
 */
function reachableBlobs(repoRoot: string, revisions: string[]): ReachableBlob[] {
  const listed = gitRaw(["-C", repoRoot, "rev-list", "--objects", ...revisions]).toString("utf8");

  const pathsBySha = new Map<string, Set<string>>();
  for (const line of listed.split("\n")) {
    if (!line) {
      continue;
    }
    const space = line.indexOf(" ");
    if (space === -1) {
      // A commit or a tag: no path, and never key material by itself.
      continue;
    }
    const sha = line.slice(0, space);
    const path = line.slice(space + 1);
    const existing = pathsBySha.get(sha);
    if (existing) {
      existing.add(path);
    } else {
      pathsBySha.set(sha, new Set([path]));
    }
  }

  if (pathsBySha.size === 0) {
    return [];
  }

  // `rev-list --objects` also names trees; ask git which of these are blobs.
  const checked = gitRaw(
    ["-C", repoRoot, "cat-file", "--batch-check"],
    `${[...pathsBySha.keys()].join("\n")}\n`,
  ).toString("utf8");

  const blobs: ReachableBlob[] = [];
  for (const line of checked.split("\n")) {
    const [sha, type, sizeText] = line.split(" ");
    if (type !== "blob") {
      continue;
    }
    const size = Number.parseInt(sizeText ?? "", 10);
    blobs.push({
      sha,
      paths: pathsBySha.get(sha) ?? new Set(),
      size: Number.isNaN(size) ? 0 : size,
    });
  }

  return blobs;
}

/**
 * Read the leading bytes of every blob, whatever its size.
 *
 * Size is never a reason to skip a blob: a key pasted at the top of a large
 * file would sail through, and that is exactly the hole this guard exists to
 * close. Small blobs are read together in one `cat-file --batch` call, and the
 * few large ones individually, so only one big object is ever held at a time.
 */
function leadingBytesOfBlobs(repoRoot: string, blobs: ReachableBlob[]): Map<string, string> {
  const leading = new Map<string, string>();

  const bulk = blobs.filter((blob) => blob.size <= BULK_READ_BYTES).map((blob) => blob.sha);
  for (const blob of blobs) {
    if (blob.size > BULK_READ_BYTES) {
      const contents = gitRaw(["-C", repoRoot, "cat-file", "blob", blob.sha]);
      leading.set(blob.sha, contents.subarray(0, LEADING_BYTES).toString("utf8"));
    }
  }

  if (bulk.length === 0) {
    return leading;
  }

  // Output is `<sha> <type> <size>\n<contents>\n` per request, and contents may
  // be binary, so it is walked as bytes rather than split as text.
  const output = gitRaw(["-C", repoRoot, "cat-file", "--batch"], `${bulk.join("\n")}\n`);

  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) {
      break;
    }

    const [sha, type, sizeText] = output.subarray(offset, newline).toString("utf8").split(" ");
    offset = newline + 1;
    if (type !== "blob") {
      // "<sha> missing": nothing follows the header line.
      continue;
    }

    const size = Number.parseInt(sizeText ?? "", 10);
    if (Number.isNaN(size)) {
      break;
    }
    leading.set(
      sha,
      output.subarray(offset, offset + Math.min(size, LEADING_BYTES)).toString("utf8"),
    );
    offset += size + 1;
  }

  return leading;
}

/** The blob stored at `path` in `commit`, or null when nothing is there. */
function blobAt(repoRoot: string, commit: string, path: string): string | null {
  try {
    return git(["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${commit}:${path}`]) || null;
  } catch {
    return null;
  }
}

/**
 * Name the commit that introduced a blob, so the finding can actually be acted on.
 *
 * `--find-object` lists commits whose diff *touches* the object, which includes
 * the commit that deleted it. Naming that one would be worse than saying
 * nothing: rewriting a deletion commit leaves the key exactly where it was, and
 * the sync would still refuse with no explanation of why the fix did not work.
 * So every candidate is verified by looking the path up in its tree, and the
 * oldest one that really contains the blob — the commit that introduced it — is
 * the one reported.
 */
function commitCarrying(
  repoRoot: string,
  sha: string,
  paths: Iterable<string>,
  revisions: string[],
): string {
  let candidates: string[];
  try {
    candidates = git([
      "-C",
      repoRoot,
      "log",
      "--format=%H",
      "--full-history",
      `--find-object=${sha}`,
      ...revisions,
    ])
      .split("\n")
      .filter(Boolean);
  } catch {
    return "history";
  }

  // `git log` reports newest first; the oldest carrier is the introduction.
  for (const commit of candidates.reverse()) {
    for (const path of paths) {
      if (blobAt(repoRoot, commit, path) === sha) {
        return `commit ${commit.slice(0, 7)}`;
      }
    }
  }

  return "history";
}

/**
 * Scan everything the push would publish, not just the current checkout.
 *
 * A push sends whole commits, so deleting a key in a later commit does not
 * un-publish it: the blob still travels inside the commit that added it, and
 * anyone with the repository can read it. Checking only the final tree would
 * wave that case through, which is precisely how keys leak.
 */
export function scanHistoryForCredentials(
  repoRoot: string,
  revisions: string[] = ["HEAD"],
): CredentialFinding[] {
  if (gitStatus(["-C", repoRoot, "rev-parse", "--verify", "--quiet", revisions[0]]) !== 0) {
    // Nothing committed yet, so nothing to publish.
    return [];
  }

  const blobs = reachableBlobs(repoRoot, revisions);
  const findings: CredentialFinding[] = [];
  const unresolved: ReachableBlob[] = [];

  for (const blob of blobs) {
    const named = [...blob.paths]
      .map((path) => ({ path, reason: credentialNameReason(path) }))
      .filter((candidate): candidate is { path: string; reason: string } => candidate.reason !== null);

    if (named.length > 0) {
      const where = commitCarrying(repoRoot, blob.sha, blob.paths, revisions);
      for (const { path, reason } of named) {
        findings.push({ path, reason, where });
      }
      continue;
    }

    // Every remaining blob is read, whatever its size: a banner at the top of a
    // large file is still key material.
    if (blob.size > 0) {
      unresolved.push(blob);
    }
  }

  const leading = leadingBytesOfBlobs(repoRoot, unresolved);

  for (const blob of unresolved) {
    const reason = credentialContentReason(leading.get(blob.sha) ?? "");
    if (reason) {
      const where = commitCarrying(repoRoot, blob.sha, blob.paths, revisions);
      for (const path of blob.paths) {
        findings.push({ path, reason, where });
      }
    }
  }

  return findings;
}

/** Collapse findings that name the same file in the same place. */
export function dedupeFindings(findings: CredentialFinding[]): CredentialFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.path}\u0000${finding.where}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Explain the refusal: which paths, why, and what to do — never any contents. */
export function credentialRefusalMessage(findings: CredentialFinding[]): string {
  const inHistory = findings.some((finding) => finding.where !== "working tree");

  return [
    "This sync would push credential-shaped files to GitHub, so nothing was pushed:",
    ...findings.map((finding) => `  ${finding.path} — ${finding.reason} (${finding.where})`),
    "",
    "Key material belongs in a Replit Secret, never in a workspace file: the mirror is a",
    "public-facing copy and a pushed key has to be regenerated at the provider.",
    ...(inHistory
      ? [
          "A push sends whole commits, so deleting the file in a later commit does not help:",
          "the commit named above still carries it. Regenerate that credential at the provider,",
          "then rewrite or discard the commit before syncing again.",
        ]
      : [
          "Delete the file (and remove it from the commit that added it), then store the value",
          "as a Replit Secret and read it from the environment.",
        ]),
    "If the file is genuinely harmless, rename it so it no longer looks like key material.",
  ].join("\n");
}
