import { promises as fs } from "node:fs";
import path from "node:path";

import { normalizeArchiveEntryPath } from "@codemagic/patch-shared";
import { unzipSync, zipSync, type Zippable } from "fflate";

// fflate writes ZIP timestamps from Date's local-time fields. Constructing the
// DOS epoch in local time keeps it in range and byte-identical in every timezone.
const ZIP_MTIME = new Date(1980, 0, 1);

export async function createZipFromDirectory(
  sourceDir: string,
  outputPath: string,
): Promise<void> {
  const archivePaths = await listArchiveFiles(sourceDir);
  const zippable: Zippable = {};

  for (const archivePath of archivePaths) {
    const filePath = path.join(sourceDir, archivePath);
    zippable[archivePath] = [
      await fs.readFile(filePath),
      {
        level: 9,
        mtime: ZIP_MTIME,
      },
    ];
  }

  await fs.writeFile(outputPath, Buffer.from(zipSync(zippable, { level: 9 })));
}

export async function listArchiveFiles(sourceDir: string): Promise<string[]> {
  const files: string[] = [];

  await collectArchiveFiles(sourceDir, "", files);

  return files.sort((left, right) => left.localeCompare(right));
}

async function collectArchiveFiles(
  sourceDir: string,
  relativeDir: string,
  files: string[],
): Promise<void> {
  const absoluteDir = path.join(sourceDir, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const archivePath = relativePath.split(path.sep).join("/");

    if (entry.isDirectory()) {
      await collectArchiveFiles(sourceDir, relativePath, files);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(
        `Bundle output contains an unsupported entry: ${archivePath}`,
      );
    }

    files.push(archivePath);
  }
}

/**
 * List the payload file paths of a ZIP without inflating any entry data: the
 * fflate filter sees each entry's metadata and rejects it before
 * decompression. Entry names go through the same normalization the server
 * applies before writing the tar, so publish-time path checks see exactly the
 * paths the writer will.
 */
export function listZipPayloadFiles(zipBytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(zipBytes, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });

  return toPayloadPaths(names);
}

/**
 * Normalize and drop the entries the server excludes from the payload tree
 * (directories, `__MACOSX/`, `.DS_Store`), so a directory listing and a ZIP
 * listing produce the same path set for the same payload.
 */
export function toPayloadPaths(entryPaths: string[]): string[] {
  const payloadPaths: string[] = [];

  for (const entryPath of entryPaths) {
    const normalized = normalizeArchiveEntryPath(entryPath);
    if (normalized !== null) {
      payloadPaths.push(normalized);
    }
  }

  return payloadPaths;
}
