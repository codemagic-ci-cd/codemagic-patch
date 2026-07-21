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
  startLogin,
} from "../auth/webConfig";
import { PRODUCT_NAME } from "../branding";
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
    <div className="auth-art relative min-h-screen place-items-center overflow-hidden bg-[radial-gradient(120%_80%_at_50%_-10%,#0d122b,var(--color-sb-bg)_60%)] p-6 [display:grid]">
      <span
        className="absolute -left-[120px] -top-[180px] size-[560px] rounded-full bg-blue opacity-35 blur-[90px]"
        aria-hidden="true"
      />
      <span
        className="absolute -bottom-[220px] -right-[140px] size-[560px] rounded-full bg-magenta opacity-22 blur-[90px]"
        aria-hidden="true"
      />

      <main className="relative z-[2] w-full max-w-[430px] rounded-xl bg-surface p-[38px] text-center shadow-lg [animation:rise_.3s_ease_both]">
        <span className="mx-auto mb-5 size-[54px] flex-none place-items-center rounded-[16px] bg-[linear-gradient(135deg,var(--color-blue),var(--color-aqua))] shadow-[0_6px_18px_-4px_rgba(0,81,255,.7)] [display:grid] [&_svg]:size-[30px]">
          <LogoIcon />
        </span>
        <h1 className="text-[23px] font-extrabold tracking-[-.02em]">
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
    </div>
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
  const intent =
    localDev || provider.provider === "bitbucket" ? "primary" : "gh";
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
          {providerLabel(provider.provider)}
        </>
      )}
    </button>
  );
}

/** Login-button label; unknown providers get a capitalized fallback. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "bitbucket":
      return "Bitbucket";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "github") {
    return <GitHubIcon />;
  }
  if (provider === "bitbucket") {
    return <BitbucketIcon />;
  }
  return null;
}

// Logo markup (fill-based, unlike shell icons).
function LogoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.2l2.2 6.1 6.1 2.2-6.1 2.2L12 18.8l-2.2-6.1L3.7 10.5l6.1-2.2z"
        fill="#fff"
      />
      <circle cx="18.5" cy="5.5" r="1.6" fill="#fff" opacity=".85" />
    </svg>
  );
}

// Icon paths mirror the shared icon set (`github`, `check`, `alert`,
// `refresh`).
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
