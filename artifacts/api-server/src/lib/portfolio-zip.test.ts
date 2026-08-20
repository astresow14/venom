import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  inspectPortfolioZip,
  PortfolioArchiveError,
} from "./portfolio-zip.js";

type FixtureEntry = {
  path: string;
  content?: string | Buffer;
  compression?: 0 | 8;
  flags?: number;
  externalAttributes?: number;
  declaredCompressedBytes?: number;
  declaredExpandedBytes?: number;
};

function makeZip(entries: FixtureEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const filename = Buffer.from(entry.path);
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? "");
    const method = entry.compression ?? 0;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const compressedBytes =
      entry.declaredCompressedBytes ?? compressed.length;
    const expandedBytes = entry.declaredExpandedBytes ?? content.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.flags ?? 0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(compressedBytes, 18);
    localHeader.writeUInt32LE(expandedBytes, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    const localRecord = Buffer.concat([localHeader, filename, compressed]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.flags ?? 0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(compressedBytes, 20);
    centralHeader.writeUInt32LE(expandedBytes, 24);
    centralHeader.writeUInt16LE(filename.length, 28);
    centralHeader.writeUInt32LE(entry.externalAttributes ?? 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, filename]));
    localOffset += localRecord.length;
  }

  const local = Buffer.concat(localRecords);
  const central = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function expectArchiveCode(archive: Buffer, code: string): void {
  assert.throws(
    () => inspectPortfolioZip(archive),
    (error: unknown) =>
      error instanceof PortfolioArchiveError && error.code === code,
  );
}

test("detects a bounded stack summary without retaining source content", () => {
  const manifest = inspectPortfolioZip(
    makeZip([
      {
        path: "product/package.json",
        content: JSON.stringify({
          dependencies: { react: "19", express: "5", tailwindcss: "4" },
        }),
        compression: 8,
      },
      { path: "product/vite.config.ts", content: "export default {}" },
      { path: "product/src/main.tsx", content: "source content is not retained" },
    ]),
  );

  assert.equal(manifest.rootKind, "single-project");
  assert.deepEqual(manifest.detectedStack, [
    "Node.js",
    "TypeScript",
    "Vite",
    "React",
    "Express",
    "Tailwind CSS",
  ]);
  assert.deepEqual(manifest.projectFiles, [
    "product/package.json",
    "product/vite.config.ts",
  ]);
  assert.equal(JSON.stringify(manifest).includes("source content"), false);
});

test("excludes credential-like paths and sensitive inspected content", () => {
  const manifest = inspectPortfolioZip(
    makeZip([
      { path: ".env.production", content: "TOKEN=not-persisted" },
      {
        path: "package.json",
        content: '{"api_key":"this-secret-value-must-not-be-indexed"}',
      },
      { path: "src/index.ts", content: "export const ok = true" },
    ]),
  );

  assert.equal(manifest.files.includes(".env.production"), false);
  assert.equal(manifest.projectFiles.includes("package.json"), false);
  assert.equal(manifest.excludedSensitiveFileCount, 2);
  assert.equal(JSON.stringify(manifest).includes("this-secret-value"), false);
});

test("rejects malformed, encrypted, traversal, absolute, and symlink archives", () => {
  expectArchiveCode(Buffer.from("not a zip"), "malformed_zip");
  expectArchiveCode(
    makeZip([{ path: "index.ts", content: "x", flags: 1 }]),
    "encrypted_archive",
  );
  expectArchiveCode(
    makeZip([{ path: "../outside.txt", content: "x" }]),
    "path_traversal",
  );
  expectArchiveCode(
    makeZip([{ path: "/absolute.txt", content: "x" }]),
    "invalid_path",
  );
  expectArchiveCode(
    makeZip([
      {
        path: "linked-file",
        content: "target",
        externalAttributes: (0xa000 << 16) >>> 0,
      },
    ]),
    "symlink_entry",
  );
});

test("rejects unsupported compression and declared expansion attacks", () => {
  expectArchiveCode(
    Buffer.from(
      makeZip([{ path: "legacy.bin", content: "x", compression: 0 }]).map(
        (byte, index) => (index === 8 || index === 52 ? 99 : byte),
      ),
    ),
    "unsupported_compression",
  );
  expectArchiveCode(
    makeZip([
      {
        path: "oversized.txt",
        content: "x",
        declaredCompressedBytes: 1,
        declaredExpandedBytes: 26 * 1024 * 1024,
      },
    ]),
    "entry_expansion_limit",
  );
  expectArchiveCode(
    makeZip([
      {
        path: "bomb.txt",
        content: "x",
        declaredCompressedBytes: 1,
        declaredExpandedBytes: 11 * 1024 * 1024,
      },
    ]),
    "expansion_bomb",
  );
});

test("rejects excessive entry counts before walking the directory", () => {
  const archive = Buffer.alloc(22);
  archive.writeUInt32LE(0x06054b50, 0);
  archive.writeUInt16LE(5_001, 8);
  archive.writeUInt16LE(5_001, 10);
  expectArchiveCode(archive, "entry_limit");
});