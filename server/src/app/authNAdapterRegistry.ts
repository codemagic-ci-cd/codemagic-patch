import type { AuthNAdapter } from "./authNAdapter";

export interface AuthNAdapterRegistration {
  adapter: AuthNAdapter;
  /**
   * Exact-match allowlist of accepted `redirectUri` values for this provider.
   * Empty/undefined disables the check (mirrors the config semantics: an
   * unset env var means no allowlisting).
   */
  allowedRedirectUris?: string[];
  provider: string;
}

/**
 * Dispatching AuthNAdapter: routes `exchangeCode` to the registered adapter
 * for `input.provider`. The redirect-URI allowlist check is enforced here —
 * once, for every provider — so concrete adapters only keep their provider
 * guard as defense in depth.
 */
export function createAuthNAdapterRegistry(
  registrations: AuthNAdapterRegistration[],
): AuthNAdapter {
  const byProvider = new Map(
    registrations.map((registration) => [registration.provider, registration]),
  );

  return {
    async exchangeCode(input) {
      const registration = byProvider.get(input.provider);
      if (!registration) {
        return {
          outcome: "unknown_provider",
        };
      }

      const allowedRedirectUris = registration.allowedRedirectUris ?? [];
      if (
        allowedRedirectUris.length > 0 &&
        !allowedRedirectUris.includes(input.redirectUri)
      ) {
        return {
          outcome: "invalid_grant",
        };
      }

      return registration.adapter.exchangeCode(input);
    },
  };
}
