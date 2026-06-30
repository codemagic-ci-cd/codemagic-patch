import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getCliVersion(): string {
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
