// Appearance preference (light / dark / system). Resolved to a concrete
// `data-theme` on <html> so CSS token overrides apply. Storage is the same
// best-effort localStorage wrap as lastTeam / sidebar collapse: blocked
// storage degrades to System instead of throwing. The inline script in
// index.html must keep this key and the parse rules in lockstep so the
// first paint matches the React sync.

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "codemagic-patch.dashboard.theme";

const PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

const listeners = new Set<() => void>();

/** Unknown / missing values fall back to System (the product default). */
export function parseThemePreference(value: string | null): ThemePreference {
  if (value !== null && PREFERENCES.includes(value as ThemePreference)) {
    return value as ThemePreference;
  }
  return "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemDark ? "dark" : "light";
  }
  return preference;
}

export function applyResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable — the choice lives for this page load only.
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeThemePreference(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function subscribeSystemDark(onStoreChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onStoreChange);
  return () => {
    media.removeEventListener("change", onStoreChange);
  };
}

export function getSystemDark(): boolean {
  if (typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
