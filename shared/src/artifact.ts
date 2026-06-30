import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

import {
  ArtifactError,
  CMPATCH_DESCRIPTOR_FILE,
  parseDescriptor,
  type ReleaseDescriptor,
} from "./descriptor";

/** In-memory form of a `.cmpatch` artifact: the descriptor plus the raw payload bytes. */
export interface Artifact {
  descriptor: ReleaseDescriptor;
  /** The exact bundle zip the server ingests — carried verbatim, never re-zipped. */
  bundleZip: Uint8Array;
  sourcemap?: Uint8Array;
}

/**
 * Guard the sourcemap invariant: the bytes (`artifact.sourcemap`) and the name
 * (`descriptor.sourcemapFile`) must be both present or both absent. Catches a
 * caller mistake before it silently drops a sourcemap (or claims a missing one).
 */
export function assertArtifactConsistency(artifact: Artifact): void {
  const hasBytes = artifact.sourcemap !== undefined;
  const hasName = artifact.descriptor.sourcemapFile !== undefined;
  if (hasBytes !== hasName) {
    throw new ArtifactError(
      hasBytes
        ? "artifact has sourcemap bytes but descriptor.sourcemapFile is unset"
        : "descriptor.sourcemapFile is set but the artifact has no sourcemap bytes",
    );
  }
}

/** Pack an Artifact into `.cmpatch` container bytes (a zip). */
export function serializeArtifact(artifact: Artifact): Uint8Array {
  assertArtifactConsistency(artifact);
  const { descriptor } = artifact;
  const files: Zippable = {
    [CMPATCH_DESCRIPTOR_FILE]: strToU8(JSON.stringify(descriptor, null, 2)),
    // level 0 (store): bundle.zip is already compressed; don't waste time re-deflating it.
    [descriptor.bundleFile]: [artifact.bundleZip, { level: 0 }],
  };
  if (artifact.sourcemap !== undefined && descriptor.sourcemapFile !== undefined) {
    files[descriptor.sourcemapFile] = [artifact.sourcemap, { level: 0 }];
  }
  return zipSync(files);
}

/** Read `.cmpatch` container bytes back into an Artifact, validating the descriptor. */
export function parseArtifact(bytes: Uint8Array): Artifact {
  let entries: Record<string, Uint8Array>;
  try {
    // NOTE (MVP): the archive is fully decompressed with no size cap. This is a
    // deliberate trade-off — a .cmpatch is a user-supplied build artifact, so an
    // oversized / zip-bomb input only harms the uploader's own browser tab or
    // CLI process. Revisit with per-entry + total-size caps (and a two-pass
    // selective unzip of only the declared entries) before treating .cmpatch as a
    // cross-trust-boundary input.
    entries = unzipSync(bytes);
  } catch (error) {
    throw new ArtifactError(
      `not a valid .cmpatch archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // fflate returns a plain (prototype-bearing) object, so membership must be an
  // OWN-property check: a forged descriptor name like "constructor"/"__proto__"
  // would otherwise pass `in` and read an inherited value instead of failing.
  const hasEntry = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(entries, name);

  if (!hasEntry(CMPATCH_DESCRIPTOR_FILE)) {
    throw new ArtifactError(`.cmpatch archive is missing ${CMPATCH_DESCRIPTOR_FILE}`);
  }

  let descriptorJson: unknown;
  try {
    descriptorJson = JSON.parse(strFromU8(entries[CMPATCH_DESCRIPTOR_FILE]));
  } catch {
    throw new ArtifactError(`${CMPATCH_DESCRIPTOR_FILE} is not valid JSON`);
  }

  const descriptor = parseDescriptor(descriptorJson);

  if (!hasEntry(descriptor.bundleFile)) {
    throw new ArtifactError(
      `.cmpatch archive is missing its bundle file "${descriptor.bundleFile}"`,
    );
  }

  const artifact: Artifact = { descriptor, bundleZip: entries[descriptor.bundleFile] };

  if (descriptor.sourcemapFile !== undefined) {
    if (!hasEntry(descriptor.sourcemapFile)) {
      throw new ArtifactError(
        `.cmpatch archive declares sourcemapFile "${descriptor.sourcemapFile}" but it is missing`,
      );
    }
    artifact.sourcemap = entries[descriptor.sourcemapFile];
  }

  return artifact;
}
