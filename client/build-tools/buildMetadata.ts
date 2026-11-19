// BuildMetadataV1 (specs/build-metadata.md §3): the record the React Native
// writer emits and its deterministic serialization. Pure functions; nothing
// here touches the file system.
//
// The writer does not carry a copy of the parser. Its inputs are valid by
// construction (the calculator checks the digest, embeddedTree.ts builds the
// list), and test/build-tools/buildMetadata.test.ts runs what it writes
// through the shared parser.

export const BUILD_METADATA_FILE_NAME = "CodemagicPatchBuild.json";
export const BUILD_METADATA_SCHEMA_VERSION = 1;

export type BuildMetadataV1 = {
  schemaVersion: 1;
  fingerprint: string | null;
  engine: string | null;
  embeddedPackageHash: string | null;
  embeddedFiles: string[] | null;
};

export type ReactNativePlatform = "ios" | "android";

/** The fixed React Native layouts of spec §4.2, relative to the payload root. */
export type ReactNativeLayout = {
  platform: ReactNativePlatform;
  /** The only supported bundle file name (§4.2 rule 3). */
  bundleFileName: string;
  /** Directory whose regular files join the tree, or null when none does. */
  assetsDirectory: string | null;
};

export const REACT_NATIVE_LAYOUTS: Readonly<Record<ReactNativePlatform, ReactNativeLayout>> = {
  ios: { platform: "ios", bundleFileName: "main.jsbundle", assetsDirectory: "assets" },
  android: { platform: "android", bundleFileName: "index.android.bundle", assetsDirectory: null },
};

export type EmbeddedPair = {
  embeddedPackageHash: string;
  embeddedFiles: string[];
};

/**
 * The React Native writer's record. `embedded` is null only for an
 * intentionally Metro-served development build (spec §5.2).
 */
export function buildReactNativeRecord(input: {
  fingerprint: string;
  engine: string;
  embedded: EmbeddedPair | null;
}): BuildMetadataV1 {
  return {
    schemaVersion: 1,
    fingerprint: input.fingerprint,
    engine: input.engine,
    embeddedPackageHash: input.embedded?.embeddedPackageHash ?? null,
    embeddedFiles: input.embedded ? [...input.embedded.embeddedFiles] : null,
  };
}

/**
 * Deterministic serialization: fixed member order, two-space indentation, a
 * trailing newline. Encode the result as UTF-8 without a byte-order mark.
 * Equal records always give byte-equal output, which is what lets the writer
 * skip a rewrite when nothing changed.
 */
export function serializeBuildMetadata(record: BuildMetadataV1): string {
  const ordered = {
    schemaVersion: record.schemaVersion,
    fingerprint: record.fingerprint,
    engine: record.engine,
    embeddedPackageHash: record.embeddedPackageHash,
    embeddedFiles: record.embeddedFiles,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
