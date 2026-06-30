import {
  DEFAULT_GITHUB_API_BASE_URL,
  fetchGitHubUserByLogin,
  trimTrailingSlash,
} from "./githubApi";

export type ResolveHandleResult =
  | {
      outcome: "success";
      provider: string;
      subject: string;
    }
  | {
      outcome: "not_found";
    }
  | {
      outcome: "provider_error";
      message: string;
    };

// Directory-lookup port: resolves a GitHub handle to its immutable numeric
// subject at invite-creation time. Kept separate from AuthNAdapter (which owns
// authentication) so each has a single responsibility. The resolved subject is
// what invitations bind to, sidestepping handle-recycling.
export interface GitHubUserLookupService {
  resolveHandle(handle: string): Promise<ResolveHandleResult>;
}

export interface CreateGitHubUserLookupServiceOptions {
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export function createGitHubUserLookupService(
  options: CreateGitHubUserLookupServiceOptions = {},
): GitHubUserLookupService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
  );

  return {
    async resolveHandle(handle) {
      const result = await fetchGitHubUserByLogin(
        fetchImpl,
        apiBaseUrl,
        handle,
      );
      if (result.outcome === "success") {
        return {
          outcome: "success",
          provider: "github",
          subject: result.subject,
        };
      }

      return result;
    },
  };
}
