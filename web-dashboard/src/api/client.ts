// The single transport layer for every /v1 call (API base, auth, transport,
// and the cross-cutting idempotency pattern). Control flow
// ported from cli/src/authenticatedRequest.ts + cli/src/http.ts — their
// node-bound glue (fs credential store, CommandDeps) is reimplemented for the
// browser:
//   - JSON in/out with problem-aware errors: every non-ok response throws
//     HttpProblemError (synthesized from the status when the body is not
//     application/problem+json);
//   - refresh-once on 401 `authentication-required` with token rotation, plus
//     the SPA-only additions: proactive near-expiry refresh and a
//     single-flight refresh promise — rotation invalidates the previous
//     refresh token, so parallel rotations would log the user out;
//   - Idempotency-Key support: the key is caller-owned (one per submission,
//     reusable across that submission's retries); 409 idempotency-in-progress
//     gets exactly one delayed retry with the same key honoring Retry-After;
//     422 idempotency-mismatch is never retried.
// `fetch` is read from globalThis at call time so vitest can stub it.
// Framework-free: no React imports — api/hooks bind this layer to
// TanStack Query and never touch fetch.

import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  updateTokens,
} from "../auth/credentialStore";
import { HttpProblemError, parseProblemResponse } from "./problem";
import {
  fromRefreshWire,
  toOAuthRefreshWireBody,
  type RefreshWireResponse,
} from "./wire";
import type { OAuthRefreshBody, ProblemDetails } from "./types";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One API call. `path` is origin-relative; the `/v1` prefix is implied. */
export interface ApiClientSpec {
  method: HttpMethod;
  /** `"/teams"` and `"/v1/teams"` are equivalent (see `apiUrl`). */
  path: string;
  /** JSON-serialized when present (sets `content-type: application/json`). */
  body?: unknown;
  /**
   * Raw multipart body, sent as-is with NO `content-type` header so the browser
   * sets the boundary (see `authenticatedMultipartRequest`). Takes precedence
   * over `body`; the two are mutually exclusive in practice.
   */
  multipartBody?: FormData;
  /**
   * Caller-owned key (see `createIdempotencyKey`): generate one per
   * create/promote/rollback/transfer submission and reuse it across retries
   * of that submission. Sent as the `Idempotency-Key` header.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Access tokens expiring within this window are proactively refreshed (near-expiry). */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 30_000;
/** Delay before the single idempotency retry when `Retry-After` is missing/invalid. */
export const IDEMPOTENCY_RETRY_DEFAULT_MS = 2_000;
/** Upper bound applied to the server-provided `Retry-After`. */
export const IDEMPOTENCY_RETRY_MAX_MS = 10_000;

/**
 * Transport enrichment: the `Retry-After` response header (seconds, as sent)
 * is copied onto `HttpProblemError.extensions` under this key, because the
 * problem body itself does not carry it (verified: routeIdempotency.ts emits
 * it as a header only). Also populated for any other status that sends the
 * header (e.g. a future 429).
 */
export const RETRY_AFTER_EXTENSION = "retryAfter";

/**
 * Resolves a request path against `VITE_API_BASE_URL` (default: empty string,
 * i.e. origin-relative — the same-origin production deployment) and enforces
 * the `/v1` prefix; every dashboard call is under `/v1`.
 */
export function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const prefixed =
    normalized === "/v1" || normalized.startsWith("/v1/")
      ? normalized
      : `/v1${normalized}`;
  return `${base}${prefixed}`;
}

/** One UUIDv4 per submission; callers reuse it across that submission's retries. */
export function createIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Unauthenticated request — the public endpoints only (`web-config`,
 * `oauth/callback`, `refresh`, `logout`). JSON in/out; 204 or an empty body
 * resolves `undefined`; non-ok throws `HttpProblemError`.
 */
export function request<T>(spec: ApiClientSpec): Promise<T> {
  return send<T>(spec, undefined);
}

/**
 * Bearer-authenticated request with the full auth lifecycle:
 *   1. proactive refresh when the access token is absent (refresh token
 *      present) or expires within `ACCESS_TOKEN_EXPIRY_SKEW_MS`;
 *   2. on 401 `authentication-required`, one single-flight refresh rotation,
 *      then one retry of the original request;
 *   3. refresh failure (or no refresh token) clears the session and throws
 *      the ORIGINAL 401; a 401 on the retry also clears the session.
 */
