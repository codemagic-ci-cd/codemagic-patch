// Local evaluation consent page — the same-origin stand-in for GitHub's
// authorize screen, registered at /login/oauth/authorize (the fixed path
// buildAuthorizeUrl appends, so `authorize_base_url: ""` lands here). It
// renders ONLY when the server's web-config reports `mode: "local-dev"`;
// against any other server the route shows a standalone 404 card, so the
// page ships inert in the production bundle (the server, not the client, is
// the security boundary — same trust model as the server's entrypoint split).
//
// Flow: read `state` / `redirect_uri` (+ `code_challenge`, accepted unused —
// the local adapter doesn't check PKCE; there is no secret to protect) from
// the authorize query, collect an email (any email — multi-user evaluation is
// intentional), and redirect back to the callback with `code=local:<email>`.
// From /auth/callback onward the flow is byte-identical to production.

import { useState } from "react";

import { useWebConfig } from "../api/hooks/webConfig";
import { callbackRedirectUri, isLocalDevMode } from "../auth/webConfig";
import { PRODUCT_NAME } from "../branding";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { FIELD, FIELD_LABEL, INPUT, INPUT_STATE } from "../components/ui/form";

const DEFAULT_EMAIL = "local-admin@example.com";

export function LocalConsentPage() {
  const configQuery = useWebConfig();
  const [email, setEmail] = useState(DEFAULT_EMAIL);

  // Derived at render time from the authorize query (no router state).
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state");
  const redirectUri = sanitizeRedirectUri(params.get("redirect_uri"));

  if (configQuery.isPending) {
    return (
      <AuthBackdrop>
        <main className="relative z-[2] text-center text-white" role="status">
          <div className="spinner" aria-hidden="true" />
          <p className="mt-2 text-[14px] text-[rgba(255,255,255,.6)]">
            Checking sign-in configuration…
          </p>
        </main>
      </AuthBackdrop>
    );
  }

  // Not the local evaluation stack (GitHub mode, unconfigured, or the config
  // fetch failed) → this route does not exist.
  if (configQuery.isError || !isLocalDevMode(configQuery.data)) {
    return (
      <AuthBackdrop>
        <main className="relative z-[2] w-full max-w-[430px] rounded-xl bg-surface p-[38px] text-center shadow-lg [animation:rise_.3s_ease_both]">
          <h1 className="text-[23px] font-extrabold tracking-[-.02em]">
            Page not found
          </h1>
          <p className="mt-2 text-[14px] text-fg-2">
            That route doesn&apos;t exist on this server.
          </p>
        </main>
      </AuthBackdrop>
    );
  }

  // Reached without authorize params. The one realistic way here is the
  // device-flow verification URL `cmpatch login` prints (bare, no state) —
  // and in local evaluation mode device sign-ins are approved automatically,
  // so there is nothing to do on this page. Say that instead of an error.
  if (state === null || redirectUri === null) {
    return (
      <AuthBackdrop>
        <main className="relative z-[2] w-full max-w-[430px] rounded-xl bg-surface p-[38px] text-center shadow-lg [animation:rise_.3s_ease_both]">
          <h1 className="text-[23px] font-extrabold tracking-[-.02em]">
            Nothing to approve here
          </h1>
          <p className="mt-2 text-[14px] text-fg-2">
            In local evaluation mode, CLI device sign-ins are approved
            automatically — if you followed a link printed by{" "}
            <code>cmpatch login</code>, you are already signed in; return to
            your terminal. Browser sign-in starts from the login screen.
          </p>
          <a
            className={`${buttonVariants({ intent: "primary", block: true })} mt-6`}
            href="/login"
          >
            Go to sign-in
          </a>
        </main>
      </AuthBackdrop>
    );
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) {
      return;
    }
    const query = new URLSearchParams({
      code: `local:${trimmed}`,
      state,
    });
    window.location.href = `${redirectUri}?${query.toString()}`;
  };

  return (
    <AuthBackdrop>
      <main className="relative z-[2] w-full max-w-[430px] rounded-xl bg-surface p-[38px] text-center shadow-lg [animation:rise_.3s_ease_both]">
        <h1 className="text-[23px] font-extrabold tracking-[-.02em]">
          Local evaluation sign-in
        </h1>
        <p className="mt-2 text-[14px] text-fg-2">
          This stack runs {PRODUCT_NAME} in local evaluation mode, so this page
          replaces GitHub sign-in. Enter any email to sign in as that user.
        </p>

        <div
          className={`${CALLOUT} ${CALLOUT_TONE.warn} text-left mt-6`}
          role="note"
        >
          <div>
            Authentication is disabled — anyone who can reach this instance can
            sign in. Never expose it beyond your machine.
          </div>
        </div>

        <form className="mt-6 text-left" onSubmit={handleSubmit}>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>Email</span>
            <input
              className={`${INPUT} ${INPUT_STATE.normal}`}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="off"
              required
            />
          </label>
          <button
            type="submit"
            className={buttonVariants({ intent: "primary", size: "lg", block: true })}
          >
            Sign in
          </button>
        </form>
      </main>
    </AuthBackdrop>
  );
}

/**
 * Only the SPA's own callback may receive the code. The allowlist is exactly
 * what buildAuthorizeUrl sends (callbackRedirectUri); anything else (foreign
 * origin, other path) would make this page an open redirector inside the
 * production bundle.
 */
function sanitizeRedirectUri(value: string | null): string | null {
  return value === callbackRedirectUri() ? value : null;
}

/** The starfield auth backdrop shared by the login/callback pages. */
function AuthBackdrop({ children }: { children: React.ReactNode }) {
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
      {children}
    </div>
  );
}
