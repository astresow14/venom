import { inflateRawSync } from "node:zlib";
import type { VenomSourceManifest } from "@workspace/db";

const MAX_ENTRIES = 5_000;
const MAX_TOTAL_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_ENTRY_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 100;
const MAX_INSPECTED_TEXT_BYTES = 256 * 1024;
const MAX_MANIFEST_FILES = 200;
const MAX_PROJECT_FILES = 40;
const MAX_INSPECTION_MS = 8_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

type ZipEntry = {
  path: string;
  compressedBytes: number;
  expandedBytes: number;
  compressionMethod: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  sensitive: boolean;
};

const PROJECT_FILENAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "app.json",
  "app.config.js",
  "app.config.ts",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "cargo.toml",
  "gemfile",
  "composer.json",
  "pubspec.yaml",
  "dockerfile",
]);

const SENSITIVE_NAME_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(?:service[-_]?account|firebase[-_]?admin).*\.json$/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc)$/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
  /\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|password)\b["']?\s*[:=]\s*["'][^"']{8,}["']/i,
];

export class PortfolioArchiveError extends Error {
  constructor(
    public readonly code: string,
    public readonly clientMessage: string,
  ) {
    super(clientMessage);
    this.name = "PortfolioArchiveError";
  }
}

function reject(code: string, message: string): never {
  throw new PortfolioArchiveError(code, message);
}

function checkDeadline(startedAt: number): void {
  if (Date.now() - startedAt > MAX_INSPECTION_MS) {
    reject("inspection_timeout", "Archive inspection took too long");
  }
}

function normalizedEntryPath(rawName: string): string {
  if (rawName.includes("\0")) {
    reject("invalid_path", "Archive contains an invalid path");
  }
  const normalized = rawName.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    reject("invalid_path", "Archive contains an unsafe absolute path");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    reject("path_traversal", "Archive contains a traversal path");
  }
  if (normalized.length > 240) {
    reject("path_too_long", "Archive contains a path that is too long");
  }
  return segments.filter((segment) => segment !== "." && segment !== "").join("/");
}

function findEocd(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  reject("malformed_zip", "Archive is not a valid ZIP file");
}

function parseEntries(archive: Buffer, startedAt: number): ZipEntry[] {
  if (archive.length < 22) {
    reject("malformed_zip", "Archive is not a valid ZIP file");
  }
  const eocd = findEocd(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralBytes = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  const commentBytes = archive.readUInt16LE(eocd + 20);

  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    reject("unsupported_zip", "Multi-disk and ZIP64 archives are not supported");
  }
  if (totalEntries < 1 || totalEntries > MAX_ENTRIES) {
    reject("entry_limit", "Archive contains too many entries");
  }
  if (eocd + 22 + commentBytes > archive.length) {
    reject("malformed_zip", "Archive has an invalid end record");
  }
  if (
    centralOffset + centralBytes > eocd ||
    centralOffset + centralBytes > archive.length
  ) {
    reject("malformed_zip", "Archive directory is invalid");
  }

  const entries: ZipEntry[] = [];
  const seenPaths = new Set<string>();
  let cursor = centralOffset;
  let totalExpanded = 0;
  let totalCompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    checkDeadline(startedAt);
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      reject("malformed_zip", "Archive directory is malformed");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedBytes = archive.readUInt32LE(cursor + 20);
    const expandedBytes = archive.readUInt32LE(cursor + 24);
    const filenameBytes = archive.readUInt16LE(cursor + 28);
    const extraBytes = archive.readUInt16LE(cursor + 30);
    const entryCommentBytes = archive.readUInt16LE(cursor + 32);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const recordBytes = 46 + filenameBytes + extraBytes + entryCommentBytes;

    if (cursor + recordBytes > archive.length || filenameBytes < 1) {
      reject("malformed_zip", "Archive entry metadata is malformed");
    }
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      reject("encrypted_archive", "Encrypted archives are not supported");
    }
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      reject("symlink_entry", "Archives containing symbolic links are not supported");
    }

    const rawName = archive
      .subarray(cursor + 46, cursor + 46 + filenameBytes)
      .toString("utf8");
    const path = normalizedEntryPath(rawName);
    if (seenPaths.has(path)) {
      reject("duplicate_path", "Archive contains duplicate paths");
    }
    seenPaths.add(path);

    const isDirectory = rawName.endsWith("/");
    if (!isDirectory && compressionMethod !== 0 && compressionMethod !== 8) {
      reject("unsupported_compression", "Archive uses an unsupported compression method");
    }
    if (expandedBytes > MAX_ENTRY_EXPANDED_BYTES) {
      reject("entry_expansion_limit", "Archive contains an oversized expanded file");
    }
    totalExpanded += expandedBytes;
    totalCompressed += compressedBytes;
    if (totalExpanded > MAX_TOTAL_EXPANDED_BYTES) {
      reject("expansion_limit", "Archive expands beyond the supported limit");
    }
    if (
      totalCompressed > 0 &&
      totalExpanded > 10 * 1024 * 1024 &&
      totalExpanded / totalCompressed > MAX_EXPANSION_RATIO
    ) {
      reject("expansion_bomb", "Archive has an unsafe expansion ratio");
    }

    entries.push({
      path,
      compressedBytes,
      expandedBytes,
      compressionMethod,
      localHeaderOffset,
      isDirectory,
      sensitive: SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(path)),
    });
    cursor += recordBytes;
  }

  if (cursor !== centralOffset + centralBytes) {
    reject("malformed_zip", "Archive directory length is inconsistent");
  }
  return entries;
}

