/**
 * The self-describing descriptor embedded as `cmpatch.json` inside a `.cmpatch`
 * release artifact.
 *
 * It carries everything intrinsic to a build (so the web/CLI can upload without
 * the React Native project checked out) plus advisory display data. The
 * deployment target and upload policy are intentionally NOT part of it — those
 * are supplied at upload time, which is what lets one artifact be dragged onto
 * any deployment or promoted across deployments.
 */

export const CMPATCH_SCHEMA_VERSION = 1;
export const CMPATCH_KIND = "codemagic-patch-release";
export const CMPATCH_DESCRIPTOR_FILE = "cmpatch.json";
export const CMPATCH_BUNDLE_FILE = "bundle.zip";

export type Platform = "ios" | "android";
export type Bundler = "metro" | "expo";

/** Policy defaults that seed the upload form/flags. Always overridable at upload. */
export interface ReleasePolicyDefaults {
  rolloutPercentage: number;
  isMandatory: boolean;
  disabled: boolean;
  noDuplicateReleaseError: boolean;
  releaseNotes: string;
}

/** Display-only provenance about how the artifact was built. */
export interface ReleaseProvenance {
  cliVersion: string;
  bundler: Bundler;
  hermes: boolean;
  appName?: string;
  createdAt: string;
}

export interface ReleaseDescriptor {
  schemaVersion: number;
  kind: string;
  /** Advisory — the server recomputes the package hash authoritatively on upload. */
  packageHash: string;
  bundleFile: string;
  bundleSize: number;
  sourcemapFile?: string;
  /** Intrinsic, read-only in the UI. */
  platform: Platform;
  targetBinaryVersion: string;
  fingerprint: string;
  /** Present only when the build was code-signed (the private key never leaves the CLI). */
  signature?: string;
  signatureHashAlgorithm?: string;
  defaults: ReleasePolicyDefaults;
  provenance: ReleaseProvenance;
}

/** Thrown when a `.cmpatch` artifact or its descriptor is malformed or unsupported. */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

/** Validate and normalize an untrusted `cmpatch.json` value into a ReleaseDescriptor. */
export function parseDescriptor(value: unknown): ReleaseDescriptor {
  const obj = asRecord(value, "cmpatch.json");

  if (obj.kind !== CMPATCH_KIND) {
    throw new ArtifactError(
      `unsupported artifact kind ${JSON.stringify(obj.kind)} (expected ${JSON.stringify(CMPATCH_KIND)})`,
    );
  }
  if (obj.schemaVersion !== CMPATCH_SCHEMA_VERSION) {
    throw new ArtifactError(
      `unsupported artifact schemaVersion ${JSON.stringify(
        obj.schemaVersion,
      )} (this tool supports ${CMPATCH_SCHEMA_VERSION})`,
    );
  }

  const descriptor: ReleaseDescriptor = {
    schemaVersion: CMPATCH_SCHEMA_VERSION,
    kind: CMPATCH_KIND,
    packageHash: requireString(obj, "packageHash"),
    bundleFile: requireString(obj, "bundleFile"),
    bundleSize: requireNumber(obj, "bundleSize"),
    platform: requirePlatform(obj),
    targetBinaryVersion: requireString(obj, "targetBinaryVersion"),
    fingerprint: requireString(obj, "fingerprint"),
    defaults: parseDefaults(obj.defaults),
    provenance: parseProvenance(obj.provenance),
  };

  assertSafeEntryName(descriptor.bundleFile, "bundleFile");

  const sourcemapFile = optionalString(obj, "sourcemapFile");
  if (sourcemapFile !== undefined) {
    assertSafeEntryName(sourcemapFile, "sourcemapFile");
    descriptor.sourcemapFile = sourcemapFile;
  }
  const signature = optionalString(obj, "signature");
  if (signature !== undefined) {
    descriptor.signature = signature;
  }
  const signatureHashAlgorithm = optionalString(obj, "signatureHashAlgorithm");
  if (signatureHashAlgorithm !== undefined) {
    descriptor.signatureHashAlgorithm = signatureHashAlgorithm;
  }

  return descriptor;
}

function parseDefaults(value: unknown): ReleasePolicyDefaults {
  const obj = asRecord(value, "cmpatch.json: defaults");
  return {
    rolloutPercentage: requireNumber(obj, "rolloutPercentage"),
    isMandatory: requireBoolean(obj, "isMandatory"),
    disabled: requireBoolean(obj, "disabled"),
    noDuplicateReleaseError: requireBoolean(obj, "noDuplicateReleaseError"),
    releaseNotes: requireStringAllowEmpty(obj, "releaseNotes"),
  };
}

function parseProvenance(value: unknown): ReleaseProvenance {
  const obj = asRecord(value, "cmpatch.json: provenance");
  const provenance: ReleaseProvenance = {
    cliVersion: requireString(obj, "cliVersion"),
    bundler: requireBundler(obj),
    hermes: requireBoolean(obj, "hermes"),
    createdAt: requireString(obj, "createdAt"),
  };
  const appName = optionalString(obj, "appName");
  if (appName !== undefined) {
    provenance.appName = appName;
  }
  return provenance;
}

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactError(`${ctx} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactError(`cmpatch.json: "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * bundleFile / sourcemapFile index the unzip map, so they must be flat, benign
 * archive entry names — no path segments, traversal, or prototype-polluting keys.
 * This hardens the boundary on top of the own-property lookup in parseArtifact.
 */
function assertSafeEntryName(name: string, key: string): void {
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    name === "__proto__" ||
    name === "constructor" ||
    name === "prototype"
  ) {
    throw new ArtifactError(
      `cmpatch.json: "${key}" must be a plain archive entry name (no path segments or reserved keys)`,
    );
  }
}

function requireStringAllowEmpty(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new ArtifactError(`cmpatch.json: "${key}" must be a string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ArtifactError(`cmpatch.json: "${key}" must be a string when present`);
  }
  return value;
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArtifactError(`cmpatch.json: "${key}" must be a finite number`);
  }
  return value;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new ArtifactError(`cmpatch.json: "${key}" must be a boolean`);
  }
  return value;
}

function requirePlatform(obj: Record<string, unknown>): Platform {
  const value = obj.platform;
  if (value !== "ios" && value !== "android") {
    throw new ArtifactError(`cmpatch.json: "platform" must be "ios" or "android"`);
  }
  return value;
}

function requireBundler(obj: Record<string, unknown>): Bundler {
  const value = obj.bundler;
  if (value !== "metro" && value !== "expo") {
    throw new ArtifactError(`cmpatch.json: provenance.bundler must be "metro" or "expo"`);
  }
  return value;
}
