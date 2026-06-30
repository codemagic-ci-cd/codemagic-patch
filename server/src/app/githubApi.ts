export interface GitHubUserResponse {
  id?: unknown;
  login?: unknown;
  name?: unknown;
}

export interface GitHubEmailResponse {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
}

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_OAUTH_BASE_URL = "https://github.com";
export const GITHUB_API_VERSION = "2026-03-10";

export async function postForm(
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

export async function getJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  accessToken: string,
): Promise<Response> {
  return fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": GITHUB_API_VERSION,
    },
    method: "GET",
  });
}

export async function readJsonObject<T>(response: Response): Promise<T | null> {
  try {
    const value = (await response.json()) as unknown;
    if (value !== null && typeof value === "object") {
      return value as T;
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchGitHubUser(
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
  const response = await getJson(fetchImpl, `${apiBaseUrl}/user`, accessToken);
  if (!response.ok) {
    return providerError(`GitHub user lookup failed with HTTP ${response.status}`);
  }

  const body = await readJsonObject<GitHubUserResponse>(response);
  if (
    !body ||
    (typeof body.id !== "number" && typeof body.id !== "string") ||
    typeof body.login !== "string"
  ) {
    return providerError("GitHub user lookup returned an invalid response");
  }

  const name = typeof body.name === "string" && body.name.length > 0
    ? body.name
    : null;

  return {
    displayName: name ?? body.login,
    outcome: "success",
    subject: String(body.id),
  };
}

export async function fetchGitHubUserByLogin(
  fetchImpl: typeof globalThis.fetch,
  apiBaseUrl: string,
  login: string,
): Promise<
  | {
      outcome: "success";
      subject: string;
    }
  | {
      outcome: "not_found";
    }
  | {
      outcome: "provider_error";
      message: string;
    }
> {
  // Public, unauthenticated lookup (GitHub allows 60 req/hr/IP unauthenticated;
  // self-host invite volume is far below that). Resolves a handle to its
  // immutable numeric id so invitations bind to the account, not the string.
  const response = await fetchImpl(
    `${apiBaseUrl}/users/${encodeURIComponent(login)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      method: "GET",
    },
  );

  if (response.status === 404) {
    return {
      outcome: "not_found",
    };
  }

  if (!response.ok) {
    return providerError(
      `GitHub user lookup failed with HTTP ${response.status}`,
    );
  }

  const body = await readJsonObject<GitHubUserResponse>(response);
  if (
    !body ||
    (typeof body.id !== "number" && typeof body.id !== "string") ||
    typeof body.login !== "string"
  ) {
    return providerError("GitHub user lookup returned an invalid response");
  }

  return {
    outcome: "success",
    subject: String(body.id),
  };
}

export async function fetchVerifiedPrimaryEmail(
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
  const response = await getJson(
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
    return providerError(`GitHub email lookup failed with HTTP ${response.status}`);
  }

  const body = await readJsonObject<GitHubEmailResponse[]>(response);
  if (!Array.isArray(body)) {
    return providerError("GitHub email lookup returned an invalid response");
  }

  const primary = body.find(
    (email) =>
      email.primary === true &&
      email.verified === true &&
      typeof email.email === "string" &&
      email.email.length > 0,
  );

  if (!primary || typeof primary.email !== "string") {
    return {
      outcome: "verified_email_required",
    };
  }

  return {
    email: primary.email,
    outcome: "success",
  };
}

export function hasScope(value: unknown, scope: string): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return value
    .split(/[,\s]+/)
    .filter((part) => part.length > 0)
    .includes(scope);
}

export function providerError(message: string): {
  outcome: "provider_error";
  message: string;
} {
  return {
    message,
    outcome: "provider_error",
  };
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
