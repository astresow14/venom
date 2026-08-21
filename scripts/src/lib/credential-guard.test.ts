import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  credentialContentReason,
  credentialNameReason,
  credentialRefusalMessage,
  dedupeFindings,
  findCredentialFiles,
  scanForCredentialFiles,
  scanHistoryForCredentials,
  type CredentialFinding,
} from "./credential-guard";

/** A PEM banner assembled at runtime, so this test file never reads as key material itself. */
const PRIVATE_KEY_BANNER = `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`;
const FAKE_KEY = `${PRIVATE_KEY_BANNER}\nbm90LWEtcmVhbC1rZXk=\n`;

/** The repository root, three levels up from scripts/src/lib. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** Build a throwaway tree from a path -> contents map and return its root. */
function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "credential-guard-"));
  writeInto(root, files);
  return root;
}

function writeInto(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

/** A throwaway repository, isolated from the developer's own git config. */
function repoWith(files: Record<string, string>): string {
  const root = treeWith(files);
  const run = (...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], {
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  };

  run("init", "--quiet", "--initial-branch=main");
  run("config", "user.email", "guard@example.test");
  run("config", "user.name", "Guard Test");
  run("config", "commit.gpgsign", "false");
  commit(root, "initial");
  return root;
}

/** Run a read-only git command in a throwaway repository and return its output. */
function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

function commit(root: string, message: string): void {
  const run = (...args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], {
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  };
  run("add", "--all", "--force");
  run("commit", "--quiet", "--no-verify", "--allow-empty", "-m", message);
}

test("a private key is caught by its extension wherever it sits", () => {
  for (const path of [
    "attached_assets/venomplatform.2026-08-20.private-key_1787263604745.pem",
    "config/server.key",
    "android/release.keystore",
    "ios/AuthKey_ABC123.p8",
    "certs/bundle.p12",
  ]) {
    assert.notEqual(credentialNameReason(path), null, `expected ${path} to be refused`);
  }
});

test("bare SSH private keys are caught but their public halves are not", () => {
  assert.notEqual(credentialNameReason("deploy/id_ed25519"), null);
  assert.equal(credentialNameReason("deploy/id_ed25519.pub"), null);
});

test("real environment files are caught and templates are left alone", () => {
  assert.notEqual(credentialNameReason(".env"), null);
  assert.notEqual(credentialNameReason("artifacts/api-server/.env.production"), null);
  assert.equal(credentialNameReason(".env.example"), null);
  assert.equal(credentialNameReason(".env.local.example"), null);
});

test("files that merely talk about keys are not blocked", () => {
  for (const path of [
    "docs/private-key-rotation.md",
    "attached_assets/Screenshot_2026-08-20_at_3.16.00_AM.png",
    "scripts/src/lib/credential-guard.ts",
    "artifacts/venom/src/keystore-notes.txt",
    "src/hooks/useApiKeyForm.tsx",
  ]) {
    assert.equal(credentialNameReason(path), null, `expected ${path} to pass`);
  }
});

test("a key banner counts only when the file starts with it", () => {
  assert.notEqual(credentialContentReason(FAKE_KEY), null);
  assert.notEqual(credentialContentReason("PuTTY-User-Key-File-3: ssh-rsa"), null);
  assert.equal(
    credentialContentReason(`// redaction fixture\nconst sample = "${PRIVATE_KEY_BANNER}";`),
    null,
  );
  assert.equal(credentialContentReason("# Venom\n\nAn AI workspace.\n"), null);
});

test("a clean tree passes the scan", () => {
  const root = treeWith({
    "README.md": "# Venom\n",
    "attached_assets/notes.md": `How to rotate a key: look for the ${PRIVATE_KEY_BANNER} block.\n`,
    ".env.example": "DATABASE_URL=\n",
    "deploy/id_ed25519.pub": "ssh-ed25519 AAAA...\n",
  });

  assert.deepEqual(
    scanForCredentialFiles(root, [
      "README.md",
      "attached_assets/notes.md",
      ".env.example",
      "deploy/id_ed25519.pub",
    ]),
    [],
  );
});

test("a private key in the tree is refused, by name and by content", () => {
  const root = treeWith({
    "README.md": "# Venom\n",
    "attached_assets/app.private-key.pem": FAKE_KEY,
    "attached_assets/harmless-looking.txt": FAKE_KEY,
  });

  const findings = scanForCredentialFiles(root, [
    "README.md",
    "attached_assets/app.private-key.pem",
    "attached_assets/harmless-looking.txt",
  ]);

  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["attached_assets/app.private-key.pem", "attached_assets/harmless-looking.txt"],
  );
  assert.deepEqual([...new Set(findings.map((finding) => finding.where))], ["working tree"]);
});

test("an unreadable path is not mistaken for key material", () => {
  const root = treeWith({ "README.md": "# Venom\n" });
  assert.deepEqual(scanForCredentialFiles(root, ["does/not/exist.txt"]), []);
});

test("the scan reads only the leading bytes of each file", () => {
  const reads: string[] = [];
  findCredentialFiles(["a.txt", "b.pem"], (path) => {
    reads.push(path);
    return "";
  });

  // `b.pem` is settled by its name alone, so it is never opened.
  assert.deepEqual(reads, ["a.txt"]);
});

