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
  const seenPaths = new Set<string>();
  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset < tarBytes.length) {
    if (offset + 512 > tarBytes.length) {
      throw new Error("TAR header exceeds archive bounds");
    }

    const header = tarBytes.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      break;
    }

    const typeFlag = header[156] ?? 0;
    const size = readTarOctal(header, 124, 12);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;

    // A negative or fractional size would leave the offset unchanged and spin
    // this loop forever instead of failing the job.
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid TAR entry size: ${size}`);
    }

    if (contentEnd > tarBytes.length) {
      throw new Error("TAR entry exceeds archive bounds");
    }

    if (typeFlag === TAR_LONGNAME_TYPE_FLAG) {
      if (pendingLongName !== null) {
        throw new Error("TAR long-name record follows another long-name record");
      }

      pendingLongName = readTarLongName(tarBytes.subarray(contentStart, contentEnd));
      offset = contentStart + roundUpToTarBlock(size);
      continue;
    }

    if (typeFlag !== 0 && typeFlag !== 48) {
      throw new Error(`Unsupported TAR entry type: ${String.fromCharCode(typeFlag)}`);
    }

    const archivePath = validateCanonicalArchivePath(
      pendingLongName ?? readTarPath(header),
    );
    pendingLongName = null;

    if (seenPaths.has(archivePath)) {
      throw new Error(`TAR archive contains duplicate path: ${archivePath}`);
    }
    seenPaths.add(archivePath);

    entries.push({
      bytes: tarBytes.subarray(contentStart, contentEnd),
      path: archivePath,
    });

    offset = contentStart + roundUpToTarBlock(size);
  }

  if (pendingLongName !== null) {
    throw new Error("TAR long-name record has no following entry");
  }

  return buildBundleTree(entries);
}

/**
 * PROTOCOL.md requires every decoded path — split or long-name — to pass the
 * same validation, which is what the client C extractor does before joining a
 * path onto the output directory. Entries reach the filesystem via
 * writeBundleTreeToDirectory, so the server must not be the weaker decoder.
 */
function validateCanonicalArchivePath(archivePath: string): string {
  if (archivePath.length === 0 || archivePath.startsWith("/")) {
    throw new Error("TAR entry path must be relative and non-empty");
  }

  if (archivePath.includes("\\")) {
    throw new Error(`TAR entry path must not contain backslashes: ${archivePath}`);
  }

  const segments = archivePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`TAR entry path must not contain '.' or '..' segments: ${archivePath}`);
  }

  if (
    segments.some(
      (segment) => Buffer.byteLength(segment, "utf8") > MAX_ARCHIVE_PATH_SEGMENT_BYTES,
    )
  ) {
    throw new Error(`TAR entry path segment exceeds ${MAX_ARCHIVE_PATH_SEGMENT_BYTES} bytes`);
  }

  return archivePath;
}

// PROTOCOL.md › Full Bundle Archive Format › GNU long-name records. The writer
// (materializeBundleArchive.ts) imports these so reader and writer cannot drift
// to different caps or type flags.
export const TAR_LONGNAME_TYPE_FLAG = 76; // 'L'
export const MAX_TAR_LONGNAME_BYTES = 4096;

/**
 * Filesystem NAME_MAX on Android ext4/f2fs and iOS APFS. A longer segment is
 * encodable on the wire but fails mkdir/fopen with ENAMETOOLONG on every
 * device, so producers must reject it rather than publish it.
 */
export const MAX_ARCHIVE_PATH_SEGMENT_BYTES = 255;

/**
 * Reserve half of iOS PATH_MAX for the absolute install root and separators
 * added when archive paths are joined beneath the application container.
 */
export const MAX_DEVICE_ARCHIVE_PATH_BYTES = 512;

function readTarLongName(data: Uint8Array): string {
  if (data.length < 2 || data.length > MAX_TAR_LONGNAME_BYTES + 1) {
    throw new Error(`Invalid TAR long-name record length: ${data.length}`);
  }

  if (data.indexOf(0) !== data.length - 1) {
    throw new Error("TAR long-name record must end with a single trailing NUL");
  }

  return Buffer.from(data.subarray(0, data.length - 1)).toString("utf8");
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

  assertDeviceRepresentablePath(normalized, segments);

  return normalized;
}

/**
 * Reject at upload the paths the archive can encode but no device can
 * materialize — otherwise the API accepts the bundle and the release job fails
 * asynchronously, or worse, publishes an archive that fails every install.
 */
function assertDeviceRepresentablePath(archivePath: string, segments: string[]): void {
  const pathBytes = Buffer.byteLength(archivePath, "utf8");
  if (pathBytes > MAX_DEVICE_ARCHIVE_PATH_BYTES) {
    throw new Error(
      `ZIP entry path is ${pathBytes} bytes, over the ${MAX_DEVICE_ARCHIVE_PATH_BYTES}-byte limit devices can extract: ${archivePath}`,
    );
  }

  for (const segment of segments) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (segmentBytes > MAX_ARCHIVE_PATH_SEGMENT_BYTES) {
      throw new Error(
        `ZIP entry path segment is ${segmentBytes} bytes, over the ${MAX_ARCHIVE_PATH_SEGMENT_BYTES}-byte filesystem limit: ${archivePath}`,
      );
    }
  }
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
