// Store-artifact reader — specs/build-metadata.md §7. Opens an `.xcarchive`
// directory, `.ipa`, `.apk` or `.aab`, selects the application, reads the
// binary version and the build-metadata file at the React Native layout, and
// runs the shared parser. Nothing is extracted to disk and no executable runs.

import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  BuildMetadataError,
  parseBuildMetadata,
  REACT_NATIVE_BUILD_METADATA_LAYOUTS,
  type BuildMetadataLayout,
  type BuildMetadataV1,
} from "../buildMetadata";
import { describeValue } from "../describeValue";
import {
  readBinaryXmlVersionName,
  readProtoXmlVersionName,
  type ManifestVersionName,
} from "./androidManifest";
import { ArtifactDecodeError, StoreArtifactError } from "./errors";
import { isPlistDictionary, parsePlist } from "./plist";
import { openZipArchive, type ZipArchive, type ZipDirectory, type ZipEntry } from "./zip";

export type StoreArtifactPlatform = "android" | "ios";
export type StoreArtifactKind = "aab" | "apk" | "ipa" | "xcarchive";

export type StoreArtifactMetadata = {
  platform: StoreArtifactPlatform;
  binaryVersion: string;
  metadataPresent: boolean;
  fingerprint: string | null;
  fingerprintEngine: string | null;
  embeddedPackageHash: string | null;
  embeddedFiles: string[] | null;
  /** SHA-256 of the exact artifact file; null for an `.xcarchive` directory. */
  sha256: string | null;
};

/** Size limits for the files the reader decodes; anything larger is invalid. */
export const STORE_ARTIFACT_LIMITS = {
  buildMetadataBytes: 8 * 1024 * 1024,
  infoPlistBytes: 4 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
} as const;

const KIND_BY_EXTENSION: Readonly<Record<string, StoreArtifactKind>> = {
  ".aab": "aab",
  ".apk": "apk",
  ".ipa": "ipa",
  ".xcarchive": "xcarchive",
};

type MetadataOutcome = { record: BuildMetadataV1 | null };

/**
 * Read a store artifact's binary version and build metadata. Resolves with
 * `metadataPresent: false` only when the metadata file is truly absent at the
 * layout's location; every other problem rejects with a StoreArtifactError.
 */
export async function readStoreArtifact(artifactPath: string): Promise<StoreArtifactMetadata> {
  const kind = KIND_BY_EXTENSION[path.extname(artifactPath).toLowerCase()];
  if (kind === undefined) {
    throw new StoreArtifactError(
      "unsupported-artifact-type",
      artifactPath,
      "unsupported artifact type; expected an .xcarchive directory or an .ipa, .apk or .aab file",
    );
  }
  const platform: StoreArtifactPlatform = kind === "apk" || kind === "aab" ? "android" : "ios";
  const layout = REACT_NATIVE_BUILD_METADATA_LAYOUTS[platform];

  try {
    const stats = await stat(artifactPath);
    if (kind === "xcarchive" ? !stats.isDirectory() : !stats.isFile()) {
      throw new StoreArtifactError(
        "unsupported-artifact-type",
        artifactPath,
        kind === "xcarchive"
          ? "an .xcarchive must be a directory"
          : `an .${kind} must be a file`,
      );
    }

    if (kind === "xcarchive") {
      return await readXcarchive(artifactPath, layout);
    }
    return await readZipArtifact(artifactPath, kind, layout);
  } catch (error) {
    throw toStoreArtifactError(error, artifactPath);
  }
}