function readEntryText(archive: Buffer, entry: ZipEntry): string | null {
  if (
    entry.isDirectory ||
    entry.sensitive ||
    entry.expandedBytes > MAX_INSPECTED_TEXT_BYTES
  ) {
    return null;
  }
  const offset = entry.localHeaderOffset;
  if (
    offset + 30 > archive.length ||
    archive.readUInt32LE(offset) !== LOCAL_SIGNATURE
  ) {
    reject("malformed_zip", "Archive contains an invalid file header");
  }
  const filenameBytes = archive.readUInt16LE(offset + 26);
  const extraBytes = archive.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + filenameBytes + extraBytes;
  const dataEnd = dataOffset + entry.compressedBytes;
  if (dataEnd > archive.length) {
    reject("malformed_zip", "Archive file data is truncated");
  }
  const compressed = archive.subarray(dataOffset, dataEnd);
  let content: Buffer;
  try {
    content =
      entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: MAX_INSPECTED_TEXT_BYTES + 1,
          });
  } catch {
    reject("malformed_zip", "Archive contains unreadable compressed data");
  }
  if (content.length !== entry.expandedBytes || content.length > MAX_INSPECTED_TEXT_BYTES) {
    reject("malformed_zip", "Archive file size is inconsistent");
  }
  if (content.includes(0)) return null;
  const text = content.toString("utf8");
  return SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(text))
    ? null
    : text;
}

function detectStack(
  entries: ZipEntry[],
  projectText: Map<string, string>,
): string[] {
  const stack = new Set<string>();
  const paths = entries.map((entry) => entry.path.toLowerCase());
  const has = (name: string) =>
    paths.some((path) => path === name || path.endsWith(`/${name}`));

  if (has("package.json")) stack.add("Node.js");
  if (
    has("tsconfig.json") ||
    paths.some((path) => /\.(?:ts|tsx|mts|cts)$/.test(path))
  ) {
    stack.add("TypeScript");
  }
  if (has("vite.config.ts") || has("vite.config.js")) stack.add("Vite");
  if (has("next.config.js") || has("next.config.mjs") || has("next.config.ts"))
    stack.add("Next.js");
  if (has("app.json") || has("app.config.js") || has("app.config.ts"))
    stack.add("Expo");
  if (has("requirements.txt") || has("pyproject.toml")) stack.add("Python");
  if (has("go.mod")) stack.add("Go");
  if (has("cargo.toml")) stack.add("Rust");
  if (has("gemfile")) stack.add("Ruby");
  if (has("composer.json")) stack.add("PHP");
  if (has("pubspec.yaml")) stack.add("Flutter");

  for (const [path, text] of projectText) {
    if (!path.toLowerCase().endsWith("package.json")) continue;
    try {
      const parsed = JSON.parse(text) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        workspaces?: unknown;
      };
      const dependencies = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {}),
      };
      if ("react" in dependencies) stack.add("React");
      if ("react-native" in dependencies) stack.add("React Native");
      if ("expo" in dependencies) stack.add("Expo");
      if ("vue" in dependencies) stack.add("Vue");
      if ("svelte" in dependencies) stack.add("Svelte");
      if ("express" in dependencies) stack.add("Express");
      if ("fastify" in dependencies) stack.add("Fastify");
      if ("@nestjs/core" in dependencies) stack.add("NestJS");
      if ("tailwindcss" in dependencies) stack.add("Tailwind CSS");
      if (parsed.workspaces) stack.add("Monorepo");
    } catch {
      // A malformed package.json should not expose content or block detection
      // from the archive's other known project markers.
    }
  }
  return [...stack].slice(0, 20);
}

export function inspectPortfolioZip(archive: Buffer): VenomSourceManifest {
  const startedAt = Date.now();
  const entries = parseEntries(archive, startedAt);
  const safeFiles = entries.filter((entry) => !entry.isDirectory && !entry.sensitive);
  const projectEntries = safeFiles.filter((entry) =>
    PROJECT_FILENAMES.has(entry.path.split("/").at(-1)?.toLowerCase() ?? ""),
  );
  const projectText = new Map<string, string>();
  let excludedSensitiveFileCount = entries.filter(
    (entry) => !entry.isDirectory && entry.sensitive,
  ).length;

  for (const entry of projectEntries.slice(0, MAX_PROJECT_FILES)) {
    checkDeadline(startedAt);
    const text = readEntryText(archive, entry);
    if (text === null) {
      excludedSensitiveFileCount += 1;
      continue;
    }
    projectText.set(entry.path, text);
  }

  const detectedStack = detectStack(entries, projectText);
  const rootKind =
    entries.some((entry) =>
      ["pnpm-workspace.yaml", "turbo.json", "nx.json"].includes(
        entry.path.split("/").at(-1)?.toLowerCase() ?? "",
      ),
    ) || detectedStack.includes("Monorepo")
      ? "monorepo"
      : "single-project";

  return {
    formatVersion: 1,
    rootKind,
    totalEntries: entries.length,
    safeFileCount: safeFiles.length,
    excludedSensitiveFileCount: Math.min(
      excludedSensitiveFileCount,
      entries.length,
    ),
    files: safeFiles
      .map((entry) => entry.path)
      .sort()
      .slice(0, MAX_MANIFEST_FILES),
    projectFiles: [...projectText.keys()].sort().slice(0, MAX_PROJECT_FILES),
    detectedStack,
  };
}