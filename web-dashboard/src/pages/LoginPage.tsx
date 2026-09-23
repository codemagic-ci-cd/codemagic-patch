// Login / OAuth start (centered .auth-card on the starfield .auth backdrop).
// States: loading (web-config fetch), default (one "Continue with <provider>"
// button per configured provider → startLogin → authorize redirect,
// post-click spinner until the navigation lands), configuration-error
// (web-config 404 about:blank per the web-config contract →
// classifyWebConfigError) with Retry, network failure → retryable, and the
// `?error=` banner for authorize redirects that came back without a code
// (provider denial — CallbackPage funnels those here).
// Already-authenticated visitors are bounced to returnTo ?? "/" once the
// AuthProvider boot restore settles. The "Change server" link is
// intentionally dropped: the SPA is same-origin, so the server IS
// window.location.origin (shown in the server chip).

import { useState } from "react";
import { Navigate, useSearchParams } from "react-router";

import { useWebConfig } from "../api/hooks/webConfig";
import { HttpProblemError } from "../api/problem";
import { useSession } from "../auth/AuthProvider";
import {
  classifyWebConfigError,
  isLocalDevMode,
  providerDisplayName,
  startLogin,
} from "../auth/webConfig";
import { PRODUCT_NAME } from "../branding";
import { PatchBrand } from "../components/brand/PatchBrand";
import { AUTH_CARD, AuthBackdrop } from "../components/ui/AuthBackdrop";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import type { OAuthWebConfigProvider } from "../api/types";

const CONFIGURATION_ERROR_MESSAGE =
  "Browser sign-in is unavailable: this server is not configured for web OAuth.";
const CONFIG_FETCH_FAILED_MESSAGE =
  "Couldn't load the sign-in configuration — check your connection and try again.";
const REDIRECT_FAILED_MESSAGE =
  "Couldn't start the sign-in redirect — try again.";

