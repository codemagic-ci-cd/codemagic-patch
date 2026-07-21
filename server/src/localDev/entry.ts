/**
 * Local evaluation entrypoint — the ONLY way to run the server with local
 * (authentication-disabled) sign-in. The stock image CMD stays dist/main.js;
 * the dev compose selects this file via a `command:` override, so a
 * production self-host structurally cannot enable local auth.
 *
 * Resolves the normal runtime config, then injects the local-dev adapters
 * through the same embedder seam (ServerRuntimeOptions) the Codemagic
 * integration uses — one seam, two consumers.
 */

import { trimTrailingSlash } from "../app/githubApi";
import { resolveRuntimeConfig } from "../runtime/config";
import { registerShutdownSignalHandlers } from "../runtime/shutdownSignals";
import { startServer } from "../runtime/startServer";
import { assertLocalDevEntryAllowed } from "./guards";
import {
  createLocalAuthNAdapter,
  LOCAL_DEV_PROVIDER,
} from "./localDevAuthAdapters";

const DEFAULT_DASHBOARD_URL = "http://localhost:8080";

const BANNER = [
  "",
  "============================================================",
  " LOCAL EVALUATION MODE — authentication is disabled.",
  " Anyone who can reach this instance can sign in as anyone.",
  " Never expose it beyond your machine.",
  "============================================================",
  "",
].join("\n");

async function main(): Promise<void> {
  assertLocalDevEntryAllowed(process.env);

  const config = resolveRuntimeConfig();
  // The dashboard URL opened by `cmpatch login` must be host-reachable; the
  // container cannot derive the host port mapping, so the compose file
  // injects it.
  const dashboardUrl = trimTrailingSlash(
    process.env.CODEMAGIC_PATCH_LOCAL_DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL,
  );

  console.warn(BANNER);

  const app = await startServer(config, {
    authNAdapter: createLocalAuthNAdapter(),
    oauthWebConfig: {
      // The dashboard is a separate container in this stack; the CLI's
      // loopback login opens `<dashboardOrigin>/cli/authorize`.
      dashboardOrigin: dashboardUrl,
      mode: LOCAL_DEV_PROVIDER,
      providers: [
        {
          // Same-origin path: the dashboard redirects to its own consent
          // route instead of an external provider.
          authorizeEndpoint: "/login/oauth/authorize",
          clientId: LOCAL_DEV_PROVIDER,
          provider: LOCAL_DEV_PROVIDER,
          scopes: "",
        },
      ],
    },
  });

  app.log.warn(
    "LOCAL EVALUATION MODE — authentication is disabled; never expose this instance",
  );

  registerShutdownSignalHandlers(app);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
