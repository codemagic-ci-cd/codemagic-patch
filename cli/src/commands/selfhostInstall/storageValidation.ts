import type { StorageConfig } from "../../storageConfig";

export function httpsUrlProblem(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? null
      : "Use HTTPS without credentials, query or fragment.";
  } catch {
    return "Enter a valid HTTPS URL.";
  }
}

export function runtimeAccessKeyProblem(
  kind: StorageConfig["kind"],
  value: string,
): string | null {
  return kind === "s3" && value.startsWith("ASIA")
    ? "Temporary AWS keys cannot be used as runtime credentials. Use a bucket-scoped IAM user key."
    : null;
}
