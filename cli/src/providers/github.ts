/**
 * The GitHub calls the setup wizard makes, as pure input → typed-result
 * functions.
 *
 * No prompting and no user-facing copy live here: the wizard composes these
 * with its own step primitives. Setup-time credentials (an OAuth app's client
 * id and secret, which the *server* will use at runtime) only ever pass
 * through — nothing is stored on this side.
 */

/** What the CLI can tell about a pair before it asks GitHub anything. */
export type GithubPairProblem =
  /** One or both are empty. */
  | "missing"
  /**
   * The client id is a 40-character hex string and the secret is not — the
   * fields were filled in the wrong order, which is by far the most common way
   * this step goes wrong and produces a 401 that reads like a bad secret.
   */
  | "swapped"
  | "client-id-shape"
  | "client-secret-shape";

/** GitHub's OAuth app client secrets are 40 hex characters. */
const CLIENT_SECRET_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * Deliberately loose: GitHub has issued `Iv1.<16 hex>`, `Ov23li…`, and plain
 * 20-character ids over the years, and a shape check that goes stale rejects
 * a credential that works. It only has to catch a value that is obviously not
 * an id — a pasted URL, a truncated copy, a stray quote.
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9.]{10,64}$/u;

export function checkGithubPairShape(
  clientId: string,
  clientSecret: string,
): GithubPairProblem | null {
  if (clientId.length === 0 || clientSecret.length === 0) {
    return "missing";
  }

  if (
    CLIENT_SECRET_PATTERN.test(clientId) &&
    !CLIENT_SECRET_PATTERN.test(clientSecret)
  ) {
    return "swapped";
  }

  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return "client-id-shape";
  }

  // Length only, not the hex pattern: a future secret format that is longer or
  // uses more characters must not be refused locally when GitHub would accept
  // it. The API check below is the real gate.
  if (clientSecret.length < 20 || /\s/u.test(clientSecret)) {
    return "client-secret-shape";
  }

  return null;
}

export type GithubPairCheck =
  /** GitHub accepted the pair: 404 for a token that does not exist. */
  | { kind: "valid" }
  /** GitHub rejected the credentials themselves: 401. */
  | { kind: "invalid" }
  /**
   * Neither answer arrived — offline, a proxy, a rate limit, an unexpected
   * status. Never reported as a failure: the pair is checked again for real at
   * the first sign-in.
   */
  | { kind: "unknown"; reason: string };

export const GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Verifies an OAuth app's client id and secret without a browser round trip.
 *
 * `POST /applications/{client_id}/token` authenticates with the pair itself
 * and asks about a token: a **404** means "these credentials are fine, that
 * token does not exist", and a **401** means the credentials are not. Both
 * halves are live-verified against github.com. Nothing here is granted or
 * created, and the dummy token is not a secret.
 */
export async function checkGithubPair(input: {
  apiBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<GithubPairCheck> {
  const url = `${input.apiBaseUrl ?? GITHUB_API_BASE_URL}/applications/${encodeURIComponent(
    input.clientId,
  )}/token`;

  let response: Response;
  try {
    response = await input.fetch(url, {
      body: JSON.stringify({ access_token: "cmpatch-setup-check" }),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${base64(`${input.clientId}:${input.clientSecret}`)}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      method: "POST",
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "the request failed",
    };
  }

  if (response.status === 404) {
    return { kind: "valid" };
  }

  if (response.status === 401) {
    return { kind: "invalid" };
  }

  return {
    kind: "unknown",
    reason: `GitHub answered with status ${String(response.status)}`,
  };
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * The prefilled OAuth app creation form.
 *
 * All three fields populate on today's github.com, in both the personal and
 * the `/organizations/<org>/` variant. Two caveats the caller's copy has to
 * carry: the callback field is now a repeatable "Authorization callback URLs"
 * list, and the organization URL 404s for anyone who is not an owner of that
 * organization.
 */
export function buildOAuthAppUrl(input: {
  apiDomain: string;
  name: string;
  organization?: string;
}): string {
  const base =
    input.organization === undefined
      ? "https://github.com/settings/applications/new"
      : `https://github.com/organizations/${encodeURIComponent(
          input.organization,
        )}/settings/applications/new`;

  const query = new URLSearchParams({
    "oauth_application[callback_url]": callbackUrl(input.apiDomain),
    "oauth_application[name]": input.name,
    "oauth_application[url]": `https://${input.apiDomain}/`,
  });

  return `${base}?${query.toString()}`;
}

/** The one value the server's OAuth allowlist is built from. */
export function callbackUrl(apiDomain: string): string {
  return `https://${apiDomain}/auth/callback`;
}
