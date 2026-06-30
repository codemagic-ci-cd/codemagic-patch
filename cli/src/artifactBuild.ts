import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CMPATCH_BUNDLE_FILE,
  CMPATCH_KIND,
  CMPATCH_SCHEMA_VERSION,
  type Artifact,
  type Bundler,
  type Platform,
  type ReleaseDescriptor,
  type ReleasePolicyDefaults,
  type ReleaseProvenance,
} from "@codemagic/patch-shared";

import { computePackageHashFromZipBuffer } from "./packageHash";
import { signContentHashJwt, SIGNATURE_HASH_ALGORITHM } from "./signing";
import { getCliVersion } from "./version";
import { createZipFromDirectory } from "./zip";

/** Minimal file-reading surface (a subset of CommandDeps) for testability. */
export type ArtifactBuildDeps = {
  readFile: (path: string) => Promise<Buffer>;
};

export type BuildArtifactInput = {
  /** Directory holding the bundle + assets (the verbatim release payload). */
  payloadRoot: string;
  platform: Platform;
  targetBinaryVersion: string;
  fingerprint: string;
  bundler: Bundler;
  hermes: boolean;
  defaults: ReleasePolicyDefaults;
  /** ISO timestamp; stamped by the caller so the build step stays testable. */
  createdAt: string;
  appName?: string;
  privateKeyPath?: string;
  sourcemapPath?: string;
};

/**
 * Package a built bundle directory into a full in-memory {@link Artifact}: zip the
 * payload deterministically, compute the package hash, optionally code-sign it, and
 * assemble the `cmpatch.json` descriptor (including provenance). The caller serializes
 * it to a `.cmpatch` (bundle command) or uploads it.
 *
 * Node-only: it spawns nothing, but it touches the filesystem (zip + reads) and the
 * private key, so it never runs in the browser.
 */
export async function buildArtifactFromBundleDir(
  deps: ArtifactBuildDeps,
  input: BuildArtifactInput,
): Promise<Artifact> {
  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "codemagic-patch-bundle-"));

  try {
    const zipPath = path.join(tempRoot, CMPATCH_BUNDLE_FILE);
    await createZipFromDirectory(input.payloadRoot, zipPath);
    const bundleZip = await deps.readFile(zipPath);
    const packageHash = computePackageHashFromZipBuffer(bundleZip);

    let signature: string | undefined;
    let signatureHashAlgorithm: string | undefined;
    if (input.privateKeyPath !== undefined) {
      const privateKeyPem = await deps.readFile(input.privateKeyPath);
      signature = signContentHashJwt({ contentHash: packageHash, privateKeyPem });
      signatureHashAlgorithm = SIGNATURE_HASH_ALGORITHM;
    }

    const sourcemap =
      input.sourcemapPath === undefined
        ? undefined
        : await deps.readFile(input.sourcemapPath);

    const provenance: ReleaseProvenance = {
      cliVersion: getCliVersion(),
      bundler: input.bundler,
      hermes: input.hermes,
      createdAt: input.createdAt,
    };
    if (input.appName !== undefined) {
      provenance.appName = input.appName;
    }

    const descriptor: ReleaseDescriptor = {
      schemaVersion: CMPATCH_SCHEMA_VERSION,
      kind: CMPATCH_KIND,
      packageHash,
      bundleFile: CMPATCH_BUNDLE_FILE,
      bundleSize: bundleZip.byteLength,
      platform: input.platform,
      targetBinaryVersion: input.targetBinaryVersion,
      fingerprint: input.fingerprint,
      defaults: input.defaults,
      provenance,
    };
    if (input.sourcemapPath !== undefined) {
      descriptor.sourcemapFile = path.basename(input.sourcemapPath);
    }
    if (signature !== undefined) {
      descriptor.signature = signature;
      descriptor.signatureHashAlgorithm = signatureHashAlgorithm;
    }

    const artifact: Artifact = { descriptor, bundleZip };
    if (sourcemap !== undefined) {
      artifact.sourcemap = sourcemap;
    }
    return artifact;
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
}