test("a clean history passes the scan", () => {
  const root = repoWith({
    "README.md": "# Venom\n",
    "attached_assets/notes.md": `Rotate the key in the ${PRIVATE_KEY_BANNER} block.\n`,
    ".env.example": "DATABASE_URL=\n",
  });

  assert.deepEqual(scanHistoryForCredentials(root, ["HEAD"]), []);
});

test("a key committed and deleted before the sync is still refused", () => {
  const root = repoWith({ "README.md": "# Venom\n" });

  writeInto(root, { "attached_assets/app.private-key.pem": FAKE_KEY });
  commit(root, "add the key by mistake");
  rmSync(join(root, "attached_assets/app.private-key.pem"));
  commit(root, "delete the key again");

  // The checkout is clean, so a working-tree scan sees nothing to complain about.
  assert.deepEqual(scanForCredentialFiles(root, ["README.md"]), []);

  // The push would still carry the commit that added it.
  const findings = scanHistoryForCredentials(root, ["HEAD"]);
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["attached_assets/app.private-key.pem"],
  );

  // The refusal tells the reader which commit to rewrite, so it has to name a
  // commit that genuinely holds the key. `--find-object` also matches the commit
  // that *deleted* it, and rewriting that one would leave the key untouched
  // while the sync kept refusing, so the attribution is checked directly: the
  // named commit must still contain the file, and be the one that added it.
  const named = findings[0].where.replace("commit ", "");
  assert.match(findings[0].where, /^commit [0-9a-f]{7}$/);
  assert.equal(
    gitIn(root, "rev-parse", `${named}:attached_assets/app.private-key.pem`),
    gitIn(root, "rev-parse", "HEAD~1:attached_assets/app.private-key.pem"),
  );
  assert.equal(gitIn(root, "log", "-1", "--format=%s", named), "add the key by mistake");
});

test("a key banner is caught however large the file around it is", () => {
  const root = repoWith({ "README.md": "# Venom\n" });

  // Comfortably past the batch-read threshold: size must never buy a pass.
  const padded = `${FAKE_KEY}${"filler text, entirely harmless.\n".repeat(8_000)}`;
  writeInto(root, { "attached_assets/export.txt": padded });
  commit(root, "paste a key above a wall of text");
  rmSync(join(root, "attached_assets/export.txt"));
  commit(root, "tidy up");

  const findings = scanHistoryForCredentials(root, ["HEAD"]);
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["attached_assets/export.txt"],
  );
  assert.match(findings[0].reason, /private key banner/);
});

test("a key hidden under an innocent name is caught in history too", () => {
  const root = repoWith({ "README.md": "# Venom\n" });

  writeInto(root, { "attached_assets/meeting-notes.txt": FAKE_KEY });
  commit(root, "paste the key into notes");
  rmSync(join(root, "attached_assets/meeting-notes.txt"));
  commit(root, "tidy up");

  const findings = scanHistoryForCredentials(root, ["HEAD"]);
  assert.deepEqual(
    findings.map((finding) => finding.path),
    ["attached_assets/meeting-notes.txt"],
  );
  assert.match(findings[0].reason, /private key banner/);
});

test("history findings are reported once per file and place", () => {
  const findings: CredentialFinding[] = [
    { path: "a.pem", reason: "PEM key material", where: "working tree" },
    { path: "a.pem", reason: "PEM key material", where: "working tree" },
    { path: "a.pem", reason: "PEM key material", where: "commit abc1234" },
  ];

  assert.equal(dedupeFindings(findings).length, 2);
});

test("the refusal names every path and quotes no contents", () => {
  const findings: CredentialFinding[] = [
    { path: "attached_assets/app.private-key.pem", reason: "PEM key material", where: "commit abc1234" },
    {
      path: "attached_assets/harmless-looking.txt",
      reason: "file begins with a private key banner",
      where: "working tree",
    },
  ];
  const message = credentialRefusalMessage(findings);

  assert.match(message, /attached_assets\/app\.private-key\.pem/);
  assert.match(message, /attached_assets\/harmless-looking\.txt/);
  assert.match(message, /commit abc1234/);
  assert.match(message, /Replit Secret/);
  // A key inside a commit cannot be fixed by deleting the file, so say so.
  assert.match(message, /Regenerate that credential/);
  assert.doesNotMatch(message, /bm90LWEt/);
  assert.doesNotMatch(message, /BEGIN/);
});

test("the repository ignore rules match the guard's own template allowances", () => {
  // A file the guard permits must stay trackable, and one it refuses must not.
  const root = repoWith({ "README.md": "# Venom\n" });
  copyFileSync(join(REPO_ROOT, ".gitignore"), join(root, ".gitignore"));

  // `check-ignore` exits 1 for a path that is not ignored, so read the status.
  const check = (path: string): boolean => {
    writeInto(root, { [path]: "placeholder\n" });
    const result = spawnSync("git", ["-C", root, "check-ignore", "-q", path], {
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    return result.status === 0;
  };

  for (const path of [".env", ".env.production", "certs/server.pem", "android/app.keystore"]) {
    assert.equal(check(path), true, `expected ${path} to be ignored by git`);
    assert.notEqual(credentialNameReason(path), null, `expected the guard to refuse ${path}`);
  }

  for (const path of [".env.example", ".env.local.example", ".env.sample", "docs/notes.md"]) {
    assert.equal(check(path), false, `expected ${path} to stay trackable`);
    assert.equal(credentialNameReason(path), null, `expected the guard to allow ${path}`);
  }
});
