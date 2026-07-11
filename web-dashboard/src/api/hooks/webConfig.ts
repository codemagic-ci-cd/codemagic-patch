// TanStack Query binding for the public web OAuth config. One shared key so
// the login page and the local consent route read the same session-cached
// config (the server's provider setup cannot change under a running SPA).
// The app-shell evaluation banner deliberately does NOT read this — it
// derives from the whoami query (hooks/me.ts useIsLocalDevSession) so the
// authenticated shell never spends a request on this login-flow endpoint.

import { useQuery } from "@tanstack/react-query";

import { fetchWebConfig } from "../../auth/webConfig";

/** Query keys for the auth web-config domain. */
export const webConfigKeys = {
  all: ["auth", "web-config"] as const,
};

/**
 * `GET /v1/auth/oauth/web-config` (public, no bearer). Errors propagate as
 * HttpProblemError — the login page classifies them (`classifyWebConfigError`);
 * the consent page renders its standalone 404 card on error.
 */
export function useWebConfig() {
  return useQuery({
    queryKey: webConfigKeys.all,
    queryFn: fetchWebConfig,
    // The SPA caches the provider config for the session.
    staleTime: Infinity,
  });
}
