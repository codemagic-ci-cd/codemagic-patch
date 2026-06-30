import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import { decompress as zstdDecompress } from "fzstd";

import type { CommandDeps } from "./commands/shared";
import {
  buildDownloadUrl,
  fetchDeliveryBinary,
  fetchDeliveryJson,
} from "./delivery";

// Mirrors PLATFORM_BUNDLE_FILENAMES in commands/releaseReact.ts. Kept local to
// avoid a circular import (releaseReact imports this module). The entry path
// inside bundle.tar.zst is the bare filename — the archive payload tree has no
// `contents/` wrapper (PROTOCOL.md §Full Bundle Archive Contract).
const PLATFORM_BUNDLE_FILENAMES: Record<"android" | "ios", string> = {
  android: "index.android.bundle",
  ios: "main.jsbundle",
};

// Hermes bytecode file magic: the 64-bit `0x1F1903C103BC1FC6` written
// little-endian at the start of every hermesc-emitted `.hbc` file.
const HERMES_BYTECODE_MAGIC = Uint8Array.from([
  0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f,
]);

// Best-effort delivery fetches must never stall the build: a slow or hung origin
// degrades to a quiet skip within this bound (the optimization is optional).
const BASE_FETCH_TIMEOUT_MS = 60_000;

export type BaseBytecodeResolution =
  | { kind: "resolved"; path: string }
  | { kind: "skipped"; reason: string };

export type ResolveBaseBytecodeInput = {
  binaryVersion: string;
  deploymentKey: string;
  downloadBaseUrl: string;
  platform: "android" | "ios";
  /** Directory the resolved base file is written into (caller owns cleanup). */
  tempDir: string;
};

/**
 * Acquire the immediate-predecessor release's Hermes bytecode to align the new
 * compile against. Best-effort throughout: any miss returns a `skipped` result
 * with a concise reason, never throws — the caller compiles without a base.
 */
export async function resolveBaseBytecode(
  deps: Pick<CommandDeps, "fetch">,
  input: ResolveBaseBytecodeInput,
): Promise<BaseBytecodeResolution> {
  // buildDownloadUrl calls `new URL`, which throws on a malformed base URL (the
  // SDK-config value is not validated as a URL); guard it so a bad config skips
  // rather than crashing the release.
  let manifestUrl: string;
  try {
    manifestUrl = buildDownloadUrl(input.downloadBaseUrl, [
      input.deploymentKey,
      input.binaryVersion,
      "manifest.json",
    ]);
  } catch (error) {
    return skip(`invalid download base URL${suffix(error)}`);
  }

  let manifest: Awaited<ReturnType<typeof fetchDeliveryJson>>;
  try {
    manifest = await fetchDeliveryJson(deps.fetch, manifestUrl, {
      timeoutMs: BASE_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    return skip(`could not reach the delivery manifest${suffix(error)}`);
  }

  if (!manifest.ok) {
    return skip(
      manifest.status === 404
        ? "no published predecessor for this binary version"
        : `manifest request failed (HTTP ${manifest.status})`,
    );
  }

  const target = readManifestTarget(manifest.body);
  if (target.kind === "none") {
    return skip(target.reason);
  }

  let archive: Awaited<ReturnType<typeof fetchDeliveryBinary>>;
  try {
    archive = await fetchDeliveryBinary(deps.fetch, target.fullBundleUrl, {
      timeoutMs: BASE_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    return skip(`could not download the predecessor bundle${suffix(error)}`);
  }

  if (!archive.ok || archive.bytes === undefined) {
    return skip(`predecessor bundle download failed (HTTP ${archive.status})`);
  }

  let tar: Uint8Array;
  try {
    tar = zstdDecompress(archive.bytes);
  } catch (error) {
    return skip(`could not decompress the predecessor bundle${suffix(error)}`);
  }

  const bundleFilename = PLATFORM_BUNDLE_FILENAMES[input.platform];
  const entry = extractTarEntry(tar, bundleFilename);
  if (entry === undefined) {
    return skip(`predecessor bundle did not contain ${bundleFilename}`);
  }

  if (!isHermesBytecode(entry)) {
    return skip("predecessor bundle is not Hermes bytecode");
  }

  const basePath = path.join(input.tempDir, `base-${input.platform}.hbc`);
  try {
    await fs.writeFile(basePath, entry);
  } catch (error) {
    return skip(`could not stage the base bytecode${suffix(error)}`);
  }

  return { kind: "resolved", path: basePath };
}

type ManifestTarget =
  | { fullBundleUrl: string; kind: "target" }
  | { kind: "none"; reason: string };

function readManifestTarget(body: unknown): ManifestTarget {
  if (!isRecord(body)) {
    return { kind: "none", reason: "delivery manifest was malformed" };
  }

  // A null target hash is the protocol's "no healthy OTA" sentinel, so there is
  // no predecessor to align to.
  if (body.target_package_hash === null) {
    return { kind: "none", reason: "no published predecessor for this binary version" };
  }

  if (typeof body.full_bundle_url !== "string" || body.full_bundle_url.length === 0) {
    return { kind: "none", reason: "delivery manifest had no full bundle URL" };
  }

  return { fullBundleUrl: body.full_bundle_url, kind: "target" };
}

function isHermesBytecode(bytes: Uint8Array): boolean {
  if (bytes.length < HERMES_BYTECODE_MAGIC.length) {
    return false;
  }

  return HERMES_BYTECODE_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * Extract a single regular-file entry from a POSIX `ustar` tar stream (the
 * narrow profile written by the server — see PROTOCOL.md §Full Bundle Archive
 * Format). Returns `undefined` if the entry is absent or the stream is
 * truncated.
 */
function extractTarEntry(
  tar: Uint8Array,
  targetPath: string,
): Uint8Array | undefined {
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = readTarOctal(header, 124, 12);
    const typeFlag = header[156];

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      break;
    }

    // Regular file: type flag '0' (0x30) or NUL.
    if ((typeFlag === 0x30 || typeFlag === 0) && fullPath === targetPath) {
      return tar.subarray(dataStart, dataEnd);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return undefined;
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) {
    end += 1;
  }

  return Buffer.from(block.subarray(offset, end)).toString("utf8");
}

function readTarOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = Buffer.from(block.subarray(offset, offset + length)).toString(
    "latin1",
  );
  const trimmed = raw.replace(/\0[\s\S]*$/, "").trim();
  if (trimmed.length === 0) {
    return 0;
  }

  const value = Number.parseInt(trimmed, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function skip(reason: string): BaseBytecodeResolution {
  return { kind: "skipped", reason };
}

function suffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return ` (${error.message})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
