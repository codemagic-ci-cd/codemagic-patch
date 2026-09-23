import { r2Account } from "../../../scripts/selfhost/lib/r2-privacy.cjs";
export { r2Account };
/**
 * The Cloudflare calls the setup wizard makes, as pure input → typed-result
 * functions. No prompting and no user-facing copy.
 *
 * The credential involved is a **setup-time** one in the plan's sense only for
 * the zone lookup; the same token is then handed to the server, which uses it
 * at runtime to purge the edge cache after each release. Nothing is stored on
 * this side.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ProviderHttpError } from "./providerError";

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

export function buildDnsTokenTemplateUrl(input: { name: string }): string {
  const query = new URLSearchParams({
    accountId: "*",
    name: input.name,
    // `cache_settings` is `edit` on this user-token page; the account-token
    // page the R2 template uses takes `write` for the same permission, and
    // either spelling on the wrong page is dropped without a warning.
    permissionGroupKeys: JSON.stringify([
      { key: "zone", type: "read" },
      { key: "dns", type: "edit" },
      { key: "cache_settings", type: "edit" },
      { key: "zone_settings", type: "read" },
    ]),
    // The zone ID is not available until the user supplies a token.
    zoneId: "all",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${query.toString()}`;
}

export function buildR2TokenTemplateUrl(input: {
  name: string;
  runtime?: boolean;
}): string {
  const query = new URLSearchParams({
    to: "/:account/api-tokens",
    name: input.name,
    permissionGroupKeys: JSON.stringify([
      ...(input.runtime
        ? [{ key: "workers_r2", type: "read" }]
        : [
            { key: "account_api_tokens", type: "edit" },
            { key: "workers_r2", type: "edit" },
            { key: "cache_settings", type: "write" },
          ]),
      { key: "zone", type: "read" },
      { key: "cache", type: "purge" },
    ]),
  });
  return `https://dash.cloudflare.com/?${query.toString()}`;
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

/** Account-owned tokens use the account API family throughout their lifetime. */
export async function cloudflareRequest<T>(input: {
  fetch: typeof fetch;
  apiToken: string;
  path: string;
  method?: string;
  body?: unknown;
}): Promise<T> {
  const response = await input.fetch(
    `${CLOUDFLARE_API_BASE_URL}${input.path}`,
    {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const operation = `Cloudflare ${input.method ?? "GET"} ${input.path.split("?")[0]}`;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError(operation, response.status);
  }
  let body: { result: T; success: boolean } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new ProviderHttpError(operation, response.status);
  }
  if (!body?.success) throw new ProviderHttpError(operation, response.status);
  return body.result;
}

/**
 * The zone's SSL/TLS encryption mode: `off`, `flexible`, `full` or `strict`.
 * A zone on the dashboard's "Automatic" setting reports the mode currently in
 * effect here (its `ssl_automatic_mode` is a separate setting), checked
 * against a live zone.
 */
export async function readZoneSslMode(input: {
  fetch: typeof fetch;
  apiToken: string;
  zoneId: string;
}): Promise<string> {
  const setting = await cloudflareRequest<{ value: string }>({
    ...input,
    path: `/zones/${encodeURIComponent(input.zoneId)}/settings/ssl`,
  });
  return setting.value;
}

export class CacheRuleConflict extends Error {}

/**
 * The cache settings one delivery path needs on its download hostname.
 * `create` is what the wizard writes; `compatible` lists every shape an
 * existing rule for the same hostname may have and still be reused untouched.
 */
export type CacheRuleProfile = {
  create: Record<string, unknown>;
  compatible: readonly Record<string, unknown>[];
  requirement: string;
};

/** R2 custom domains: cache everything, keep the origin's browser TTL. */
export const R2_CACHE_RULE: CacheRuleProfile = {
  create: { cache: true, browser_ttl: { mode: "respect_origin" } },
  compatible: [{ cache: true, browser_ttl: { mode: "respect_origin" } }],
  requirement:
    "action_parameters must contain only cache: true and browser_ttl: { mode: respect_origin }",
};

/**
 * The bundled server behind the Cloudflare proxy: follow the server's own
 * cache-control and bypass without it, so no edge TTL override outlives a
 * purge. `bypass_by_default` is the dashboard's "Use cache-control header if
 * present, bypass cache if not", checked against a live zone. A rule made by
 * hand in the dashboard may also carry a `respect_origin` browser TTL, which
 * changes nothing at the edge.
 */
