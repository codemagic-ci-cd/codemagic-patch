// Canonical ustar path rules for the bundle archive wire format
// (PROTOCOL.md › Full Bundle Archive Format). The server writer implements the
// same rules against Buffer; cli/test/tar-path-contract.test.ts asserts the two
// stay in agreement.

export const TAR_NAME_FIELD_BYTES = 100;
export const TAR_PREFIX_FIELD_BYTES = 155;

/** Wire cap on the path carried by a GNU long-name record. */
export const MAX_ARCHIVE_PATH_BYTES = 4096;

/** Filesystem NAME_MAX on Android ext4/f2fs and iOS APFS. */
export const MAX_ARCHIVE_PATH_SEGMENT_BYTES = 255;

/** The client's post-install validator builds relative paths in a char[1024]. */
export const MAX_DEVICE_ARCHIVE_PATH_BYTES = 1023;

const utf8Encoder = new TextEncoder();

export function archivePathByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

/**
 * Split a path into the ustar `name`/`prefix` fields, or null when no split
 * fits both — the condition that makes the writer emit a GNU long-name record.
 */
export function splitTarPath(
  archivePath: string,
): { name: string; prefix: string } | null {
  if (archivePathByteLength(archivePath) <= TAR_NAME_FIELD_BYTES) {
    return { name: archivePath, prefix: "" };
  }

  const segments = archivePath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");

    if (
      archivePathByteLength(prefix) <= TAR_PREFIX_FIELD_BYTES &&
      archivePathByteLength(name) <= TAR_NAME_FIELD_BYTES
    ) {
      return { name, prefix };
    }
  }

  return null;
}

export function requiresLongNameEncoding(archivePath: string): boolean {
  return splitTarPath(archivePath) === null;
}

/**
 * Describe why no device can install a payload containing this path, or null
 * when the path is representable everywhere. A path can be encodable on the
 * wire yet unusable on device: a segment past NAME_MAX fails `mkdir`/`fopen`
 * with ENAMETOOLONG, and a path past the validator's buffer fails the
 * post-install contents check.
 */
export function describeUnsupportedArchivePath(archivePath: string): string | null {
  const pathBytes = archivePathByteLength(archivePath);

  if (pathBytes > MAX_ARCHIVE_PATH_BYTES) {
    return `path is ${pathBytes} bytes, over the ${MAX_ARCHIVE_PATH_BYTES}-byte archive limit`;
  }

  if (pathBytes > MAX_DEVICE_ARCHIVE_PATH_BYTES) {
    return `path is ${pathBytes} bytes, over the ${MAX_DEVICE_ARCHIVE_PATH_BYTES}-byte limit devices can extract`;
  }

  for (const segment of archivePath.split("/")) {
    const segmentBytes = archivePathByteLength(segment);
    if (segmentBytes > MAX_ARCHIVE_PATH_SEGMENT_BYTES) {
      return `path segment "${segment.slice(0, 40)}…" is ${segmentBytes} bytes, over the ${MAX_ARCHIVE_PATH_SEGMENT_BYTES}-byte filesystem limit`;
    }
  }

  return null;
}

export function findUnsupportedArchivePaths(
  archivePaths: string[],
): Array<{ path: string; reason: string }> {
  const unsupported: Array<{ path: string; reason: string }> = [];

  for (const archivePath of archivePaths) {
    const reason = describeUnsupportedArchivePath(archivePath);
    if (reason !== null) {
      unsupported.push({ path: archivePath, reason });
    }
  }

  return unsupported;
}

/**
 * Mirror of the server's ZIP-ingest normalization (server/src/worker/bundleTree.ts
 * `normalizeArchivePath`) so publish-time checks run on the same paths the
 * writer will see. Returns null for entries the server drops from the payload
 * tree, and for paths it rejects outright — those surface server-side.
 */
export function normalizeArchiveEntryPath(entryPath: string): string | null {
  const posixPath = entryPath.replace(/\\/g, "/");

  if (posixPath.endsWith("/") || posixPath.startsWith("/")) {
    return null;
  }

  const normalized = normalizePosixPath(posixPath);
  if (
    normalized === "." ||
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }

  if (normalized === "__MACOSX" || normalized.startsWith("__MACOSX/")) {
    return null;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".DS_Store")) {
    return null;
  }

  return normalized;
}

// path.posix.normalize equivalent, minus the node:path dependency: shared also
// ships to the browser bundle.
function normalizePosixPath(posixPath: string): string {
  const resolved: string[] = [];

  for (const segment of posixPath.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      const last = resolved[resolved.length - 1];
      if (last === undefined || last === "..") {
        resolved.push("..");
      } else {
        resolved.pop();
      }
      continue;
    }

    resolved.push(segment);
  }

  return resolved.join("/");
}
