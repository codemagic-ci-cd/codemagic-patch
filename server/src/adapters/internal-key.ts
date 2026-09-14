/** Shared bucket boundary for private uploads and release-worker artifacts. */
export function isInternalKey(keyOrPrefix: string): boolean {
  return keyOrPrefix === "_internal" || keyOrPrefix.startsWith("_internal/");
}
