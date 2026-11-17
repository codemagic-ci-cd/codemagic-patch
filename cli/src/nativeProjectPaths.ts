import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Preserve the directory entry's spelling even on case-insensitive filesystems. */
export async function findIosRoot(root: string): Promise<string> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of ["ios", "iOS"]) {
    const candidate = path.join(root, name);
    if (names.includes(name) && await stat(candidate).then((entry) => entry.isDirectory(), () => false)) return candidate;
  }
  return path.join(root, "ios");
}

/** How an app's iOS project gets its dependencies. */
export type IosDependencyManager = "swiftpm" | "cocoapods";

/**
 * Marker file `npx react-native spm add` writes into the converted app's
 * `.xcodeproj` (React Native's SwiftPM mode). Users commit it, so a
 * local checkout and a CI clone agree on the mode.
 */
export const SWIFTPM_MODE_MARKER = ".spm-injected.json";

/**
 * `"swiftpm"` when any `<iosRoot>/*.xcodeproj` holds React Native's SwiftPM-mode
 * marker (the same rule as React Native's own findInjectedXcodeproj), otherwise
 * `"cocoapods"`; `undefined` when the project has no `ios`/`iOS` directory. Only
 * the marker's existence counts: its contents differ between React Native
 * versions. Unreadable directories count as no marker.
 */
export async function detectIosDependencyManager(projectRoot: string): Promise<IosDependencyManager | undefined> {
  const iosRoot = await findIosRoot(projectRoot);
  const entries = await readdir(iosRoot).catch(() => undefined);
  if (entries === undefined) return undefined;
  for (const entry of entries) {
    if (!entry.endsWith(".xcodeproj")) continue;
    if (await stat(path.join(iosRoot, entry, SWIFTPM_MODE_MARKER)).then(() => true, () => false)) return "swiftpm";
  }
  return "cocoapods";
}