export function LoginPage() {
  const { bootStatus, isAuthenticated } = useSession();
  const [searchParams] = useSearchParams();
  // Provider id of the in-flight redirect; every button disables while set.
  const [redirectingProvider, setRedirectingProvider] = useState<string | null>(
    null,
  );
  const [startError, setStartError] = useState(false);

  const configQuery = useWebConfig();

  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
  // Authorize error bounced back via /auth/callback?error=….
  const oauthError = searchParams.get("error");

  if (bootStatus === "ready" && isAuthenticated) {
    return <Navigate to={returnTo ?? "/"} replace />;
  }

  const handleContinue = async (provider: OAuthWebConfigProvider) => {
    if (redirectingProvider !== null) {
      return;
    }
    setStartError(false);
    setRedirectingProvider(provider.provider);
    try {
      const authorizeUrl = await startLogin(provider, returnTo);
      // Full-page navigation to the provider; the spinner stays until it
      // lands.
      window.location.assign(authorizeUrl);
    } catch {
      // WebCrypto unavailable (non-secure context) — surface and re-enable.
      setRedirectingProvider(null);
      setStartError(true);
    }
  };

  let body;
  if (bootStatus === "restoring" || configQuery.isPending) {
    body = (
      <div role="status" className="mt-7">
        <div className="spinner blue" aria-hidden="true" />
        <p className="text-fg-3 text-[13px]">
          Checking sign-in configuration…
        </p>
      </div>
    );
  } else if (configQuery.isError) {
    const behavior =
      configQuery.error instanceof HttpProblemError
        ? classifyWebConfigError(configQuery.error)
        : null;
    body = (
      <>
        <div
          className={`${CALLOUT} ${CALLOUT_TONE.danger} text-left mt-7`}
          role="alert"
        >
          <AlertIcon />
          <div>
            {behavior === "configuration-error"
              ? CONFIGURATION_ERROR_MESSAGE
              : CONFIG_FETCH_FAILED_MESSAGE}
          </div>
        </div>
        <button
          type="button"
          className={`${buttonVariants({ intent: "ghost", block: true })} mt-[18px]`}
          onClick={() => {
            void configQuery.refetch();
          }}
        >
          <RefreshIcon /> Retry
        </button>
      </>
    );
  } else {
    // Local evaluation stack: same flow, but the authorize redirect lands on
    // the same-origin consent page instead of a provider — relabel accordingly.
    const localDev = isLocalDevMode(configQuery.data);
    const hasBanner = oauthError !== null || startError;
    body = (
      <>
        {hasBanner ? (
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.danger} text-left mt-6`}
            role="alert"
          >
            <AlertIcon />
            <div>
              {startError
                ? REDIRECT_FAILED_MESSAGE
                : `Sign-in didn't complete (${oauthError}). Try again.`}
            </div>
          </div>
        ) : null}
        <div
          className="flex flex-col gap-3"
          style={{ marginTop: hasBanner ? 18 : 28 }}
        >
          {configQuery.data.providers.map((provider) => (
            <ProviderButton
              key={provider.provider}
              provider={provider}
              localDev={localDev}
              redirecting={redirectingProvider === provider.provider}
              disabled={redirectingProvider !== null}
              onClick={() => {
                void handleContinue(provider);
              }}
            />
          ))}
        </div>
        <p className="mt-4 text-[12px]/[1.6] text-fg-3">
          {localDev
            ? "Local evaluation mode replaces provider sign-in — authentication is disabled on this stack. Do not expose it."
            : "Uses the OAuth 2.0 authorization-code flow with PKCE — no client secret is stored in the browser."}
        </p>
      </>
    );
  }

  return (
    <AuthBackdrop>
      <main className={AUTH_CARD}>
        <PatchBrand decorative className="mx-auto mb-5 h-8 w-auto" />
        <h1 className="text-[23px] font-semibold tracking-[-.02em] text-fg">
          Sign in to {PRODUCT_NAME}
        </h1>
        <p className="mt-2 text-[14px] text-fg-2">
          Manage your React Native OTA releases.
        </p>

        {body}

        <div className="mt-[22px] inline-flex items-center gap-[7px] rounded-pill border border-border bg-surface-2 px-3 py-[5px] font-mono text-[11.5px] text-fg-2 [&_svg]:size-[13px] [&_svg]:text-green">
          <CheckIcon /> {window.location.origin}
        </div>
      </main>
    </AuthBackdrop>
  );
}

/** Only in-app absolute paths survive (no `//host` protocol-relative escapes). */
function sanitizeReturnTo(value: string | null): string | undefined {
  if (value === null || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }
  return value;
}

function ProviderButton({
  provider,
  localDev,
  redirecting,
  disabled,
  onClick,
}: {
  provider: OAuthWebConfigProvider;
  localDev: boolean;
  redirecting: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const intent = provider.provider === "github" && !localDev ? "gh" : "primary";
  return (
    <button
      type="button"
      className={buttonVariants({ intent, size: "lg", block: true })}
      onClick={onClick}
      disabled={disabled}
      aria-busy={redirecting}
    >
      {redirecting ? (
        <>
          <span className="spinner sm" aria-hidden="true" /> Redirecting…
        </>
      ) : localDev ? (
        <>Sign in (local evaluation)</>
      ) : (
        <>
          <ProviderIcon provider={provider.provider} /> Continue with{" "}
          {providerDisplayName(provider.provider)}
        </>
      )}
    </button>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "github") {
    return <GitHubIcon />;
  }
  if (provider === "bitbucket") {
    return <BitbucketIcon />;
  }
  if (provider === "gitlab") {
    return <GitLabIcon />;
  }
  return null;
}

function GitHubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

// Bitbucket mark (fill-based, like the logo): the official 24x24 bucket path.
function BitbucketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646l3.27-20.03a.768.768 0 0 0-.768-.899zM14.52 15.53H9.522L8.17 8.466h7.561z" />
    </svg>
  );
}

function GitLabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="m23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44l-2.205 6.748H7.535L5.33 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.86.86 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.01.009.03.02 4.977 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.5-1.132 2.461-1.863 5.006-3.75.013-.01a6.068 6.068 0 0 0 2.008-7.001Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
