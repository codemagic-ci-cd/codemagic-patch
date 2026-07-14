// TanStack Query binding for the client download origin.
// `GET /v1/sdk-config` is authenticated but otherwise unscoped — any signed-in
// user can read `CodemagicPatchDownloadBaseUrl` (the server's PUBLIC_BASE_URL;
// not a secret). `CodemagicPatchApiUrl` stays client-derived via apiServerUrl().

import { useQuery } from "@tanstack/react-query";

import { authenticatedRequest } from "../client";

export interface SdkConfig {
  downloadBaseUrl: string;
}

interface SdkConfigWire {
  download_base_url: string;
}

export const sdkConfigKeys = {
  all: ["sdk-config"] as const,
  detail: () => [...sdkConfigKeys.all, "detail"] as const,
};

/** `GET /v1/sdk-config` — public client download origin for this server. */
export function useSdkConfig() {
  return useQuery({
    queryKey: sdkConfigKeys.detail(),
    queryFn: async ({ signal }) => {
      const wire = await authenticatedRequest<SdkConfigWire>({
        method: "GET",
        path: "/sdk-config",
        signal,
      });
      return {
        downloadBaseUrl: wire.download_base_url,
      } satisfies SdkConfig;
    },
    staleTime: 5 * 60_000,
  });
}
