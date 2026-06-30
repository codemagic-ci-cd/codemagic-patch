import { Buffer } from "node:buffer";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildBundleTree, type BundleTree } from "./bundleTree";

export async function writeBundleTreeToDirectory(
  tree: BundleTree,
  rootDir: string,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });

  for (const entry of tree.entries) {
    const outputPath = path.join(rootDir, ...entry.path.split("/"));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(entry.bytes));
  }
}

export async function readBundleTreeFromDirectory(rootDir: string): Promise<BundleTree> {
  const entries = await collectDirectoryEntries(rootDir, rootDir);
  return buildBundleTree(entries);
}

async function collectDirectoryEntries(
  rootDir: string,
  currentDir: string,
): Promise<Array<{ bytes: Buffer; path: string }>> {
  const dirents = await readdir(currentDir, { withFileTypes: true });
  const entries: Array<{ bytes: Buffer; path: string }> = [];

  for (const dirent of dirents) {
    const absolutePath = path.join(currentDir, dirent.name);

    if (dirent.isDirectory()) {
      entries.push(...(await collectDirectoryEntries(rootDir, absolutePath)));
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    const relativePath = path.relative(rootDir, absolutePath).split(path.sep).join("/");
    entries.push({
      bytes: await readFile(absolutePath),
      path: relativePath,
    });
  }

  return entries;
}
