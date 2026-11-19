import type { BuildMetadataRule } from "../buildMetadata";

/**
 * What went wrong reading a store artifact. Every code is a failure: an absent
 * metadata file is a successful read (`metadataPresent: false`), never one of
 * these, and none of these is ever reported as absence.
 */
export type StoreArtifactErrorCode =
  /** Not an `.xcarchive` directory, `.ipa`, `.apk` or `.aab` file. */
  | "unsupported-artifact-type"
  /** The artifact or a file inside a directory artifact could not be opened or read. */
  | "unreadable-artifact"
  /** The container or a decoded file in it is corrupt, oversized or not what the format requires. */
  | "invalid-artifact"
  /** No application where the format puts one. */
  | "application-not-found"
  /** More than one candidate application and nothing that selects one. */
  | "ambiguous-application"
  /** `CFBundleShortVersionString` / `android:versionName` missing or empty. */
  | "missing-binary-version"
  /** The version is not a literal string (for example an Android resource reference). */
  | "unsupported-binary-version"
  /** `CodemagicPatchBuild.json` is present and malformed; `metadataRule` names the rule. */
  | "malformed-build-metadata";

export class StoreArtifactError extends Error {
  readonly artifactPath: string;
  readonly code: StoreArtifactErrorCode;
  readonly metadataRule?: BuildMetadataRule;

  constructor(
    code: StoreArtifactErrorCode,
    artifactPath: string,
    message: string,
    metadataRule?: BuildMetadataRule,
    cause?: unknown,
  ) {
    super(`${artifactPath}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = "StoreArtifactError";
    this.artifactPath = artifactPath;
    this.code = code;
    if (metadataRule !== undefined) {
      this.metadataRule = metadataRule;
    }
  }
}

/**
 * Internal: a structural decoding failure inside one file of the artifact. The
 * reader turns it into an `invalid-artifact` StoreArtifactError that names the
 * artifact and the file.
 */
export class ArtifactDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactDecodeError";
  }
}
