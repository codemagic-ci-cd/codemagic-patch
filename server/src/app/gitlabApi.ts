// GitLab OAuth + REST helpers. Provider-specific contracts (checked
// against GitLab docs 2026-09-17):
// - Authorize endpoint is `{base}/oauth/authorize`; the token endpoint is
//   `{base}/oauth/token` and speaks `application/x-www-form-urlencoded`.
// - The confidential web code exchange sends `client_id` + `client_secret` in
//   the form body with `grant_type=authorization_code`, plus `redirect_uri`
//   and the PKCE `code_verifier`.
// - Grant failures surface as HTTP 400/401 with an `error` body
//   (`invalid_grant` for bad/expired codes) — read the body before keying on
//   status, like the Bitbucket adapter does.
// - Identity comes from `GET {apiBase}/user` (subject = immutable numeric
//   `id`); the verified email comes from `GET {apiBase}/user/emails`, whose
//   entries carry `confirmed_at` (non-null = confirmed) and no primary flag.
// - Minimum scope is `read_user`. Scopes live on the GitLab application;
//   the token response echoes the granted set as a space-separated `scope`
//   string when present.

import { providerError, readJsonObject } from "./githubApi";

export const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";

export function defaultGitlabApiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/v4`;
}

export interface GitlabUserResponse {
  confirmed_at?: unknown;
  email?: unknown;
  id?: unknown;
  name?: unknown;
  username?: unknown;
}

export interface GitlabEmailResponse {
  confirmed_at?: unknown;
  email?: unknown;
}

export async function postGitlabTokenForm(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetchImpl(url, {
    body: new URLSearchParams(body),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
}

export async function getGitlabJson(
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

export async function fetchGitlabUser(
  fetchImpl: typeof globalThis.fetch,
  apiBaseUrl: string,
  accessToken: string,
): Promise<
  | {
      outcome: "success";
      displayName: string | null;
      email: string | null;
      subject: string;
    }
  | {
      outcome: "provider_error";
      message: string;
    }
> {
  const response = await getGitlabJson(
    fetchImpl,
    `${apiBaseUrl}/user`,
    accessToken,
  );
  if (!response.ok) {
    return providerError(
      `GitLab user lookup failed with HTTP ${response.status}`,
    );
  }

  const body = await readJsonObject<GitlabUserResponse>(response);
  if (
    !body ||
    (typeof body.id !== "number" && typeof body.id !== "string") ||
    String(body.id).length === 0
  ) {
    return providerError("GitLab user lookup returned an invalid response");
  }

  const displayName =
    typeof body.name === "string" && body.name.length > 0
      ? body.name
      : typeof body.username === "string" && body.username.length > 0
        ? body.username
        : null;
  const email =
    typeof body.email === "string" && body.email.length > 0 ? body.email : null;

  return {
    displayName,
    email,
    outcome: "success",
    subject: String(body.id),
  };
}

/**
 * Resolves the account's verified email. GitLab's list has no primary flag,
 * so the `/user` email wins when it matches a confirmed entry; otherwise the
 * first confirmed entry is used. Unconfirmed-only accounts resolve to
 * `verified_email_required`, matching the GitHub/Bitbucket adapters.
 */
export async function fetchGitlabVerifiedPrimaryEmail(
  fetchImpl: typeof globalThis.fetch,
  apiBaseUrl: string,
  accessToken: string,
  preferredEmail: string | null,
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
  const response = await getGitlabJson(
    fetchImpl,
    `${apiBaseUrl}/user/emails?per_page=100`,
    accessToken,
  );

  if (response.status === 401 || response.status === 403) {
    return {
      outcome: "email_scope_required",
    };
  }

  if (!response.ok) {
    return providerError(
      `GitLab email lookup failed with HTTP ${response.status}`,
    );
  }

  const body = await readJsonObject<GitlabEmailResponse[]>(response);
  if (!Array.isArray(body)) {
    return providerError("GitLab email lookup returned an invalid response");
  }

  const confirmed = body.filter(
    (entry): entry is { email: string; confirmed_at: string } =>
      typeof entry.email === "string" &&
      entry.email.length > 0 &&
      typeof entry.confirmed_at === "string" &&
      entry.confirmed_at.length > 0,
  );

  if (confirmed.length === 0) {
    return {
      outcome: "verified_email_required",
    };
  }

  if (preferredEmail !== null) {
    const match = confirmed.find(
      (entry) => entry.email.toLowerCase() === preferredEmail.toLowerCase(),
    );
    if (match) {
      return {
        email: match.email,
        outcome: "success",
      };
    }
  }

  const first = confirmed[0];
  if (!first) {
    return {
      outcome: "verified_email_required",
    };
  }

  return {
    email: first.email,
    outcome: "success",
  };
}

/**
 * The token response's granted-scope report. `read_user` is what the user +
 * emails endpoints need; broader scopes (`api`, `read_api`) imply it.
 */
export function hasGitlabReadUserScope(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const scopes = value.split(/[,\s]+/).filter((part) => part.length > 0);
  return (
    scopes.includes("read_user") ||
    scopes.includes("read_api") ||
    scopes.includes("api")
  );
}
