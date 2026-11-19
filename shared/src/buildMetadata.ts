// Build metadata (`CodemagicPatchBuild.json`) parser — specs/build-metadata.md
// §3 (schema) and §4.3/§4.4 (path validation). The store-artifact reader and
// every consumer in the CLI or the server use it. The SDK writer carries no
// copy: its tests run what it writes through this parser and write the valid
// records of shared/test-vectors/build-metadata/ byte for byte.

import { describeValue } from "./describeValue";
import { MAX_ARCHIVE_PATH_SEGMENT_BYTES } from "./tarPath";

export const BUILD_METADATA_FILE_NAME = "CodemagicPatchBuild.json";
export const BUILD_METADATA_SCHEMA_VERSION = 1;

/**
 * Producer path limits from PROTOCOL.md › Full Bundle Archive Format ›
 * Producer path limits: a relative path is capped at 512 bytes and a segment
 * at 255 bytes (NAME_MAX). Not the 1023-byte device extraction limit in
 * tarPath.ts, which is a different, looser contract.
 */
export const BUILD_METADATA_MAX_PATH_BYTES = 512;
export const BUILD_METADATA_MAX_PATH_SEGMENT_BYTES = MAX_ARCHIVE_PATH_SEGMENT_BYTES;

export type BuildMetadataV1 = {
  schemaVersion: 1;
  fingerprint: string | null;
  engine: string | null;
  embeddedPackageHash: string | null;
  embeddedFiles: string[] | null;
};

/**
 * Where the metadata file lives inside the selected application (iOS: the
 * `.app` directory; Android: the APK root or the AAB base module) and what
 * its `embeddedFiles` may list. An integration's fixed definition, never read
 * from the metadata file and never discovered by searching.
 */
export type BuildMetadataLayout = {
  /** Metadata file, relative to the application root. */
  metadataPath: string;
  /**
   * What `embeddedFiles` may list, relative to the payload root (§4.2): an
   * entry ending in "/" admits every path below it, any other entry admits
   * exactly that path.
   */
  includedPaths: readonly string[];
  /** Paths a non-null `embeddedFiles` must contain (the RN bundle file). */
  requiredPaths: readonly string[];
};

/** The fixed React Native layout (specs/build-metadata.md §2, §4.2). */
export const REACT_NATIVE_BUILD_METADATA_LAYOUTS: Readonly<
  Record<"android" | "ios", BuildMetadataLayout>
> = {
  android: {
    includedPaths: ["index.android.bundle"],
    metadataPath: `assets/${BUILD_METADATA_FILE_NAME}`,
    requiredPaths: ["index.android.bundle"],
  },
  ios: {
    includedPaths: ["main.jsbundle", "assets/"],
    metadataPath: BUILD_METADATA_FILE_NAME,
    requiredPaths: ["main.jsbundle"],
  },
};

/** Which rule a malformed file broke (specs/build-metadata.md §3.3). */
export type BuildMetadataRule =
  | "byte-order-mark"
  | "invalid-utf8"
  | "invalid-json"
  | "not-an-object"
  | "duplicate-member"
  | "missing-field"
  | "unsupported-schema-version"
  | "invalid-fingerprint"
  | "invalid-engine"
  | "invalid-embedded-package-hash"
  | "invalid-embedded-files"
  | "mixed-fingerprint-pair"
  | "mixed-embedded-pair"
  | "ill-formed-unicode"
  | "unsafe-path"
  | "path-too-long"
  | "ignored-path"
  | "path-outside-layout"
  | "duplicate-path"
  | "unsorted-paths"
  | "missing-required-path";

export class BuildMetadataError extends Error {
  readonly rule: BuildMetadataRule;

  constructor(rule: BuildMetadataRule, message: string) {
    super(message);
    this.name = "BuildMetadataError";
    this.rule = rule;
  }
}

const DEFINED_MEMBERS = [
  "schemaVersion",
  "fingerprint",
  "engine",
  "embeddedPackageHash",
  "embeddedFiles",
] as const;

const LOWER_HEX = /^[0-9a-f]+$/;
const PACKAGE_HASH = /^[0-9a-f]{64}$/;
const utf8Encoder = new TextEncoder();
/** Room for any path within the producer limit, so a legal path is shown whole. */
const PATH_DIAGNOSTIC_LENGTH = 600;

/**
 * Parse `CodemagicPatchBuild.json` bytes against a layout. Returns the record
 * when it is valid under §3 and §4.3; throws BuildMetadataError naming the
 * broken rule otherwise. Each pair may be null independently (§3.2).
 */
