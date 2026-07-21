// Shared helpers for talking to the public delivery origin (the CDN / object
// storage that serves manifests and bundle artifacts). These are unauthenticated
// reads against `CodemagicPatchDownloadBaseUrl`-style origins, used by `doctor`'s
// download preflight and by base-bytecode acquisition.

export type DeliveryJsonResponse = {
  body: unknown;
  ok: boolean;
  status: number;
  text: string;
  url: string;
};

/**
 * Join `pathSegments` onto a delivery base URL. Segments are joined RAW (not
 * percent-encoded) to match how the native SDKs and the server build and serve
 * these keys — they interpolate the deployment key, binary version, and package
 * hash directly. Those segments are restricted to path-safe characters by the
 * server, and crucially `+` (legal in a binary version) must survive verbatim:
 * `encodeURIComponent` would turn it into `%2B` and 404 against the real object.
 * `new URL` still percent-encodes any genuinely-unsafe character during
 * serialization. The static-delivery key layout joins segments such as
 * `[deploymentKey, binaryVersion, "manifest.json"]` verbatim.
 */
export function buildDownloadUrl(
  downloadBaseUrl: string,
  pathSegments: string[],
): string {
  const normalized = downloadBaseUrl.endsWith("/")
    ? downloadBaseUrl
    : `${downloadBaseUrl}/`;
  const url = new URL(pathSegments.join("/"), normalized);

  return url.toString();
}

/**
 * Build the fetch init for a delivery GET. When `timeoutMs` is set, attach an
 * abort signal so a slow/hung origin degrades within a bounded time instead of
 * stalling the caller (used by best-effort base-bytecode acquisition).
 */
function deliveryRequestInit(
  options: { timeoutMs?: number },
): Parameters<typeof globalThis.fetch>[1] {
  return {
    method: "GET",
    ...(options.timeoutMs !== undefined
      ? { signal: AbortSignal.timeout(options.timeoutMs) }
      : {}),
  };
}

/**
 * GET a delivery URL and parse the body as JSON. Never throws on a non-2xx
 * status (the caller inspects `ok`/`status`); only a malformed body on a 2xx
 * response is an error.
 */
export async function fetchDeliveryJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<DeliveryJsonResponse> {
  const response = await fetchImpl(url, deliveryRequestInit(options));
  const text = await response.text();
  let body: unknown = null;

  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      if (response.ok) {
        throw new Error(
          `Invalid delivery JSON response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    body,
    ok: response.ok,
    status: response.status,
    text,
    url,
  };
}

export type DeliveryBinaryResponse = {
  bytes?: Uint8Array;
  ok: boolean;
  status: number;
  url: string;
};

/**
 * GET a delivery URL as raw bytes (e.g. a `bundle.tar.zst` artifact). Returns
 * `bytes` only on a 2xx response; never throws on a non-2xx status.
 */
export async function fetchDeliveryBinary(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<DeliveryBinaryResponse> {
  const response = await fetchImpl(url, deliveryRequestInit(options));
  if (!response.ok) {
    return { ok: false, status: response.status, url };
  }

  const buffer = await response.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    ok: true,
    status: response.status,
    url,
  };
}
