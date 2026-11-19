// yauzl owns ZIP/ZIP64 decoding and inflation, and with them what counts as a
// well-formed archive: where the end record sits, multi-disk archives,
// encrypted entries and compression methods. This adapter adds the store
// reader's rules: UTF-8 names, duplicate names, entry types, CRC and size limits.

import { createHash } from "node:crypto";
import { once } from "node:events";
import { close, createReadStream, open } from "node:fs";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";

import { fromFdPromise, type Entry, type ZipFile } from "yauzl";

import { describeValue } from "../describeValue";
import { ArtifactDecodeError } from "./errors";

type ZipEntryKind = "directory" | "file" | "special" | "symlink";
export type ZipEntry = { name: string | null; kind: ZipEntryKind; entry: Entry };
export type ZipDirectory = { entries: ZipEntry[]; byName: Map<string, ZipEntry> };
export type ZipArchive = ZipDirectory & {
  read(entry: ZipEntry, maxBytes: number): Promise<Uint8Array>;
  sha256(): Promise<string>;
  close(): Promise<void>;
};

const openFd = promisify(open);
const closeFd = promisify(close);
// Xcode can store raw UTF-8 without bit 11. A leading U+FEFF is part of a name.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One descriptor owns enumeration, selective reads and the original-file hash. */
export async function openZipArchive(artifactPath: string): Promise<ZipArchive> {
  const fd = await openFd(artifactPath, "r");
  let zip: ZipFile;
  try {
    zip = await fromFdPromise(fd, { autoClose: false, decodeStrings: false, validateEntrySizes: true });
  } catch (error) {
    await closeFd(fd);
    throw error;
  }
  try {
    const directory = await readDirectory(zip);
    return {
      ...directory,
      read: (entry, maxBytes) => readEntry(zip, entry, maxBytes),
      sha256: async () => {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(artifactPath, { fd, autoClose: false, start: 0 })) {
          hash.update(chunk);
        }
        return hash.digest("hex");
      },
      close: () => closeZip(zip),
    };
  } catch (error) {
    await closeZip(zip);
    throw error;
  }
}

async function closeZip(zip: ZipFile): Promise<void> {
  const closed = once(zip, "close");
  zip.close();
  await closed;
}

async function readDirectory(zip: ZipFile): Promise<ZipDirectory> {
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  const rawNames = new Set<string>();
  for await (const entry of zip.eachEntry()) {
    const rawName = entry.fileNameRaw;
    const key = rawName.toString("hex");
    if (rawNames.has(key)) {
      throw new ArtifactDecodeError(
        `the archive holds more than one entry named ${describeValue(rawName.toString("utf8"), 300)}`,
      );
    }
    rawNames.add(key);
    let name: string | null;
    try {
      name = utf8.decode(rawName);
    } catch {
      name = null;
    }
    const item = { name, kind: entryKind(entry, name), entry };
    entries.push(item);
    if (name !== null) byName.set(name, item);
  }
  return { entries, byName };
}

function entryKind(entry: Entry, name: string | null): ZipEntryKind {
  if (name?.endsWith("/")) return "directory";
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (entry.versionMadeBy >>> 8 !== 3 || mode === 0 || mode === 0o100000) return "file";
  if (mode === 0o040000) return "directory";
  return mode === 0o120000 ? "symlink" : "special";
}

async function readEntry(zip: ZipFile, item: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  const { entry } = item;
  if (item.kind !== "file" || entry.uncompressedSize > maxBytes) {
    throw new ArtifactDecodeError("ZIP entry is not a regular file or exceeds its size limit");
  }
  // Deflate can add a little overhead, but must not consume unbounded input
  // just because it advertises a small decoded file.
  if (entry.compressedSize > maxBytes + 65536) {
    throw new ArtifactDecodeError("ZIP entry compressed data exceeds its size limit");
  }
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  let checksum = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw new ArtifactDecodeError("ZIP entry exceeds its size limit");
    checksum = crc32(chunk, checksum);
    chunks.push(chunk);
  }
  if (checksum !== entry.crc32) throw new ArtifactDecodeError("ZIP entry CRC does not match");
  return Buffer.concat(chunks, size);
}
