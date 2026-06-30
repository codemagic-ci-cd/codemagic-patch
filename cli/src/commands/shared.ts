import { resolve } from "node:path";
import type { WritableStream } from "../output";
import type { PromptFn } from "../prompt";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

type StatLike = {
  isDirectory: () => boolean;
  isFile: () => boolean;
};

type DirectoryEntryLike = {
  isDirectory: () => boolean;
  isFile: () => boolean;
  name: string;
};

export type CommandDeps = {
  computeFingerprint: (input: {
    platform: "android" | "ios";
    projectRoot: string;
  }) => Promise<string>;
  computeFingerprintDetails: (input: {
    platform: "android" | "ios";
    projectRoot: string;
  }) => Promise<{
    fingerprint: string;
    sources: Array<{
      filePath?: string;
      type: string;
    }>;
  }>;
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  now: () => number;
  prompt?: PromptFn;
  readFile: (path: string) => Promise<Buffer>;
  readDirectory: (path: string) => Promise<DirectoryEntryLike[]>;
  randomUUID: () => string;
  runCommand: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: Record<string, string | undefined>;
    },
  ) => Promise<{
    exitCode: number | null;
    signal: string | null;
    stderr: string;
    stdout: string;
  }>;
  sleep: (milliseconds: number) => Promise<void>;
  stderr?: WritableStream;
  stat: (path: string) => Promise<StatLike>;
  stdin?: { isTTY?: boolean };
  streamCommand: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: Record<string, string | undefined>;
      stderr: WritableStream;
      stdout: WritableStream;
    },
  ) => Promise<{
    exitCode: number | null;
    signal: string | null;
  }>;
  stdout?: WritableStream;
};

export function buildApiUrl(serverUrl: string, pathname: string): string {
  const base = assertHttpUrl(serverUrl);
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(pathname.replace(/^\//, ""), normalized);

  return url.toString();
}

/**
 * Validates a server URL and returns it trimmed. Used both at input time
 * (config set / init / login, to reject before a bad value is stored) and as
 * the last-line defense inside buildApiUrl / buildApiUrlWithQuery, so EVERY path
 * that reaches the API — the `--server-url` flag on any command, the
 * `CODEMAGIC_PATCH_SERVER_URL` env var, a stale stored config — fails with this
 * clear message instead of a bare `Invalid URL` thrown deep inside a request.
 */
export function assertHttpUrl(value: string, label = "Server URL"): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ValidationError(
      `${label} must start with http:// or https:// (got "${value}").`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(
      `${label} must start with http:// or https:// (got "${value}").`,
    );
  }

  return trimmed;
}

// Matches a non-ASCII or non-printable character, which cannot be placed in an
// HTTP header value. A stray one usually means the token was copied incorrectly
// (e.g. a homoglyph picked up from a chat or PDF), which otherwise surfaces as a
// cryptic "Cannot convert argument to a ByteString" error from fetch.
const NON_HEADER_SAFE_CHARACTER = /[^\x21-\x7e]/;

export function normalizeBearerToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("The access token is empty.");
  }

  if (NON_HEADER_SAFE_CHARACTER.test(trimmed)) {
    throw new ValidationError(
      "The access token contains invalid characters. It looks like it was copied incorrectly — please paste it again.",
    );
  }

  return trimmed;
}

export function buildApiUrlWithQuery(
  serverUrl: string,
  pathname: string,
  query: Record<string, number | string | undefined>,
): string {
  const base = assertHttpUrl(serverUrl);
  const normalized = base.endsWith("/") ? base : `${base}/`;
  const url = new URL(pathname.replace(/^\//, ""), normalized);
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();
  if (queryString.length > 0) {
    url.search = queryString;
  }

  return url.toString();
}

export async function ensureReadableFile(
  deps: CommandDeps,
  inputPath: string,
  label: string,
): Promise<string> {
  const resolvedPath = resolve(inputPath);
  let stats: StatLike;

  try {
    stats = await deps.stat(resolvedPath);
  } catch (error) {
    throw new UsageError(
      `${label} file was not found: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }

  if (!stats.isFile()) {
    throw new UsageError(`${label} path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

export async function ensureReadableDirectory(
  deps: CommandDeps,
  inputPath: string,
  label: string,
): Promise<string> {
  const resolvedPath = resolve(inputPath);
  let stats: StatLike;

  try {
    stats = await deps.stat(resolvedPath);
  } catch (error) {
    throw new UsageError(
      `${label} directory was not found: ${resolvedPath}${formatErrorSuffix(error)}`,
    );
  }

  if (!stats.isDirectory()) {
    throw new UsageError(`${label} path is not a directory: ${resolvedPath}`);
  }

  return resolvedPath;
}

function formatErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return ` (${error.message})`;
}
