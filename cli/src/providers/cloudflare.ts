/**
 * The Cloudflare calls the setup wizard makes, as pure input → typed-result
 * functions. No prompting and no user-facing copy.
 *
 * The credential involved is a **setup-time** one in the plan's sense only for
 * the zone lookup; the same token is then handed to the server, which uses it
 * at runtime to purge the edge cache after each release. Nothing is stored on
 * this side.
 */

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * The token-creation deep link, pre-scoped to exactly what the server needs.
 *
 * The permission keys are pinned by a live check against dash.cloudflare.com,
 * not by the docs: cache purge is `{"key":"cache","type":"purge"}` and NOT
 * `cache_purge`/`edit`, and an unrecognised entry is **dropped silently** —
 * the form still opens, just without that permission, and the failure then
 * surfaces much later as a purge that does nothing. `zone`/`read` rides along
 * so the wizard can look the zone up instead of asking for its id.
 */
export function buildTokenTemplateUrl(input: { name: string }): string {
  const permissions = JSON.stringify([
    { key: "zone", type: "read" },
    { key: "cache", type: "purge" },
  ]);

  const query = new URLSearchParams({
    accountId: "*",
    name: input.name,
    permissionGroupKeys: permissions,
    zoneId: "*",
  });

  return `https://dash.cloudflare.com/profile/api-tokens?${query.toString()}`;
}

export type ZoneLookup =
  | { kind: "found"; zoneId: string }
  /** The token works, but this account holds no such zone. */
  | { kind: "not-on-this-account" }
  /** The token cannot list zones — minted through the manual path. */
  | { kind: "no-zone-read" }
  | { kind: "unknown"; reason: string };

/**
 * Finds the zone id for a domain, so the user never has to go and copy it.
 *
 * Deliberately *not* gated behind `/user/tokens/verify`: an account-owned
 * `cfat_` token cannot call that endpoint at all, and a verify failure says
 * nothing about whether the token can purge — which is the capability that
 * matters and which `install.sh`'s own `verify_cloudflare` checks for real.
 */
export async function findZoneId(input: {
  apiBaseUrl?: string;
  apiToken: string;
  fetch: typeof globalThis.fetch;
  zoneName: string;
}): Promise<ZoneLookup> {
  const url = `${input.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL}/zones?name=${encodeURIComponent(
    input.zoneName,
  )}`;

  let response: Response;
  try {
    response = await input.fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.apiToken}`,
      },
    });
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "the request failed",
    };
  }

  if (response.status === 403 || response.status === 401) {
    return { kind: "no-zone-read" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unknown", reason: "Cloudflare's answer could not be read" };
  }

  const result = readZoneResult(body);
  if (result === null) {
    return {
      kind: "unknown",
      reason: `Cloudflare answered with status ${String(response.status)}`,
    };
  }

  return result.length === 0
    ? { kind: "not-on-this-account" }
    : { kind: "found", zoneId: result[0] as string };
}

function readZoneResult(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }

  const result = (body as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    return null;
  }

  return result
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

/**
 * An account-owned token, which the dashboard shows with a `cfat_` prefix.
 * Named here because it is the one shape that must never be routed through a
 * `/user/tokens/verify` call.
 */
export function isAccountOwnedToken(apiToken: string): boolean {
  return apiToken.startsWith("cfat_");
}

// ---------------------------------------------------------------------------
// The finish step: is the domain really being served through Cloudflare?
// ---------------------------------------------------------------------------

export type ProxiedCheck =
  /** Served through Cloudflare — `cf-ray` is the proof. */
  | { kind: "served"; rayId: string }
  /**
   * A 2xx with no `cf-ray`. The answer came from the origin, which means the
   * resolver used here is still handing back the pre-proxy address — the
   * record is fine, this machine's view of it is stale.
   */
  | { kind: "not-through-cloudflare" }
  /**
   * Cloudflare redirecting straight back to the same URL: the classic
   * Flexible-SSL loop, where Cloudflare talks http to an origin that redirects
   * every http request to https.
   */
  | { kind: "redirect-loop"; location: string }
  /** Cloudflare's own 52x family: it could not reach the origin. */
  | { kind: "origin-unreachable"; status: number }
  | { kind: "failed"; reason: string };

/**
 * Classifies one response fetched through the proxied hostname.
 *
 * Every branch here exists because it would otherwise be reported as success.
 * Without the request at all, the CDN serves nothing while every other check
 * passes; without the redirect branch, a Flexible-SSL loop reads as a healthy
 * redirect; without `cf-ray`, a stale local resolver answering from the origin
 * reads as the proxy working.
 */
export function classifyProxiedResponse(input: {
  headers: { get: (name: string) => string | null };
  requestUrl: string;
  status: number;
}): ProxiedCheck {
  if (input.status >= 520 && input.status <= 527) {
    return { kind: "origin-unreachable", status: input.status };
  }

  if ([301, 302, 303, 307, 308].includes(input.status)) {
    const location = input.headers.get("location") ?? "";
    return sameTarget(location, input.requestUrl)
      ? { kind: "redirect-loop", location }
      : { kind: "failed", reason: `redirected to ${location || "nowhere"}` };
  }

  if (input.status >= 400) {
    return {
      kind: "failed",
      reason: `the server answered with status ${String(input.status)}`,
    };
  }

  const rayId = input.headers.get("cf-ray");
  return rayId === null || rayId.length === 0
    ? { kind: "not-through-cloudflare" }
    : { kind: "served", rayId };
}

/** Same scheme-insensitive destination — which is what makes a loop a loop. */
function sameTarget(location: string, requestUrl: string): boolean {
  if (location.length === 0) {
    return false;
  }

  try {
    const target = new URL(location, requestUrl);
    const request = new URL(requestUrl);
    return target.host === request.host && target.pathname === request.pathname;
  } catch {
    return false;
  }
}