export function parseBuildMetadata(
  bytes: Uint8Array,
  layout: BuildMetadataLayout,
): BuildMetadataV1 {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new BuildMetadataError("byte-order-mark", "the file starts with a UTF-8 byte-order mark");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BuildMetadataError("invalid-utf8", "the file is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BuildMetadataError("invalid-json", "the file is not valid JSON");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuildMetadataError("not-an-object", "the JSON value is not an object");
  }

  // JSON.parse keeps the last of repeated names, so the repeat check has to
  // read the member list from the text itself (§3.4 rule 4).
  const seen = new Set<string>();
  for (const name of topLevelMemberNames(text)) {
    if ((DEFINED_MEMBERS as readonly string[]).includes(name)) {
      if (seen.has(name)) {
        throw new BuildMetadataError("duplicate-member", `"${name}" occurs more than once`);
      }
      seen.add(name);
    }
  }

  const record = value as Record<string, unknown>;
  for (const name of DEFINED_MEMBERS) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      throw new BuildMetadataError("missing-field", `required field "${name}" is missing`);
    }
  }

  if (record.schemaVersion !== BUILD_METADATA_SCHEMA_VERSION) {
    throw new BuildMetadataError(
      "unsupported-schema-version",
      `schemaVersion must be the number 1, got ${describeValue(record.schemaVersion)}`,
    );
  }

  const fingerprint = record.fingerprint;
  if (fingerprint !== null && (typeof fingerprint !== "string" || !LOWER_HEX.test(fingerprint))) {
    throw new BuildMetadataError(
      "invalid-fingerprint",
      `fingerprint must be null or a non-empty lowercase hexadecimal string, got ${describeValue(fingerprint)}`,
    );
  }

  const engine = record.engine;
  if (engine !== null) {
    if (typeof engine !== "string" || engine.length === 0) {
      throw new BuildMetadataError(
        "invalid-engine",
        `engine must be null or a non-empty string, got ${describeValue(engine)}`,
      );
    }
    if (!isWellFormedUnicode(engine)) {
      throw new BuildMetadataError("ill-formed-unicode", "engine contains an unpaired surrogate");
    }
  }

  const embeddedPackageHash = record.embeddedPackageHash;
  if (
    embeddedPackageHash !== null &&
    (typeof embeddedPackageHash !== "string" || !PACKAGE_HASH.test(embeddedPackageHash))
  ) {
    throw new BuildMetadataError(
      "invalid-embedded-package-hash",
      `embeddedPackageHash must be null or 64 lowercase hexadecimal characters, got ${describeValue(embeddedPackageHash)}`,
    );
  }

  const embeddedFiles =
    record.embeddedFiles === null ? null : validateEmbeddedFiles(record.embeddedFiles, layout);

  if ((fingerprint === null) !== (engine === null)) {
    throw new BuildMetadataError(
      "mixed-fingerprint-pair",
      "fingerprint and engine must both be strings or both be null",
    );
  }

  if ((embeddedPackageHash === null) !== (embeddedFiles === null)) {
    throw new BuildMetadataError(
      "mixed-embedded-pair",
      "embeddedPackageHash and embeddedFiles must both be set or both be null",
    );
  }

  return {
    embeddedFiles,
    embeddedPackageHash: embeddedPackageHash as string | null,
    engine: engine as string | null,
    fingerprint: fingerprint as string | null,
    schemaVersion: BUILD_METADATA_SCHEMA_VERSION,
  };
}

