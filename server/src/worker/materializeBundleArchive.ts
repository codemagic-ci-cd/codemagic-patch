import { Buffer } from "node:buffer";

import {
  readBundleEntriesFromZipBuffer,
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

function createDeterministicTarArchive(entries: BundleEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    chunks.push(createTarHeader(entry.path, entry.bytes.length));
    chunks.push(Buffer.from(entry.bytes));

    const remainder = entry.bytes.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }

  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function createTarHeader(archivePath: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(archivePath);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeChecksum(header, checksum);

  return header;
}

function splitTarPath(archivePath: string): { name: string; prefix: string } {
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

  throw new Error(`Archive path is too long for ustar header: ${archivePath}`);
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