export const ORIGIN_CACHE_RULE: CacheRuleProfile = {
  create: { cache: true, edge_ttl: { mode: "bypass_by_default" } },
  compatible: [
    { cache: true, edge_ttl: { mode: "bypass_by_default" } },
    {
      cache: true,
      edge_ttl: { mode: "bypass_by_default" },
      browser_ttl: { mode: "respect_origin" },
    },
  ],
  requirement:
    "action_parameters must contain only cache: true and edge_ttl: { mode: bypass_by_default }",
};

type CacheRuleInput = {
  fetch: typeof fetch;
  apiToken: string;
  zoneId: string;
  domain: string;
  profile: CacheRuleProfile;
  /** Checked right before the write, so a cancelled run submits nothing. */
  shouldStop?: () => boolean;
};
type CacheRuleset = {
  id: string;
  rules?: {
    expression: string;
    action?: string;
    enabled?: boolean;
    action_parameters?: Record<string, unknown>;
  }[];
};

/**
 * The hostname a single-hostname rule matches. The dashboard stores a rule
 * built in its form as `(http.host eq "x")` while the API keeps ours bare;
 * both are the same rule.
 */
function hostOfRule(expression: string): string | null {
  let inner = expression.trim();
  while (inner.startsWith("(") && inner.endsWith(")"))
    inner = inner.slice(1, -1).trim();
  const match = /^http\.host eq "([^"()]+)"$/u.exec(inner);
  return match === null ? null : match[1]!.toLowerCase();
}

function rulesForHost(ruleset: CacheRuleset | undefined, domain: string) {
  return (ruleset?.rules ?? []).filter(
    (rule) => hostOfRule(rule.expression) === domain.toLowerCase(),
  );
}

export async function checkCacheRule(
  input: CacheRuleInput,
): Promise<CacheRuleset | undefined> {
  let ruleset: CacheRuleset;
  try {
    ruleset = await cloudflareRequest({
      ...input,
      path: `/zones/${input.zoneId}/rulesets/phases/http_request_cache_settings/entrypoint`,
    });
  } catch (error) {
    if (error instanceof ProviderHttpError && error.status === 404)
      return undefined;
    throw error;
  }
  for (const rule of rulesForHost(ruleset, input.domain)) {
    const differences: string[] = [];
    if (rule.enabled !== true) differences.push("the rule must be enabled");
    if (rule.action !== "set_cache_settings")
      differences.push("action must be set_cache_settings");
    if (
      !input.profile.compatible.some((parameters) =>
        isDeepStrictEqual(rule.action_parameters, parameters),
      )
    )
      differences.push(input.profile.requirement);
    if (differences.length > 0)
      throw new CacheRuleConflict(
        `A cache rule for ${input.domain} already exists with incompatible settings: ${differences.join("; ")}. Review it in Cloudflare and use guided setup to reuse existing resources; automatic setup will not change it or add another hostname rule.`,
      );
  }
  return ruleset;
}

/**
 * Adds the hostname rule, reusing an equivalent existing one. "stopped" means
 * the run was cancelled before anything was submitted.
 */
export async function createCacheRule(
  input: CacheRuleInput,
): Promise<"written" | "reused" | "stopped"> {
  const path = `/zones/${input.zoneId}/rulesets`;
  const rule = {
    action: "set_cache_settings",
    expression: `http.host eq "${input.domain}"`,
    description: `Patch downloads ${input.domain}`,
    enabled: true,
    action_parameters: input.profile.create,
  };
  const ruleset = await checkCacheRule(input);
  if (rulesForHost(ruleset, input.domain).length > 0) return "reused";
  if (input.shouldStop?.() === true) return "stopped";
  if (!ruleset) {
    await cloudflareRequest({
      ...input,
      path,
      method: "POST",
      body: {
        name: "Patch download cache",
        kind: "zone",
        phase: "http_request_cache_settings",
        rules: [rule],
      },
    });
    return "written";
  }
  await cloudflareRequest({
    ...input,
    path: `${path}/${ruleset.id}/rules`,
    method: "POST",
    body: rule,
  });
  return "written";
}


export async function deriveR2Credentials(
  fetcher: typeof fetch,
  endpoint: string,
  token: string,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const account = r2Account(endpoint);
  if (!account)
    throw new Error("R2 requires the default-jurisdiction account endpoint.");
  const verified = await cloudflareRequest<{ id: string; status: string }>({
    fetch: fetcher,
    apiToken: token,
    path: `/accounts/${account}/tokens/verify`,
  });
  if (!verified.id || verified.status !== "active")
    throw new Error("The combined R2 account token is not active.");
  return {
    accessKeyId: verified.id,
    secretAccessKey: createHash("sha256").update(token).digest("hex"),
  };
}