function toStoreArtifactError(error: unknown, artifactPath: string): unknown {
  if (error instanceof StoreArtifactError) {
    return error;
  }
  if (error instanceof BuildMetadataError) {
    return new StoreArtifactError(
      "malformed-build-metadata",
      artifactPath,
      `CodemagicPatchBuild.json is malformed (${error.rule}): ${error.message}`,
      error.rule,
    );
  }
  if (error instanceof ArtifactDecodeError) {
    return new StoreArtifactError("invalid-artifact", artifactPath, error.message);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    return new StoreArtifactError(
      "unreadable-artifact",
      artifactPath,
      code === "ENOENT" ? "no such file or directory" : `cannot be read (${code})`,
    );
  }
  // Everything thrown here happened while reading or decoding the artifact.
  // An error no decoder classified still ends in one of the codes; the
  // original is kept as `cause` so a reader defect stays diagnosable.
  return new StoreArtifactError(
    "invalid-artifact",
    artifactPath,
    `could not be decoded (${describeError(error)})`,
    undefined,
    error,
  );
}

function describeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const firstLine = String(error.message).split("\n")[0]?.trim() ?? "";
      return firstLine === "" ? error.name : `${error.name}: ${firstLine.slice(0, 200)}`;
    }
  } catch {
    // Fall through to the generic description.
  }
  return describeValue(error);
}

// ------------------------------------------------------------ zip formats ---

async function readZipArtifact(
  artifactPath: string,
  kind: "aab" | "apk" | "ipa",
  layout: BuildMetadataLayout,
): Promise<StoreArtifactMetadata> {
  const directory = await openZipArchive(artifactPath);
  try {
    let appRoot: string;
    let binaryVersion: string;

    if (kind === "ipa") {
      appRoot = selectIpaApplication(directory, artifactPath);
      const infoPlist = requireZipFile(directory, `${appRoot}Info.plist`);
      binaryVersion = iosVersion(
        parsePlist(await directory.read(infoPlist, STORE_ARTIFACT_LIMITS.infoPlistBytes)),
        artifactPath,
      );
    } else {
      appRoot = kind === "aab" ? "base/" : "";
      const manifestPath = kind === "aab" ? "base/manifest/AndroidManifest.xml" : "AndroidManifest.xml";
      const manifest = await directory.read(
        requireZipFile(directory, manifestPath),
        STORE_ARTIFACT_LIMITS.manifestBytes,
      );
      binaryVersion = androidVersion(
        kind === "aab" ? readProtoXmlVersionName(manifest) : readBinaryXmlVersionName(manifest),
        artifactPath,
      );
    }

    const { record } = await readZipMetadata(directory, `${appRoot}${layout.metadataPath}`, layout);
    const sha256 = await directory.sha256();
    return result(kind === "ipa" ? "ios" : "android", binaryVersion, record, sha256);
  } finally {
    await directory.close();
  }
}

/** Exactly one top-level `Payload/<name>.app/`; nested apps never count. */
function selectIpaApplication(directory: ZipDirectory, artifactPath: string): string {
  const apps = new Set<string>();
  for (const entry of directory.entries) {
    if (entry.name === null) {
      throw new ArtifactDecodeError("an entry name is not valid UTF-8");
    }
    const segments = entry.name.split("/");
    if (segments[0] === "Payload" && segments.length >= 3 && segments[1].endsWith(".app")) {
      apps.add(segments[1]);
    }
  }
  if (apps.size === 0) {
    throw new StoreArtifactError("application-not-found", artifactPath, "no application at Payload/*.app");
  }
  if (apps.size > 1) {
    throw new StoreArtifactError(
      "ambiguous-application",
      artifactPath,
      `more than one application under Payload/: ${[...apps].sort().join(", ")}`,
    );
  }
  return `Payload/${[...apps][0]}/`;
}

function requireZipFile(directory: ZipDirectory, name: string): ZipEntry {
  const entry = directory.byName.get(name);
  if (entry === undefined) {
    throw new ArtifactDecodeError(`${name} is missing`);
  }
  return requireRegularZipFile(entry, name);
}

/** §7.1 rule 5: only a regular file is read at a fixed path. */
function requireRegularZipFile(entry: ZipEntry, name: string): ZipEntry {
  switch (entry.kind) {
    case "file":
      return entry;
    case "symlink":
      throw new ArtifactDecodeError(`${name} is a symbolic link`);
    case "directory":
      throw new ArtifactDecodeError(`${name} is a directory`);
    case "special":
      throw new ArtifactDecodeError(`${name} is not a regular file`);
  }
}

