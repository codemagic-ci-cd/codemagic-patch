import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildBundleTree,
  bundleTreesEqual,
  type BundleTree,
} from "./bundleTree";
import { readBundleTreeFromDirectory, writeBundleTreeToDirectory } from "./bundleTreeFs";
import {
  isHdiffPatchPlatformSupported,
  resolveHdiffPatchBinaryPaths,
} from "./hdiffPatchBinaries";
import { zstdCompressSync, zstdDecompressSync } from "./zstd";

const execFileAsync = promisify(execFile);

export interface CreatePatchInput {
  source: BundleTree;
  target: BundleTree;
}

export interface DiffEngine {
  createPatch(input: CreatePatchInput): Promise<Buffer | null>;
}

interface MockPatchWireEntry {
  dataBase64: string;
  fileHash: string;
  path: string;
}

interface MockPatchWireFormat {
  entries: MockPatchWireEntry[];
  format: "mock-directory-snapshot-v1";
  sourcePackageHash: string;
  targetPackageHash: string;
}

class MockDiffEngine implements DiffEngine {
  async createPatch(input: CreatePatchInput): Promise<Buffer | null> {
    if (bundleTreesEqual(input.source, input.target)) {
      return null;
    }

    const wireFormat: MockPatchWireFormat = {
      entries: input.target.entries.map((entry) => ({
        dataBase64: Buffer.from(entry.bytes).toString("base64"),
        fileHash: entry.fileHash,
        path: entry.path,
      })),
      format: "mock-directory-snapshot-v1",
      sourcePackageHash: input.source.packageHash,
      targetPackageHash: input.target.packageHash,
    };

    return Buffer.from(
      zstdCompressSync(Buffer.from(JSON.stringify(wireFormat), "utf8")),
    );
  }
}

export const mockDiffEngine: DiffEngine = new MockDiffEngine();

export function applyMockPatchBuffer(patchBuffer: Buffer | Uint8Array): BundleTree {
  const json = Buffer.from(zstdDecompressSync(patchBuffer)).toString("utf8");
  const wireFormat = JSON.parse(json) as MockPatchWireFormat;

  if (wireFormat.format !== "mock-directory-snapshot-v1") {
    throw new Error(`Unsupported mock patch format: ${String(wireFormat.format)}`);
  }

  const tree = buildBundleTree(
    wireFormat.entries.map((entry) => ({
      bytes: Buffer.from(entry.dataBase64, "base64"),
      path: entry.path,
    })),
  );

  if (tree.packageHash !== wireFormat.targetPackageHash) {
    throw new Error(
      `Mock patch replay target hash mismatch: expected ${wireFormat.targetPackageHash}, got ${tree.packageHash}`,
    );
  }

  return tree;
}

export function inspectMockPatchBuffer(
  patchBuffer: Buffer | Uint8Array,
): {
  entryCount: number;
  sourcePackageHash: string;
  targetPackageHash: string;
} {
  const json = Buffer.from(zstdDecompressSync(patchBuffer)).toString("utf8");
  const wireFormat = JSON.parse(json) as MockPatchWireFormat;

  if (wireFormat.format !== "mock-directory-snapshot-v1") {
    throw new Error(`Unsupported mock patch format: ${String(wireFormat.format)}`);
  }

  return {
    entryCount: wireFormat.entries.length,
    sourcePackageHash: wireFormat.sourcePackageHash,
    targetPackageHash: wireFormat.targetPackageHash,
  };
}

class HdiffPatchDiffEngine implements DiffEngine {
  async createPatch(input: CreatePatchInput): Promise<Buffer | null> {
    if (bundleTreesEqual(input.source, input.target)) {
      return null;
    }

    return withTemporaryWorkspace("codemagic-patch-hdiff-", async (workspaceDir) => {
      const sourceDir = path.join(workspaceDir, "source");
      const targetDir = path.join(workspaceDir, "target");
      const patchPath = path.join(workspaceDir, "patch.bin");
      const binaries = await resolveHdiffPatchBinaryPaths();

      await writeBundleTreeToDirectory(input.source, sourceDir);
      await writeBundleTreeToDirectory(input.target, targetDir);
      await execFileAsync(binaries.hdiffz, [
        "-m-4",
        "-SD",
        "-c-zstd-21-25",
        "-d",
        sourceDir,
        targetDir,
        patchPath,
      ]);

      return readFile(patchPath);
    });
  }
}

export const hdiffPatchDiffEngine: DiffEngine = new HdiffPatchDiffEngine();

export async function applyHdiffPatchBuffer(
  source: BundleTree,
  patchBuffer: Buffer | Uint8Array,
): Promise<BundleTree> {
  return withTemporaryWorkspace("codemagic-patch-hpatch-", async (workspaceDir) => {
    const sourceDir = path.join(workspaceDir, "source");
    const outputDir = path.join(workspaceDir, "output");
    const patchPath = path.join(workspaceDir, "patch.bin");
    const binaries = await resolveHdiffPatchBinaryPaths();

    await writeBundleTreeToDirectory(source, sourceDir);
    await writeFile(patchPath, Buffer.from(patchBuffer));
    await execFileAsync(binaries.hpatchz, [sourceDir, patchPath, outputDir]);

    return readBundleTreeFromDirectory(outputDir);
  });
}

export function canUseHdiffPatchOnCurrentPlatform(): boolean {
  return isHdiffPatchPlatformSupported();
}

async function withTemporaryWorkspace<T>(
  prefix: string,
  run: (workspaceDir: string) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), prefix));

  try {
    return await run(workspaceDir);
  } finally {
    await rm(workspaceDir, { force: true, recursive: true });
  }
}
