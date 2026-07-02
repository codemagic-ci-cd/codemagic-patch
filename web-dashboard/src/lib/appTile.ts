const APP_ICON_GRADIENTS = [
  "linear-gradient(135deg,#0051ff,#008bf7)",
  "linear-gradient(135deg,#00ceff,#008bf7)",
  "linear-gradient(135deg,#fe19ff,#b517d6)",
  "linear-gradient(135deg,#ff9100,#ff4d13)",
  "linear-gradient(135deg,#0031ea,#0051ff)",
  "linear-gradient(135deg,#008bf7,#00ceff)",
  "linear-gradient(135deg,#10b981,#059669)",
  "linear-gradient(135deg,#ff4d13,#ec0c43)",
] as const;

/** Stable gradient pick so an app keeps its tile color across refetches. */
export function gradientFor(appId: string): string {
  let hash = 0;
  for (let index = 0; index < appId.length; index += 1) {
    hash = (hash * 31 + appId.charCodeAt(index)) >>> 0;
  }
  return APP_ICON_GRADIENTS[hash % APP_ICON_GRADIENTS.length];
}

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
