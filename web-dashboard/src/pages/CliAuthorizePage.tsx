// CLI loopback approve page (session-gated under RequireAuth, rendered as a
// bare auth card — no AppShell chrome, matching the login/callback pages: the
// visitor is mid-flow in a terminal, not navigating the dashboard). The CLI
// opens `/cli/authorize?port&code_challenge&state`; RequireAuth's returnTo
// round-trip preserves that query across a sign-in. Approving asks the server
// for a short-TTL authorization code bound to the CLI's PKCE challenge and
// loopback port, then redirects the browser to the CLI's 127.0.0.1 listener.
// Denying redirects with `error=access_denied` so the CLI stops waiting
// immediately. The redirect target is constructed ONLY from the validated
// port — never from a caller-supplied URL — so this page cannot be used as an
// open redirector.

import { useState } from "react";
import { useSearchParams } from "react-router";

import { authenticatedRequest } from "../api/client";
import {
  fromCliAuthorizationWire,
  toCliAuthorizationWireBody,
  type CliAuthorizationWireResponse,
} from "../api/wire";
import { useSession } from "../auth/AuthProvider";
import { PRODUCT_NAME } from "../branding";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import type { CliAuthorizationBody } from "../api/types";

/** RFC 7636 S256 challenge shape (base64url of SHA-256 → 43 chars; ≤128 per spec). */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
/** CLI-generated CSRF state: base64url, bounded so the redirect URL stays sane. */
const STATE_PATTERN = /^[A-Za-z0-9\-._~]{1,256}$/;

const ISSUE_FAILED_MESSAGE =
  "Couldn't authorize the CLI — try approving again.";
const INVALID_REQUEST_MESSAGE =
  "This CLI sign-in link is incomplete or malformed. Re-run `cmpatch login` and use the link it opens.";

interface CliAuthorizeRequest {
  codeChallenge: string;
  port: number;
  state: string;
}

type Phase = "idle" | "approving" | "redirecting" | "denied";

export function CliAuthorizePage() {
  const { user } = useSession();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>("idle");
  const [issueError, setIssueError] = useState(false);

  const request = parseCliAuthorizeRequest(searchParams);

  const handleApprove = async () => {
    if (request === null || phase !== "idle") {
      return;
    }
    setIssueError(false);
    setPhase("approving");
    try {
      const issued = await authenticatedRequest<CliAuthorizationWireResponse>({
        method: "POST",
        path: "/auth/cli/authorizations",
        body: toCliAuthorizationWireBody({
          codeChallenge: request.codeChallenge,
          port: request.port,
        } satisfies CliAuthorizationBody),
      }).then(fromCliAuthorizationWire);
      setPhase("redirecting");
      window.location.assign(
        loopbackCallbackUrl(request.port, {
          code: issued.code,
          state: request.state,
        }),
      );
    } catch {
      setPhase("idle");
      setIssueError(true);
    }
  };

  const handleDeny = () => {
    if (request === null || phase !== "idle") {
      return;
    }
    setPhase("denied");
    window.location.assign(
      loopbackCallbackUrl(request.port, {
        error: "access_denied",
        state: request.state,
      }),
    );
  };

  let body;
  if (request === null) {
    body = (
      <div
        className={`${CALLOUT} ${CALLOUT_TONE.danger} text-left mt-6`}
        role="alert"
      >
        <AlertIcon />
        <div>{INVALID_REQUEST_MESSAGE}</div>
      </div>
    );
  } else if (phase === "redirecting" || phase === "denied") {
    body = (
      <div role="status" className="mt-7">
        <div className="spinner blue" aria-hidden="true" />
        <p className="text-fg-3 text-[13px]">
          {phase === "denied"
            ? "Telling the CLI the request was denied…"
            : "Sending you back to the CLI…"}
        </p>
        <p className="mt-3 text-[12px]/[1.6] text-fg-3">
          You can close this tab and return to the terminal.
        </p>
      </div>
    );
  } else {
    body = (
      <>
        {issueError ? (
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.danger} text-left mt-6`}
            role="alert"
          >
            <AlertIcon />
            <div>{ISSUE_FAILED_MESSAGE}</div>
          </div>
        ) : null}
        <p className="mt-4 text-[14px]/[1.6] text-fg-2">
          A terminal on your machine is asking to sign in to {PRODUCT_NAME}
          {user !== null ? (
            <>
              {" "}
              as <strong className="text-fg-1">{user.email}</strong>
            </>
          ) : null}
          . Only approve if you just ran{" "}
          <code className="font-mono text-[12.5px]">cmpatch login</code>{" "}
          yourself.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            className={buttonVariants({ intent: "primary", size: "lg", block: true })}
            onClick={() => {
              void handleApprove();
            }}
            disabled={phase !== "idle"}
            aria-busy={phase === "approving"}
          >
            {phase === "approving" ? (
              <>
                <span className="spinner sm" aria-hidden="true" /> Authorizing…
              </>
            ) : (
              <>Approve CLI sign-in</>
            )}
          </button>
          <button
            type="button"
            className={buttonVariants({ intent: "ghost", block: true })}
            onClick={handleDeny}
            disabled={phase !== "idle"}
          >
            Deny
          </button>
        </div>
        <p className="mt-4 text-[12px]/[1.6] text-fg-3">
          Approving redirects your browser to the CLI&apos;s local listener at
          127.0.0.1:{request.port} with a short-lived sign-in code that only
          the requesting CLI can redeem and that expires in about a minute.
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
          <TerminalIcon />
        </span>
        <h1 className="text-[23px] font-extrabold tracking-[-.02em]">
          Sign in the {PRODUCT_NAME} CLI?
        </h1>

        {body}

        <div className="mt-[22px] inline-flex items-center gap-[7px] rounded-pill border border-border bg-surface-2 px-3 py-[5px] font-mono text-[11.5px] text-fg-2 [&_svg]:size-[13px] [&_svg]:text-green">
          <CheckIcon /> {window.location.origin}
        </div>
      </main>
    </div>
  );
}

function parseCliAuthorizeRequest(
  searchParams: URLSearchParams,
): CliAuthorizeRequest | null {
  const codeChallenge = searchParams.get("code_challenge");
  const state = searchParams.get("state");
  const port = parseLoopbackPort(searchParams.get("port"));

  if (
    codeChallenge === null ||
    !CODE_CHALLENGE_PATTERN.test(codeChallenge) ||
    state === null ||
    !STATE_PATTERN.test(state) ||
    port === null
  ) {
    return null;
  }

  return { codeChallenge, port, state };
}

function parseLoopbackPort(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

function loopbackCallbackUrl(
  port: number,
  params: Record<string, string>,
): string {
  return `http://127.0.0.1:${port}/callback?${new URLSearchParams(params).toString()}`;
}

// Icon paths mirror the shared icon set.
function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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