async function readZipMetadata(
  directory: ZipArchive,
  metadataPath: string,
  layout: BuildMetadataLayout,
): Promise<MetadataOutcome> {
  const entry = directory.byName.get(metadataPath);
  const directoryPrefix = `${metadataPath}/`;
  if (entry === undefined) {
    const shadowed = directory.entries.some((candidate) => candidate.name?.startsWith(directoryPrefix));
    if (shadowed) {
      throw new ArtifactDecodeError(`${metadataPath} is a directory`);
    }
    return { record: null };
  }
  requireRegularZipFile(entry, metadataPath);
  const bytes = await directory.read(entry, STORE_ARTIFACT_LIMITS.buildMetadataBytes);
  return { record: parseBuildMetadata(bytes, layout) };
}

// -------------------------------------------------------------- xcarchive ---

async function readXcarchive(
  archivePath: string,
  layout: BuildMetadataLayout,
): Promise<StoreArtifactMetadata> {
  const archiveReal = await realpath(archivePath);
  const appPath = await selectXcarchiveApplication(archivePath);

  const appReal = await realpath(appPath);
  if (!isWithin(archiveReal, appReal)) {
    throw new ArtifactDecodeError(`${path.relative(archivePath, appPath)} resolves outside the archive`);
  }

  const infoPlist = await readRegularFile(appReal, "Info.plist", STORE_ARTIFACT_LIMITS.infoPlistBytes);
  if (infoPlist === null) {
    throw new ArtifactDecodeError(`${path.relative(archivePath, appPath)}/Info.plist is missing`);
  }
  const binaryVersion = iosVersion(parsePlist(infoPlist), archivePath);

  const metadata = await readRegularFile(appReal, layout.metadataPath, STORE_ARTIFACT_LIMITS.buildMetadataBytes);
  const record = metadata === null ? null : parseBuildMetadata(metadata, layout);
  return result("ios", binaryVersion, record, null);
}

/**
 * `ApplicationProperties.ApplicationPath` from the archive's Info.plist when
 * present — it must name a top-level `Applications/<name>.app` — otherwise
 * the only `.app` directory under `Products/Applications/`.
 */
async function selectXcarchiveApplication(archivePath: string): Promise<string> {
  const productsPath = path.join(archivePath, "Products");
  const archiveInfo = await readRegularFile(archivePath, "Info.plist", STORE_ARTIFACT_LIMITS.infoPlistBytes);
  const properties = archiveInfo === null ? undefined : dictValue(parsePlist(archiveInfo), "ApplicationProperties");
  const declared = dictValue(properties, "ApplicationPath");

  if (declared !== undefined) {
    const segments = typeof declared === "string" ? declared.split("/") : [];
    const name = segments[1] ?? "";
    if (
      segments.length !== 2 ||
      segments[0] !== "Applications" ||
      !name.endsWith(".app") ||
      name === ".app" ||
      name.includes("\\")
    ) {
      throw new ArtifactDecodeError(
        `Info.plist ApplicationProperties.ApplicationPath ${describeValue(declared)} is not a top-level application of the archive`,
      );
    }
    const appPath = path.join(productsPath, "Applications", name);
    const stats = await lstatOrNull(appPath);
    if (stats === null || !stats.isDirectory()) {
      throw new StoreArtifactError(
        "application-not-found",
        archivePath,
        `Info.plist names Products/${declared}, which is not an application directory`,
      );
    }
    return appPath;
  }

  const applicationsPath = path.join(productsPath, "Applications");
  let names: string[];
  try {
    names = await readdir(applicationsPath);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR") {
      throw new StoreArtifactError("application-not-found", archivePath, "no Products/Applications directory");
    }
    throw error;
  }

  const apps: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".app")) continue;
    const stats = await lstat(path.join(applicationsPath, name));
    if (stats.isDirectory()) apps.push(name);
  }
  if (apps.length === 0) {
    throw new StoreArtifactError("application-not-found", archivePath, "no application under Products/Applications/");
  }
  if (apps.length > 1) {
    throw new StoreArtifactError(
      "ambiguous-application",
      archivePath,
      `more than one application under Products/Applications/ (${apps.join(", ")}) and no ApplicationProperties.ApplicationPath in Info.plist`,
    );
  }
  return path.join(applicationsPath, apps[0]);
}

