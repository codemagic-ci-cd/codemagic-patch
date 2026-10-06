// Copied from cli/src/version.ts (@codemagic/patch-cli 0.4.0); only the comment about
// the dist layout differs. See cli-capacitor-tech-spec › Provenance.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getCliVersion(): string {
  // Resolves from both src/ (tsx, vitest) and dist/ (the esbuild bundle) layouts:
  // each sits exactly one level below the package root.
  const packageJsonPath = join(__dirname, "..", "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return parsed.version;
}
