// OAuth callback (error mapping). Full-page "Signing you in…" spinner while the mount
// effect parses `?code&state` and runs exchangeCallback; success navigates to
// the stashed returnTo ?? "/" (replace, so Back never re-runs the exchange).
// A run-once ref guards the exchange against React StrictMode's double
// effect — the PKCE stash is single-use, so a second run would always fail.
//
// Errors render the error card with DISTINCT messages and no retry
// loop: invalid state, 401 code-rejected, 403 account-disabled
// (suspension), 403 registration-closed (invite-only — discriminated via
// extensions.outcome by classifyProblem), 409 identity conflict
// (contact support), 501 server misconfiguration, 503 provider failure, and
// network failure. Every error offers a "Back to sign-in" link; retrying
// means restarting the flow from /login because the authorization code and
// the PKCE verifier are both single-use (the stash is consumed even on
// failure). An authorize denial (`?error=` without a code) is bounced to
// /login?error=… — the login screen owns that banner.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { classifyProblem, HttpProblemError } from "../api/problem";
import { exchangeCallback, InvalidSignInStateError } from "../auth/webConfig";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { MODAL_ICON, MODAL_ICON_TONE } from "../components/overlay/Modal";

export function CallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  // StrictMode runs the mount effect twice on the same instance; the PKCE
  // stash (and the GitHub code) are single-use, so the exchange must not.
  const exchangeStartedRef = useRef(false);

  // Derived at render time (no effect setState): landing here without
  // `?code&state` and without a provider `?error=` is an invalid sign-in
  // state — the card shows immediately, before any effect runs.
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const providerError = searchParams.get("error");
  const missingParamsError =
    code === null || state === null
      ? providerError === null
        ? INVALID_STATE_MESSAGE
        : null
      : null;

  useEffect(() => {
    if (exchangeStartedRef.current) {
      return;
    }
    exchangeStartedRef.current = true;

    if (code === null || state === null) {
      if (providerError !== null) {
        // GitHub denied/failed before issuing a code → login-screen banner.
        void navigate(`/login?error=${encodeURIComponent(providerError)}`, {
          replace: true,
        });
      }
      // Otherwise the render path already shows the invalid-state card.
      return;
    }

    exchangeCallback({ code, state })
      .then(({ returnTo }) => {
        void navigate(sanitizeReturnTo(returnTo) ?? "/", { replace: true });
      })
      .catch((error: unknown) => {
        setExchangeError(callbackErrorMessage(error));
      });
  }, [code, state, providerError, navigate]);

  const errorMessage = exchangeError ?? missingParamsError;

  if (errorMessage !== null) {
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
          <div
            className={`${MODAL_ICON} ${MODAL_ICON_TONE.danger} mx-auto mb-[18px]`}
            // size/radius OVERRIDE MODAL_ICON's size-[42px]/rounded-[12px];
            // two conflicting utilities cannot co-apply, so the override stays
            // inline (no-merge contract — this is the one MODAL_ICON borrow).
            style={{ width: 52, height: 52, borderRadius: 14 }}
            aria-hidden="true"
          >
            <AlertIcon size={24} />
          </div>
          <h1 className="text-[23px] font-extrabold tracking-[-.02em]">
            Sign-in failed
          </h1>
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.danger} text-left mt-4`}
            role="alert"
          >
            <AlertIcon />
            <div>{errorMessage}</div>
          </div>
          <Link
            className={`${buttonVariants({ intent: "ghost", block: true })} mt-[18px]`}
            to="/login"
          >
            <ChevronLeftIcon /> Back to sign-in
          </Link>
        </main>
      </div>
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

      <main className="relative z-[2] text-center text-white" role="status">
        <div className="spinner" aria-hidden="true" />
        <h2 className="text-[20px] font-extrabold tracking-[-.02em]">
          Signing you in…
        </h2>
        <p className="mt-2 text-[14px] text-[rgba(255,255,255,.6)]">
          Exchanging the authorization code for a session.
        </p>
      </main>
    </div>
  );
}

const INVALID_STATE_MESSAGE = "Invalid sign-in state, try again.";

/**
 * In local dev the PKCE stash lives in sessionStorage (origin-scoped), so
 * starting sign-in on localhost and finishing on 127.0.0.1 (or vice versa)
 * silently loses it and surfaces the invalid-state error. Only on those hosts
 * is the swap possible, so scope the hint to them (production has one origin).
 */
function localhostMismatchHint(): string {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    return " If you switched between localhost and 127.0.0.1, reopen the dashboard on the same address and sign in again.";
  }
  return "";
}

/**
 * Distinct message per error row. HttpProblemError is classified
 * first (registration-closed / account-disabled / provider failure carry
 * type-suffix or extensions semantics), then the remaining rows key off the
 * HTTP status — the 409 identity conflict and the 501 missing-adapter
 * problems are suffix-less, so status is their only discriminator.
 */
function callbackErrorMessage(error: unknown): string {
  if (error instanceof InvalidSignInStateError) {
    return INVALID_STATE_MESSAGE + localhostMismatchHint();
  }
  if (error instanceof HttpProblemError) {
    switch (classifyProblem(error)) {
      case "registration-closed":
        return "This server is invite-only — ask a team admin to invite your email, then sign in again.";
      case "account-disabled":
        return "Your account has been disabled — contact an administrator to restore access.";
      case "provider-unavailable":
        return "Sign-in temporarily unavailable — try again.";
      default:
        break;
    }
    switch (error.status) {
      case 401:
        return "Sign-in failed — your authorization code was rejected. Try again.";
      case 409:
        return "Sign-in failed — your GitHub identity conflicts with an existing account. Contact support.";
      case 501:
        return "Browser sign-in is not enabled on this server — a server misconfiguration. Contact your administrator.";
      case 503:
        return "Sign-in temporarily unavailable — try again.";
      default:
        return error.detail ?? "Sign-in failed — try again.";
    }
  }
  return "We couldn't reach the server — check your connection and try signing in again.";
}

/** Only in-app absolute paths survive (no `//host` protocol-relative escapes). */
function sanitizeReturnTo(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return undefined;
  }
  return value;
}

// Icon paths mirror the shared icon set (`alert`, `chevLeft`).
function AlertIcon({ size }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={size === undefined ? undefined : { width: size, height: size }}
    >
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </svg>
  );
}

function ChevronLeftIcon() {
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
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
