// Bitbucket Cloud OAuth + REST helpers. Provider-specific contracts (checked
// against Atlassian docs 2026-07-20):
// - Token endpoint client auth is HTTP Basic (client_id:secret), not body
//   params.
// - Scopes live on the OAuth consumer; the token response reports the granted
//   set in a space-separated `scopes` field.
// - `GET /2.0/user/emails` is paginated (`values` + absolute `next` link).

import { providerError, readJsonObject } from "./githubApi";

export interface BitbucketUserResponse {
  account_id?: unknown;
  display_name?: unknown;
  username?: unknown;
}

export interface BitbucketEmailResponse {
  email?: unknown;
  is_confirmed?: unknown;
  is_primary?: unknown;
}

interface BitbucketEmailPageResponse {
  next?: unknown;
  values?: unknown;
}

export const DEFAULT_BITBUCKET_API_BASE_URL = "https://api.bitbucket.org";
export const DEFAULT_BITBUCKET_OAUTH_BASE_URL = "https://bitbucket.org";

/**
 * Defense against a hostile/broken provider emitting an endless `next` chain;
 * a real account's email list is pages away from this bound.
 */
const MAX_EMAIL_PAGES = 10;

export async function postFormWithBasicAuth(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  credentials: { clientId: string; clientSecret: string },
  body: Record<string, string>,
): Promise<Response> {
  const basic = Buffer.from(
    `${credentials.clientId}:${credentials.clientSecret}`,
  ).toString("base64");

  return fetchImpl(url, {
    body: new URLSearchParams(body),
    headers: {
      accept: "application/json",
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
}

export async function getBitbucketJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  accessToken: string,
): Promise<Response> {
  return fetchImpl(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    method: "GET",
  });
}

export async function fetchBitbucketUser(
  fetchImpl: typeof globalThis.fetch,
  apiBaseUrl: string,
  accessToken: string,
): Promise<
  | {
      outcome: "success";
      displayName: string | null;
      subject: string;
    }
  | {
      outcome: "provider_error";
      message: string;
    }
> {
  const response = await getBitbucketJson(
    fetchImpl,
    `${apiBaseUrl}/2.0/user`,
    accessToken,
  );
  if (!response.ok) {
    return providerError(
      `Bitbucket user lookup failed with HTTP ${response.status}`,
    );
  }

  const body = await readJsonObject<BitbucketUserResponse>(response);
  // Subject is the immutable account_id; username/display_name are mutable.
  if (!body || typeof body.account_id !== "string" || body.account_id.length === 0) {
    return providerError("Bitbucket user lookup returned an invalid response");
  }

  const displayName =
    typeof body.display_name === "string" && body.display_name.length > 0
      ? body.display_name
      : typeof body.username === "string" && body.username.length > 0
        ? body.username
        : null;

  return {
    displayName,
    outcome: "success",
    subject: body.account_id,
  };
}

/**
 * Walks `GET /2.0/user/emails` pages (absolute `next` links) until a
 * confirmed primary email is found or pages are exhausted.
 */
export async function fetchBitbucketVerifiedPrimaryEmail(
  fetchImpl: typeof globalThis.fetch,
  apiBaseUrl: string,
  accessToken: string,
): Promise<
  | {
      outcome: "success";
      email: string;
    }
  | {
      outcome: "email_scope_required";
    }
  | {
      outcome: "verified_email_required";
    }
  | {
      outcome: "provider_error";
      message: string;
    }
> {
  let url: string | null = `${apiBaseUrl}/2.0/user/emails?pagelen=100`;

  for (let page = 0; page < MAX_EMAIL_PAGES && url !== null; page += 1) {
    const response = await getBitbucketJson(fetchImpl, url, accessToken);

    if (response.status === 401 || response.status === 403) {
      return {
        outcome: "email_scope_required",
      };
    }

    if (!response.ok) {
      return providerError(
        `Bitbucket email lookup failed with HTTP ${response.status}`,
      );
    }

    const body = await readJsonObject<BitbucketEmailPageResponse>(response);
    if (!body || !Array.isArray(body.values)) {
      return providerError("Bitbucket email lookup returned an invalid response");
    }

    const primary = (body.values as BitbucketEmailResponse[]).find(
      (email) =>
        email.is_primary === true &&
        email.is_confirmed === true &&
        typeof email.email === "string" &&
        email.email.length > 0,
    );

    if (primary && typeof primary.email === "string") {
      return {
        email: primary.email,
        outcome: "success",
      };
    }

    url = typeof body.next === "string" && body.next.length > 0 ? body.next : null;
  }

  return {
    outcome: "verified_email_required",
  };
}

/**
 * The token response's granted-scope report. `email` is what the email
 * endpoint needs; `account` implies it (consumer scopes are hierarchical).
 */
export function hasBitbucketEmailScope(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const scopes = value.split(/[,\s]+/).filter((part) => part.length > 0);
  return scopes.includes("email") || scopes.includes("account");
}
