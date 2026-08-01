import { Buffer } from "node:buffer";

import {
  readBundleEntriesFromZipBuffer,
  MAX_ARCHIVE_PATH_SEGMENT_BYTES,
  MAX_DEVICE_ARCHIVE_PATH_BYTES,
  MAX_TAR_LONGNAME_BYTES,
  type BundleEntry,
  type BundleTree,
} from "./bundleTree";
import { zstdCompressSync } from "./zstd";

export function materializeCanonicalBundleArchive(
  zipBuffer: Buffer | Uint8Array,
): Buffer {
  return materializeCanonicalBundleArchiveFromEntries(
    readBundleEntriesFromZipBuffer(zipBuffer),
  );
}

/**
 * Client E2E materialization helper.
 *
 * The client harness builds bundle trees from real `react-native bundle`
 * outputs rather than ZIP uploads, so it needs the same canonical tar.zst
 * generation without going through the server release pipeline ZIP path.
 */
export function materializeCanonicalBundleArchiveFromTree(
  tree: Pick<BundleTree, "entries">,
): Buffer {
  return materializeCanonicalBundleArchiveFromEntries(tree.entries);
}

export function materializeCanonicalBundleArchiveFromEntries(
  entries: BundleEntry[],
): Buffer {
  return Buffer.from(zstdCompressSync(createDeterministicTarArchive(entries)));
}

// PROTOCOL.md › Full Bundle Archive Format: paths that cannot fit the ustar
// name/prefix fields are encoded as GNU long-name records. Client SDKs < 0.1.4
// reject 'L', so archives containing these install only on newer devices.
const TAR_LONGNAME_PLACEHOLDER = "././@LongLink";
const TAR_LONGNAME_TYPE_FLAG = "L";
const TAR_REGULAR_TYPE_FLAG = "0";

function createDeterministicTarArchive(entries: BundleEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    appendTarEntryHeader(chunks, entry.path, entry.bytes.length);
    chunks.push(Buffer.from(entry.bytes));
    appendTarBlockPadding(chunks, entry.bytes.length);
  }

  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function appendTarEntryHeader(
  chunks: Buffer[],
  archivePath: string,
  size: number,
): void {
  const pathBytes = Buffer.from(archivePath, "utf8");
  if (pathBytes.includes(0)) {
    throw new Error(`Archive path contains a NUL byte: ${archivePath}`);
  }

  assertDeviceRepresentablePath(archivePath, pathBytes);

  const split = splitTarPath(archivePath);
  if (split !== null) {
    chunks.push(
      createTarHeader(
        Buffer.from(split.name, "utf8"),
        split.prefix,
        size,
        TAR_REGULAR_TYPE_FLAG,
      ),
    );
    return;
  }

  if (pathBytes.length > MAX_TAR_LONGNAME_BYTES) {
    throw new Error(
      `Archive path exceeds ${MAX_TAR_LONGNAME_BYTES} bytes: ${archivePath}`,
    );
  }

  const longNameData = Buffer.concat([pathBytes, Buffer.alloc(1)]);
  chunks.push(
    createTarHeader(
      Buffer.from(TAR_LONGNAME_PLACEHOLDER, "utf8"),
      "",
      longNameData.length,
      TAR_LONGNAME_TYPE_FLAG,
    ),
  );
  chunks.push(longNameData);
  appendTarBlockPadding(chunks, longNameData.length);
  chunks.push(
    createTarHeader(pathBytes.subarray(0, 100), "", size, TAR_REGULAR_TYPE_FLAG),
  );
}

/**
 * The wire format can carry paths the device cannot create: a segment past
 * NAME_MAX fails mkdir/fopen with ENAMETOOLONG, and a path past the client's
 * validator buffer fails the post-install contents check. Publishing either
 * produces a release that fails every install, so the writer refuses it — the
 * ZIP ingest path rejects the same shapes at upload time.
 */
function assertDeviceRepresentablePath(archivePath: string, pathBytes: Buffer): void {
  if (pathBytes.length > MAX_DEVICE_ARCHIVE_PATH_BYTES) {
    throw new Error(
      `Archive path is ${pathBytes.length} bytes, over the ${MAX_DEVICE_ARCHIVE_PATH_BYTES}-byte limit devices can extract: ${archivePath}`,
    );
  }

  for (const segment of archivePath.split("/")) {
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (segmentBytes > MAX_ARCHIVE_PATH_SEGMENT_BYTES) {
      throw new Error(
        `Archive path segment is ${segmentBytes} bytes, over the ${MAX_ARCHIVE_PATH_SEGMENT_BYTES}-byte filesystem limit: ${archivePath}`,
      );
    }
  }
}

function appendTarBlockPadding(chunks: Buffer[], dataLength: number): void {
  const remainder = dataLength % 512;
  if (remainder !== 0) {
    chunks.push(Buffer.alloc(512 - remainder));
  }
}

function createTarHeader(
  nameBytes: Buffer,
  prefix: string,
  size: number,
  typeFlag: string,
): Buffer {
  const header = Buffer.alloc(512, 0);

  if (nameBytes.length > 100) {
    throw new Error(`Value exceeds tar field length: ${nameBytes.toString("utf8")}`);
  }
  nameBytes.copy(header, 0);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeFlag.charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeChecksum(header, checksum);

  return header;
}

function splitTarPath(
  archivePath: string,
): { name: string; prefix: string } | null {
  const encoded = Buffer.byteLength(archivePath, "utf8");
  if (encoded <= 100) {
    return { name: archivePath, prefix: "" };
  }

  const segments = archivePath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");

    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }

  return null;
}

function writeString(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) {
    throw new Error(`Value exceeds tar field length: ${value}`);
  }

  encoded.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = value.toString(8).padStart(length - 1, "0");
  if (octal.length >= length) {
    throw new Error(`Numeric value exceeds tar field length: ${value}`);
  }

  writeString(target, offset, length, `${octal}\0`);
}

function writeChecksum(target: Buffer, value: number): void {
  const checksum = value.toString(8).padStart(6, "0");
  writeString(target, 148, 8, `${checksum}\0 `);
}
