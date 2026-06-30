import { HttpProblemError, isProblemDetailsContentType } from "./problem-details";

type FetchLike = typeof globalThis.fetch;
type RequestInitLike = Parameters<FetchLike>[1];

/**
 * Retry policy for idempotent requests (cli-tech-spec §Retry and Idempotency).
 *
 * Retries only apply to requests that carry an `Idempotency-Key` header, so each
 * attempt reuses the same key and the server replays the stored response instead
 * of re-executing the mutation.
 */
export interface RequestRetryOptions {
  /** Sleep between attempts; injected so tests can run without real delays. */
  sleep: (milliseconds: number) => Promise<void>;
  /** Total attempts, including the first. Defaults to 4. */
  maxAttempts?: number;
  /** Base backoff for transient failures (ms), doubled per attempt. Defaults to 250. */
  baseDelayMs?: number;
  /** Upper bound on any single wait (ms). Defaults to 30000. */
  maxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * A transport-level failure where no HTTP response was received — DNS failure,
 * connection refused, TLS error, or timeout. Node's global fetch surfaces these
 * as `TypeError: fetch failed` with the real reason hidden on `.cause`, which
 * leaves the user staring at a bare "fetch failed". This unwraps that into a
 * message that names the server and says what to check.
 */
export class RequestNetworkError extends Error {
  readonly url: string;
  readonly code: string | undefined;

  constructor(url: string, cause: unknown) {
    const code = extractCauseCode(cause);
    super(describeNetworkFailure(url, code));
    this.name = "RequestNetworkError";
    this.url = url;
    this.code = code;
    this.cause = cause;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function extractCauseCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const directCode = (cause as { code?: unknown } | null)?.code;
  if (typeof directCode === "string") {
    return directCode;
  }

  // Multiple address attempts (e.g. IPv6 + IPv4) surface as an AggregateError
  // whose `errors` carry the per-attempt codes.
  const errors = (cause as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const innerCode = (inner as { code?: unknown } | null)?.code;
      if (typeof innerCode === "string") {
        return innerCode;
      }
    }
  }

  return undefined;
}

function describeNetworkFailure(url: string, code: string | undefined): string {
  const origin = originOf(url);
  const suffix = code === undefined ? "" : ` (${code})`;
  switch (code) {
    case "ECONNREFUSED":
      return `Could not connect to the server at ${origin} (connection refused). Is the server running, and are the URL and port correct?`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not resolve the server host for ${origin} (DNS lookup failed). Check the --server-url value.`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return `Timed out connecting to the server at ${origin}. Check the URL and that the server is reachable.`;
    case "ECONNRESET":
      return `The connection to the server at ${origin} was reset. Retry, and check the server logs if it persists.`;
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_HAS_EXPIRED":
      return `Could not establish a secure (TLS) connection to ${origin}${suffix}. Check the server's certificate, or use http:// for a local server.`;
    default:
      return `Could not reach the server at ${origin}${suffix}. Check the --server-url and that the server is running.`;
  }
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") {
    return false;
  }
  return extractCauseCode(error) !== undefined || /fetch failed/i.test(error.message);
}

export async function request(
  fetchImpl: FetchLike,
  input: string,
  init?: RequestInitLike,
  retry?: RequestRetryOptions,
): Promise<unknown> {
  const retryable = retry !== undefined && hasIdempotencyKey(init);
  const maxAttempts = retryable
    ? Math.max(1, retry.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    : 1;

  for (let attempt = 1; ; attempt++) {
    const canRetry = retryable && attempt < maxAttempts;

    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      // Transient network failure (timeout, TCP reset): retry the same request
      // (same idempotency key) with exponential backoff.
      if (canRetry) {
        await retry.sleep(backoffDelayMs(attempt, retry));
        continue;
      }
      throw isLikelyNetworkError(error)
        ? new RequestNetworkError(input, error)
        : error;
    }

    const contentType = response.headers.get("content-type");

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();

    // Original request still in progress: 409 Conflict + Retry-After → wait the
    // server-specified interval and retry.
    if (response.status === 409 && canRetry) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (retryAfterMs !== null) {
        await retry.sleep(
          Math.min(retryAfterMs, retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS),
        );
        continue;
      }
    }

    if (!response.ok) {
      // Transient server failure with no body (5xx): retry with backoff.
      if (canRetry && response.status >= 500 && text.length === 0) {
        await retry.sleep(backoffDelayMs(attempt, retry));
        continue;
      }

      if (isProblemDetailsContentType(contentType)) {
        const body = parseJsonOrThrow(text, "Invalid problem details response");
        throw new HttpProblemError(body as Record<string, unknown>, response.status);
      }

      throw new Error(
        `Request failed with HTTP ${response.status}${text.length > 0 ? `: ${text}` : ""}`,
      );
    }

    if (text.length === 0) {
      return null;
    }

    if (contentType?.toLowerCase().includes("application/json")) {
      return parseJsonOrThrow(text, "Invalid JSON response");
    }

    return text;
  }
}

function hasIdempotencyKey(init: RequestInitLike): boolean {
  const headers = init?.headers;
  if (!headers) {
    return false;
  }

  if (headers instanceof Headers) {
    return headers.has("idempotency-key");
  }

  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === "idempotency-key");
  }

  return Object.keys(headers).some(
    (key) => key.toLowerCase() === "idempotency-key",
  );
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null;
  }

  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // delta-seconds form (e.g. "1")
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function backoffDelayMs(attempt: number, options: RequestRetryOptions): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  return Math.min(max, base * 2 ** (attempt - 1));
}

function parseJsonOrThrow(text: string, message: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
