// The ustar split rule lives in @codemagic/patch-shared so the publish-time
// check and the server writer cannot drift (PROTOCOL.md › Full Bundle Archive
// Format). Paths that need a GNU long-name record are rejected by device SDKs
// older than 0.1.4, so publishers get a warning up front; paths no device can
// extract at all are a hard error before upload.

import {
  findUnsupportedArchivePaths,
  requiresLongNameEncoding,
} from "@codemagic/patch-shared";

export { requiresLongNameEncoding };

export const TAR_LONGNAME_MIN_SDK_VERSION = "0.1.4";

export function findLongNamePaths(archivePaths: string[]): string[] {
  return archivePaths.filter(requiresLongNameEncoding);
}

export function formatLongNameWarning(longNamePaths: string[]): string {
  return (
    `Warning: ${longNamePaths.length} file path(s) exceed the tar 100-byte name limit ` +
    `(e.g. ${longNamePaths[0]}); devices need SDK ${TAR_LONGNAME_MIN_SDK_VERSION} or newer ` +
    "to install this release."
  );
}

export { findUnsupportedArchivePaths };

export function formatUnsupportedPathsError(
  unsupported: Array<{ path: string; reason: string }>,
): string {
  const [first] = unsupported;

  return (
    `bundle contains ${unsupported.length} file path(s) no device can install: ` +
    `${first?.path} (${first?.reason}). Shorten the offending path(s) and rebuild.`
  );
}