/**
 * The bytes of a regular file at `relativePath` below `root`, or null when
 * nothing is there. A symlink, a directory or another special entry at that
 * path is an error, not absence; so is a path that resolves outside `root`.
 */
async function readRegularFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const filePath = path.join(root, ...relativePath.split("/"));
  const stats = await lstatOrNull(filePath);
  if (stats === null) {
    return null;
  }
  if (!stats.isFile()) {
    throw new ArtifactDecodeError(
      `${relativePath} is ${stats.isSymbolicLink() ? "a symbolic link" : stats.isDirectory() ? "a directory" : "not a regular file"}`,
    );
  }
  const rootReal = await realpath(root);
  if (!isWithin(rootReal, await realpath(filePath))) {
    throw new ArtifactDecodeError(`${relativePath} resolves outside the application`);
  }
  if (stats.size > maxBytes) {
    throw new ArtifactDecodeError(`${relativePath} is ${stats.size} bytes, over the ${maxBytes}-byte limit`);
  }
  return new Uint8Array(await readFile(filePath));
}

async function lstatOrNull(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// ---------------------------------------------------------------- shared ---

function dictValue(value: unknown, key: string): unknown {
  return isPlistDictionary(value) ? value[key] : undefined;
}

function iosVersion(infoPlist: unknown, artifactPath: string): string {
  if (!isPlistDictionary(infoPlist)) {
    throw new ArtifactDecodeError("the application's Info.plist is not a dictionary");
  }
  const version = infoPlist.CFBundleShortVersionString;
  if (version === undefined || version === "") {
    throw new StoreArtifactError(
      "missing-binary-version",
      artifactPath,
      `CFBundleShortVersionString is ${version === undefined ? "missing" : "empty"} in the application's Info.plist`,
    );
  }
  if (typeof version !== "string") {
    throw new StoreArtifactError(
      "unsupported-binary-version",
      artifactPath,
      "CFBundleShortVersionString in the application's Info.plist is not a string",
    );
  }
  return version;
}

function androidVersion(versionName: ManifestVersionName, artifactPath: string): string {
  switch (versionName.kind) {
    case "literal":
      if (versionName.value === "") {
        throw new StoreArtifactError("missing-binary-version", artifactPath, "android:versionName is empty");
      }
      return versionName.value;
    case "missing":
      throw new StoreArtifactError(
        "missing-binary-version",
        artifactPath,
        "android:versionName is missing from the manifest",
      );
    case "reference":
      throw new StoreArtifactError(
        "unsupported-binary-version",
        artifactPath,
        "android:versionName is a resource reference; only a literal version string is supported",
      );
    case "not-a-string":
      throw new StoreArtifactError(
        "unsupported-binary-version",
        artifactPath,
        "android:versionName is not a literal string",
      );
  }
}

function result(
  platform: StoreArtifactPlatform,
  binaryVersion: string,
  record: BuildMetadataV1 | null,
  sha256: string | null,
): StoreArtifactMetadata {
  return {
    binaryVersion,
    embeddedFiles: record?.embeddedFiles ?? null,
    embeddedPackageHash: record?.embeddedPackageHash ?? null,
    fingerprint: record?.fingerprint ?? null,
    fingerprintEngine: record?.engine ?? null,
    metadataPresent: record !== null,
    platform,
    sha256,
  };
}
