import { createHash } from "node:crypto";
import path from "node:path";

import { unzipSync } from "fflate";

interface BundleEntry {
  manifestEntry: string;
  manifestEntryBytes: Buffer;
}

export function computePackageHashFromZipBuffer(
  zipBuffer: Buffer | Uint8Array,
): string {
  const zipBytes = toUint8Array(zipBuffer);
  validateZipEntryPaths(zipBytes);

  const entries = Object.entries(unzipSync(zipBytes))
    .map(([archivePath, fileBytes]): BundleEntry | null => {
      const normalizedPath = normalizeArchivePath(archivePath);

      if (!normalizedPath) {
        return null;
      }

      const fileHash = sha256Hex(fileBytes);
      const manifestEntry = `${normalizedPath}:${fileHash}`;

      return {
        manifestEntry,
        manifestEntryBytes: Buffer.from(manifestEntry, "utf8"),
      };
    })
    .filter((entry): entry is BundleEntry => entry !== null)
    .sort((left, right) =>
      Buffer.compare(left.manifestEntryBytes, right.manifestEntryBytes),
    );

  return sha256Hex(
    Buffer.from(
      JSON.stringify(entries.map((entry) => entry.manifestEntry)),
      "utf8",
    ),
  );
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

    const archivePath = Buffer.from(
      zipBytes.subarray(fileNameStart, fileNameEnd),
    ).toString("utf8");
    const normalizedPath = normalizeArchivePath(archivePath);

    if (normalizedPath) {
      if (normalizedPaths.has(normalizedPath)) {
        throw new Error(
          `ZIP archive contains duplicate normalized path: ${normalizedPath}`,
        );
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