function validateEmbeddedFiles(value: unknown, layout: BuildMetadataLayout): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BuildMetadataError(
      "invalid-embedded-files",
      `embeddedFiles must be null or a non-empty array, got ${describeValue(value)}`,
    );
  }

  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new BuildMetadataError(
        "invalid-embedded-files",
        `embeddedFiles[${index}] is not a string`,
      );
    }
    // Before any comparison, sort or length check (§3.4 rule 5).
    if (!isWellFormedUnicode(entry)) {
      throw new BuildMetadataError(
        "ill-formed-unicode",
        `embeddedFiles[${index}] contains an unpaired surrogate`,
      );
    }
    paths.push(entry);
  }

  const encoded: Uint8Array[] = [];
  for (const path of paths) {
    const reason = describeUnsafePath(path);
    if (reason !== null) {
      throw new BuildMetadataError("unsafe-path", `embeddedFiles path ${describeValue(path, PATH_DIAGNOSTIC_LENGTH)} ${reason}`);
    }

    const bytes = utf8Encoder.encode(path);
    if (bytes.length > BUILD_METADATA_MAX_PATH_BYTES) {
      throw new BuildMetadataError(
        "path-too-long",
        `embeddedFiles path ${describeValue(path, PATH_DIAGNOSTIC_LENGTH)} is ${bytes.length} bytes, over the ${BUILD_METADATA_MAX_PATH_BYTES}-byte producer limit`,
      );
    }
    for (const segment of path.split("/")) {
      const segmentBytes = utf8Encoder.encode(segment).length;
      if (segmentBytes > BUILD_METADATA_MAX_PATH_SEGMENT_BYTES) {
        throw new BuildMetadataError(
          "path-too-long",
          `embeddedFiles path ${describeValue(path, PATH_DIAGNOSTIC_LENGTH)} has a ${segmentBytes}-byte segment, over the ${BUILD_METADATA_MAX_PATH_SEGMENT_BYTES}-byte producer limit`,
        );
      }
    }

    if (isIgnoredByPackageHash(path)) {
      throw new BuildMetadataError(
        "ignored-path",
        `embeddedFiles path ${describeValue(path, PATH_DIAGNOSTIC_LENGTH)} is excluded from package_hash_v1`,
      );
    }

    if (!isInsideLayout(path, layout)) {
      throw new BuildMetadataError(
        "path-outside-layout",
        `embeddedFiles path ${describeValue(path, PATH_DIAGNOSTIC_LENGTH)} is outside the embedded tree`,
      );
    }

    encoded.push(bytes);
  }

  // Exact strings (§4.4): equal scalar sequences are equal UTF-8 bytes, so a
  // byte comparison covers both the duplicate and the order check.
  const distinct = new Set<string>();
  for (const path of paths) {
    if (distinct.has(path)) {
      throw new BuildMetadataError(
        "duplicate-path",
        `embeddedFiles lists ${describeValue(path, PATH_DIAGNOSTIC_LENGTH)} more than once`,
      );
    }
    distinct.add(path);
  }

  for (let index = 1; index < encoded.length; index += 1) {
    if (compareBytes(encoded[index - 1], encoded[index]) >= 0) {
      throw new BuildMetadataError(
        "unsorted-paths",
        `embeddedFiles is not sorted by UTF-8 bytes at ${describeValue(paths[index], PATH_DIAGNOSTIC_LENGTH)}`,
      );
    }
  }

  for (const required of layout.requiredPaths) {
    if (!distinct.has(required)) {
      throw new BuildMetadataError(
        "missing-required-path",
        `embeddedFiles does not list ${describeValue(required, PATH_DIAGNOSTIC_LENGTH)}`,
      );
    }
  }

  return paths;
}

function describeUnsafePath(path: string): string | null {
  if (path.startsWith("/")) {
    return "is absolute";
  }
  if (path.includes("\\")) {
    return "contains a backslash";
  }
  if (path.includes("\u0000")) {
    return "contains U+0000";
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      return "has an empty, \".\" or \"..\" segment";
    }
  }
  return null;
}

/** package_hash_v1 ignore rules (server/specs/codemagic_patch_package_hash.md). */
function isIgnoredByPackageHash(path: string): boolean {
  const segments = path.split("/");
  return segments[0] === "__MACOSX" || segments.includes(".DS_Store");
}

function isInsideLayout(path: string, layout: BuildMetadataLayout): boolean {
  return layout.includedPaths.some((included) =>
    included.endsWith("/") ? path.startsWith(included) : path === included,
  );
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Decoded names of the top-level members of a JSON object, in document order,
 * repeats included. Only called on text JSON.parse has accepted, so it can
 * scan without re-validating; it is iterative so deep nesting in an unknown
 * member cannot exhaust the stack.
 */
function topLevelMemberNames(text: string): string[] {
  const names: string[] = [];
  let index = skipWhitespace(text, 0);
  if (text[index] !== "{") {
    return names;
  }
  index = skipWhitespace(text, index + 1);
  if (text[index] === "}") {
    return names;
  }

  for (;;) {
    index = skipWhitespace(text, index);
    const end = skipString(text, index);
    names.push(JSON.parse(text.slice(index, end)) as string);
    index = skipWhitespace(text, end);
    index = skipWhitespace(text, index + 1); // past ":"
    index = skipValue(text, index);
    index = skipWhitespace(text, index);
    if (text[index] !== ",") {
      return names;
    }
    index += 1;
  }
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
      break;
    }
    index += 1;
  }
  return index;
}

/** Index just past the string literal that starts at `start`. */
function skipString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') {
      return index + 1;
    }
    index += 1;
  }
  return index;
}

function skipValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    return skipString(text, start);
  }
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < text.length && !",}] \t\n\r".includes(text[index])) {
      index += 1;
    }
    return index;
  }

  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = skipString(text, index);
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return index;
}
