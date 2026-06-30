import { createHash } from "node:crypto";
import path from "node:path";

import { unzipSync } from "fflate";
import { zstdDecompressSync } from "./zstd";

export interface BundleEntryInput {
  path: string;
  bytes: Buffer | Uint8Array;
}

export interface BundleEntry {
  path: string;
  bytes: Uint8Array;
  fileHash: string;
}

export interface BundleTree {
  entries: BundleEntry[];
  packageHash: string;
}

interface SortableBundleEntry extends BundleEntry {
  manifestEntry: string;
  manifestEntryBytes: Buffer;
}

export function readBundleTreeFromZipBuffer(zipBuffer: Buffer | Uint8Array): BundleTree {
  const zipBytes = toUint8Array(zipBuffer);
  validateZipEntryPaths(zipBytes);
  const archiveEntries = unzipSync(zipBytes);
  const entries: BundleEntryInput[] = [];

  for (const [archivePath, fileBytes] of Object.entries(archiveEntries)) {
    const normalizedPath = normalizeArchivePath(archivePath);
    if (!normalizedPath) {
      continue;
    }

    entries.push({
      bytes: fileBytes,
      path: normalizedPath,
    });
  }

  return buildBundleTree(entries);
}

export function readBundleEntriesFromZipBuffer(
  zipBuffer: Buffer | Uint8Array,
): BundleEntry[] {
  return readBundleTreeFromZipBuffer(zipBuffer).entries;
}

export function readBundleTreeFromCanonicalArchiveBuffer(
  archiveBuffer: Buffer | Uint8Array,
): BundleTree {
  const tarBytes = zstdDecompressSync(archiveBuffer);
  const entries: BundleEntryInput[] = [];
  let offset = 0;

  while (offset < tarBytes.length) {
    if (offset + 512 > tarBytes.length) {
      throw new Error("TAR header exceeds archive bounds");
    }

    const header = tarBytes.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      break;
    }

    const archivePath = readTarPath(header);
    const typeFlag = header[156] ?? 0;
    const size = readTarOctal(header, 124, 12);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;

    if (contentEnd > tarBytes.length) {
      throw new Error(`TAR entry exceeds archive bounds: ${archivePath}`);
    }

    if (typeFlag !== 0 && typeFlag !== 48) {
      throw new Error(`Unsupported TAR entry type for ${archivePath}: ${String.fromCharCode(typeFlag)}`);
    }

    entries.push({
      bytes: tarBytes.subarray(contentStart, contentEnd),
      path: archivePath,
    });

    offset = contentStart + roundUpToTarBlock(size);
  }

  return buildBundleTree(entries);
}

export function buildBundleTree(entries: BundleEntryInput[]): BundleTree {
  const sortedEntries = entries
    .map((entry): SortableBundleEntry => {
      const fileHash = sha256Hex(entry.bytes);
      const manifestEntry = `${entry.path}:${fileHash}`;

      return {
        bytes: toUint8Array(entry.bytes),
        fileHash,
        manifestEntry,
        manifestEntryBytes: Buffer.from(manifestEntry, "utf8"),
        path: entry.path,
      };
    })
    .sort(compareManifestEntriesLexicographically);

  const normalizedEntries = sortedEntries.map((entry) => ({
    bytes: entry.bytes,
    fileHash: entry.fileHash,
    path: entry.path,
  }));
  const manifestEntries = sortedEntries.map((entry) => entry.manifestEntry);

  return {
    entries: normalizedEntries,
    packageHash: sha256Hex(Buffer.from(JSON.stringify(manifestEntries), "utf8")),
  };
}

export function bundleTreesEqual(left: BundleTree, right: BundleTree): boolean {
  if (left.packageHash !== right.packageHash) {
    return false;
  }

  if (left.entries.length !== right.entries.length) {
    return false;
  }

  return left.entries.every((entry, index) => {
    const rightEntry = right.entries[index];

    return (
      rightEntry !== undefined &&
      entry.path === rightEntry.path &&
      entry.fileHash === rightEntry.fileHash
    );
  });
}

function normalizeArchivePath(archivePath: string): string | null {
  const posixPath = archivePath.replace(/\\/g, "/");

  if (posixPath.endsWith("/")) {
    return null;
  }

  if (posixPath.startsWith("/")) {
    throw new Error("ZIP entry path must be relative");
  }

  const normalized = path.posix.normalize(posixPath);
  if (normalized === "." || normalized.length === 0) {
    throw new Error("ZIP entry path must not be empty");
  }

  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("ZIP entry path must not contain '..' segments after normalization");
  }

  if (normalized === "__MACOSX" || normalized.startsWith("__MACOSX/")) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".DS_Store")) {
    return null;
  }

  return normalized;
}

function validateZipEntryPaths(zipBytes: Uint8Array): void {
  const { centralDirectoryOffset, entryCount } = locateEndOfCentralDirectory(zipBytes);
  let offset = centralDirectoryOffset;
  const normalizedPaths = new Set<string>();

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > zipBytes.length) {
      throw new Error("ZIP central directory entry exceeds archive bounds");
    }

    const signature = readUInt32LE(zipBytes, offset);
    if (signature !== 0x02014b50) {
      throw new Error("ZIP central directory is malformed");
    }

    const fileNameLength = readUInt16LE(zipBytes, offset + 28);
    const extraFieldLength = readUInt16LE(zipBytes, offset + 30);
    const fileCommentLength = readUInt16LE(zipBytes, offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;

    if (fileNameEnd > zipBytes.length) {
      throw new Error("ZIP central directory entry exceeds archive bounds");
    }

    const archivePath = Buffer.from(zipBytes.subarray(fileNameStart, fileNameEnd)).toString(
      "utf8",
    );
    const normalizedPath = normalizeArchivePath(archivePath);

    if (normalizedPath) {
      if (normalizedPaths.has(normalizedPath)) {
        throw new Error(`ZIP archive contains duplicate normalized path: ${normalizedPath}`);
      }
      normalizedPaths.add(normalizedPath);
    }

    offset = fileNameEnd + extraFieldLength + fileCommentLength;
  }
}

function locateEndOfCentralDirectory(
  zipBytes: Uint8Array,
): { centralDirectoryOffset: number; entryCount: number } {
  for (let offset = zipBytes.length - 22; offset >= 0; offset -= 1) {
    if (readUInt32LE(zipBytes, offset) !== 0x06054b50) {
      continue;
    }

    return {
      centralDirectoryOffset: readUInt32LE(zipBytes, offset + 16),
      entryCount: readUInt16LE(zipBytes, offset + 10),
    };
  }

  throw new Error("ZIP end of central directory record was not found");
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function sha256Hex(input: Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function toUint8Array(input: Buffer | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }

  return new Uint8Array(input);
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function readTarPath(header: Uint8Array): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);

  if (!name) {
    throw new Error("TAR entry name must not be empty");
  }

  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  const slice = end === -1 ? bytes : bytes.subarray(0, end);

  return Buffer.from(slice).toString("utf8");
}

function readTarOctal(header: Uint8Array, offset: number, length: number): number {
  const raw = readTarString(header, offset, length).trim();
  if (raw.length === 0) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid TAR octal field: ${raw}`);
  }

  return parsed;
}

function roundUpToTarBlock(size: number): number {
  const remainder = size % 512;
  return remainder === 0 ? size : size + (512 - remainder);
}

function compareManifestEntriesLexicographically(
  left: SortableBundleEntry,
  right: SortableBundleEntry,
): number {
  return Buffer.compare(left.manifestEntryBytes, right.manifestEntryBytes);
}