/**
 * Authenticated multipart upload with the full auth lifecycle (proactive refresh,
 * 401 refresh-once, idempotency retry) but WITHOUT a `content-type` header, so
 * the browser sets the multipart boundary itself. Used for release create, whose
 * body the server consumes as multipart (metadata + bundle + sourcemap) — the
 * exact shape the CLI sends, so no server change is needed.
 */
export function authenticatedMultipartRequest<T>(spec: {
  method: HttpMethod;
  path: string;
  body: FormData;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<T> {
  return authenticatedRequest<T>({
    method: spec.method,
    path: spec.path,
    multipartBody: spec.body,
    ...(spec.idempotencyKey !== undefined
      ? { idempotencyKey: spec.idempotencyKey }
      : {}),
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
  });
}

export async function authenticatedRequest<T>(spec: ApiClientSpec): Promise<T> {
  await ensureFreshAccessToken();

  try {
    return await send<T>(spec, getAccessToken()?.token);
  } catch (error) {
    if (!isAuthenticationRequired(error)) {
      throw error;
    }

    try {
      await refreshSession();
    } catch {
      // Session already cleared inside the refresh; surface the original 401
      // so the caller sees the canonical `authentication-required` problem.
      throw error;
    }

    try {
      return await send<T>(spec, getAccessToken()?.token);
    } catch (retryError) {
      if (isAuthenticationRequired(retryError)) {
        // Second 401 after a successful rotation: the session is unusable.
        clearSession();
      }
      throw retryError;
    }
  }
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Single-flight `POST /v1/auth/refresh` rotation: concurrent callers share
 * one in-flight promise, and the rotated pair is stored via the credential
 * store before it resolves. ANY failure (revoked/expired refresh token,
 * network error, invalid payload, or no refresh token at all) clears the
 * session and rejects. Exported for the boot-time session
 * restore so it shares the same in-flight promise as early queries.
 */
export function refreshSession(): Promise<void> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function performRefresh(): Promise<void> {
  const refreshToken = getRefreshToken();
  if (refreshToken === null) {
    clearSession();
    throw new Error("Cannot refresh the session: no refresh token is stored");
  }

  try {
    const payload = await send<RefreshWireResponse>(
      {
        method: "POST",
        path: "/auth/refresh",
        body: toOAuthRefreshWireBody({
          refreshToken: refreshToken.token,
        } satisfies OAuthRefreshBody),
      },
      undefined,
    );
    updateTokens(fromRefreshWire(parseRefreshResponse(payload)));
  } catch (error) {
    clearSession();
    throw error;
  }
}

/** Proactive refresh; a no-op without a refresh token (nothing to rotate with). */
async function ensureFreshAccessToken(): Promise<void> {
  if (getRefreshToken() === null) {
    return;
  }

  const accessToken = getAccessToken();
  if (accessToken !== null && !expiresWithinSkew(accessToken.expiresAt)) {
    return;
  }

  await refreshSession();
}

function expiresWithinSkew(expiresAt: string): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    // Unparseable expiry → treat as expiring so the rotation repairs it.
    return true;
  }
  return expiresAtMs - Date.now() <= ACCESS_TOKEN_EXPIRY_SKEW_MS;
}

/**
 * Dispatch plus the idempotency-conflict rule: when the spec carries a key
 * and the server answers 409 `idempotency-in-progress`, wait per
 * `Retry-After` and retry exactly once with the SAME key. A second
 * in-progress conflict propagates; 422 `idempotency-mismatch` is not caught
 * here, so it always throws immediately.
 */
async function send<T>(
  spec: ApiClientSpec,
  accessToken: string | undefined,
): Promise<T> {
  try {
    return await dispatch<T>(spec, accessToken);
  } catch (error) {
    if (spec.idempotencyKey === undefined || !isIdempotencyInProgress(error)) {
      throw error;
    }
    await delay(idempotencyRetryDelayMs(error), spec.signal);
    return dispatch<T>(spec, accessToken);
  }
}

/** One fetch: JSON in/out, problem-aware non-ok handling. No retries here. */
async function dispatch<T>(
  spec: ApiClientSpec,
  accessToken: string | undefined,
): Promise<T> {
  // Header names are case-insensitive; lowercase matches the CLI port style.
  const headers: Record<string, string> = { accept: "application/json" };
  // A multipart body MUST NOT carry an explicit content-type: the browser sets
  // `multipart/form-data; boundary=…` itself. JSON bodies set it explicitly.
  const isMultipart = spec.multipartBody !== undefined;
  if (spec.body !== undefined && !isMultipart) {
    headers["content-type"] = "application/json";
  }
  if (accessToken !== undefined) {
    headers["authorization"] = `Bearer ${accessToken}`;
  }
  if (spec.idempotencyKey !== undefined) {
    headers["idempotency-key"] = spec.idempotencyKey;
  }

  const body = isMultipart
    ? spec.multipartBody
    : spec.body !== undefined
      ? JSON.stringify(spec.body)
      : undefined;

  const response = await globalThis.fetch(apiUrl(spec.path), {
    method: spec.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
  });

  if (!response.ok) {
    throw await problemFromResponse(response);
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  const text = await response.text();
  if (text.length === 0) {
    return undefined as unknown as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON response from ${spec.method} ${spec.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Every non-ok response becomes an HttpProblemError: parsed from the
 * problem+json body when present, otherwise synthesized from the status
 * (`type: "about:blank"` → `classifyProblem` falls back by status).
 */
async function problemFromResponse(response: Response): Promise<HttpProblemError> {
  const problem =
    (await parseProblemResponse(response)) ?? synthesizeProblem(response);

  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && !(RETRY_AFTER_EXTENSION in problem.extensions)) {
    problem.extensions[RETRY_AFTER_EXTENSION] = retryAfter;
  }

  return problem;
}

function synthesizeProblem(response: Response): HttpProblemError {
  const fallback: ProblemDetails = {
    type: "about:blank",
    title:
      response.statusText.length > 0
        ? response.statusText
        : `HTTP ${response.status}`,
    status: response.status,
    detail: `Request failed with HTTP ${response.status}`,
  };
  return new HttpProblemError(fallback, response.status);
}

function isAuthenticationRequired(error: unknown): boolean {
  return (
    error instanceof HttpProblemError &&
    error.status === 401 &&
    error.typeSuffix === "authentication-required"
  );
}

function isIdempotencyInProgress(error: unknown): error is HttpProblemError {
  return (
    error instanceof HttpProblemError &&
    error.typeSuffix === "idempotency-in-progress"
  );
}

/** `Retry-After` seconds → ms; missing/invalid → 2s default; capped at 10s. */
function idempotencyRetryDelayMs(error: HttpProblemError): number {
  const raw = error.extensions[RETRY_AFTER_EXTENSION];
  const seconds =
    typeof raw === "string" && raw.trim().length > 0
      ? Number(raw)
      : typeof raw === "number"
        ? raw
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return IDEMPOTENCY_RETRY_DEFAULT_MS;
  }
  return Math.min(seconds * 1000, IDEMPOTENCY_RETRY_MAX_MS);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    // The timeout callback runs on a later macrotask, after `onAbort` exists.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return (
    (signal.reason as unknown) ??
    new DOMException("The operation was aborted", "AbortError")
  );
}

function parseRefreshResponse(value: unknown): RefreshWireResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Session refresh returned an invalid response");
  }

  const {
    access_token: accessToken,
    access_token_expires_at: accessTokenExpiresAt,
    refresh_token: refreshToken,
    refresh_token_expires_at: refreshTokenExpiresAt,
  } =
    value as Record<string, unknown>;

  if (
    !isNonEmptyString(accessToken) ||
    !isNonEmptyString(accessTokenExpiresAt) ||
    !isNonEmptyString(refreshToken) ||
    !isNonEmptyString(refreshTokenExpiresAt)
  ) {
    throw new Error("Session refresh returned an invalid response");
  }

  return {
    access_token: accessToken,
    access_token_expires_at: accessTokenExpiresAt,
    refresh_token: refreshToken,
    refresh_token_expires_at: refreshTokenExpiresAt,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
