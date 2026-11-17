import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getServerVersion(): string {
  // Resolves from both src/ (tsx, vitest) and dist/ (tsc output) layouts.
  const packageJsonPath = join(__dirname, "..", "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return parsed.version;
}

/** Null when the version cannot be read: it only decorates messages. */
export function readServerVersion(): string | null {
  try {
    return getServerVersion();
  } catch {
    return null;
  }
}

export function serverLabel(version: string | null): string {
  return version ? `this server (v${version})` : "this server";
}
