import { promises as fs } from "node:fs";
import path from "node:path";

import { zipSync, type Zippable } from "fflate";

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
