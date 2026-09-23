/**
 * Dotted numeric versions ("15.6" vs "14.0.0"); a missing segment is 0. A
 * prerelease suffix ("0.5.0-beta.1") sorts below the release it precedes;
 * two prereleases of the same release compare as plain strings.
 */
export function compareVersions(left: string, right: string): number {
  const [a, aPre] = splitVersion(left);
  const [b, bPre] = splitVersion(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}

function splitVersion(value: string): [number[], string | undefined] {
  const [core = "", prerelease] = value.trim().replace(/^v/, "").split("-", 2);
  return [
    core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    prerelease,
  ];
}
