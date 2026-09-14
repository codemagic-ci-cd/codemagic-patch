// Keeps `document.documentElement.dataset.theme` in sync with the stored
// preference and live `prefers-color-scheme` after the index.html blocking
// script has already painted the first frame. Mount once at the app root.

import { useEffect, useSyncExternalStore } from "react";

import {
  applyResolvedTheme,
  getSystemDark,
  readThemePreference,
  resolveTheme,
  subscribeSystemDark,
  subscribeThemePreference,
} from "./preference";

export function ThemeSync() {
  const preference = useSyncExternalStore(
    subscribeThemePreference,
    readThemePreference,
    () => "system" as const,
  );
  const systemDark = useSyncExternalStore(
    subscribeSystemDark,
    getSystemDark,
    () => false,
  );

  useEffect(() => {
    applyResolvedTheme(resolveTheme(preference, systemDark));
  }, [preference, systemDark]);

  return null;
}
