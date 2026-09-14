/** Tile initials: "harbor-android" → "ha", single words → first two. */
export function initialsFor(appName: string): string {
  const segments = appName
    .split(/[^\p{L}\p{N}]+/u)
    .filter((segment) => segment.length > 0);
  const first = segments[0] ?? appName;
  const second = segments[1];
  const initials =
    second !== undefined
      ? `${first.charAt(0)}${second.charAt(0)}`
      : first.slice(0, 2);
  return initials === "" ? "?" : initials.toLowerCase();
}
