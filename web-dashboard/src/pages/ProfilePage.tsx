// Profile / whoami screen. Identity comes from `useMe()` (`GET /v1/users/me`);
// the displayed name falls back to the email when `displayName` is null.
// Sign-out is best-effort: `logoutSession()` always clears local
// credentials even when the server-side revoke fails, then we navigate to
// /login. The narrow
// content column is approximated with an inner max-width wrapper
// because AppShell owns the `.content` element for every routed page.

import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ReactNode } from "react";

import { useMe } from "../api/hooks/me";
import { logoutSession } from "../auth/webConfig";
import { avatarClass } from "../components/ui/avatar";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { Copyable } from "../components/ui/Copyable";
import { DL, DL_DT, DL_DD } from "../components/ui/dl";
import { ErrorState } from "../components/ui/ErrorState";
import { PageHeader } from "../components/ui/PageHeader";
import { Skeleton } from "../components/ui/Skeleton";
import { SECTION_TITLE } from "../components/ui/typography";
import { formatDate } from "../model/format";
import type { User } from "../model/user";
import { buttonVariants } from "../components/ui/Button";
import { ThemeSwitch } from "../theme/ThemeSwitch";

export function ProfilePage() {
  const meQuery = useMe();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await logoutSession();
    } finally {
      // Best-effort revoke: redirect even if the token was already invalid.
      void navigate("/login");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[920px]">
      <PageHeader
        title="Profile"
        description="Your personal account details and active sessions."
      />

      {meQuery.isPending ? (
        <div
          className="mb-[18px] rounded-lg border border-border bg-surface p-[22px] shadow-sm"
          role="status"
          aria-label="Loading profile"
        >
          <div className="mb-5 flex items-center gap-4">
            <Skeleton width={56} height={56} />
            <div className="min-w-0">
              <Skeleton width={160} variant="text" />
              <Skeleton width={200} variant="text" />
            </div>
          </div>
          <Skeleton variant="line" />
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : meQuery.isError ? (
        <div className="mb-[18px] rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <ErrorState
            error={meQuery.error}
            onRetry={() => {
              void meQuery.refetch();
            }}
          />
        </div>
      ) : (
        <IdentityCard user={meQuery.data} />
      )}

      <div className="mb-[18px] rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <div className={`${SECTION_TITLE} mb-[18px]`}>
          Sessions
        </div>
        <p className="text-fg-2 mb-4 text-[13px]">
          Signing out revokes the current session token and redirects to the
          login page. The request is best-effort — you are redirected even if
          the token was already invalid or expired.
        </p>
        <button
          type="button"
          className={buttonVariants({ intent: "dangerGhost" })}
          disabled={signingOut}
          aria-busy={signingOut || undefined}
          onClick={() => {
            void handleSignOut();
          }}
        >
          <LogoutIcon /> {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      <div className="mb-[18px] rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <div className={`${SECTION_TITLE} mb-[18px]`}>Appearance</div>
        <p className="text-fg-2 mb-4 text-[13px]">
          Light, Dark, or match the operating system. The choice is stored in
          this browser only.
        </p>
        <ThemeSwitch />
      </div>

      <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <div className="flex items-center justify-between gap-3.5">
          <div>
            <div className={`${SECTION_TITLE} mb-1`}>API tokens</div>
            <p className="text-fg-3 mt-1 text-[13px]">
              Create and manage personal access tokens for CLI and CI use.
            </p>
          </div>
          <Link className={buttonVariants({ intent: "ghost" })} to="/account/tokens">
            Manage tokens <ArrowRightIcon />
          </Link>
        </div>
      </div>
    </div>
  );
}

function IdentityCard({ user }: { user: User }) {
  // `displayName ?? email` is the identity fallback.
  const displayName = user.displayName ?? user.email;

  return (
    <div className="mb-[18px] rounded-lg border border-border bg-surface p-[22px] shadow-sm">
      <div className="mb-5 flex items-center gap-4">
        <span className={avatarClass("lg")} aria-hidden="true">
          {initials(user)}
        </span>
        <div>
          <div className="text-[18px] font-semibold tracking-[-.02em] text-fg">
            {displayName}
          </div>
          <div className="text-fg-3 mt-0.5 text-[13px]">
            {user.email}
          </div>
        </div>
      </div>
      <dl className={DL}>
        <dt className={DL_DT}>User ID</dt>
        <dd className={DL_DD}>
          <Copyable value={user.id} label="user_id" ariaLabel="Copy user ID" />
        </dd>
        <dt className={DL_DT}>Email</dt>
        <dd className={DL_DD}>{user.email}</dd>
        <dt className={DL_DT}>Display name</dt>
        <dd className={DL_DD}>
          {/* Fallback: the email stands in when no display name is set. */}
          {user.displayName ?? <span className="text-fg-3">{user.email}</span>}
        </dd>
        <dt className={DL_DT}>Auth provider</dt>
        <dd className={DL_DD}>
          {user.oauthProvider === null ? (
            <span className="text-fg-3">—</span>
          ) : (
            <span className={`${CHIP} ${CHIP_TONE.neutral}`}>
              {user.oauthProvider === "github" ? <GithubIcon /> : null}
              {providerLabel(user.oauthProvider)}
            </span>
          )}
        </dd>
        <dt className={DL_DT}>Status</dt>
        <dd className={DL_DD}>
          {user.status === "active" ? (
            <span className={`${CHIP} ${CHIP_TONE.green}`}>Active</span>
          ) : (
            <span className={`${CHIP} ${CHIP_TONE.red}`}>Disabled</span>
          )}
        </dd>
        <dt className={DL_DT}>Created</dt>
        <dd className={DL_DD}>
          {formatDate(user.createdAt)}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function providerLabel(provider: string): string {
  return provider === "github" ? "GitHub" : provider;
}

/** Up to two initials from `displayName ?? email` (email → its local part). */
function initials(user: User): string {
  const atIndex = user.email.indexOf("@");
  const source =
    user.displayName ??
    (atIndex > 0 ? user.email.slice(0, atIndex) : user.email);
  const words = source
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) {
    return "?";
  }
  const second = words[1];
  if (second === undefined) {
    return first.slice(0, 2).toUpperCase();
  }
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

// Icon paths use lucide-style glyphs (`logout`, `key`, `arrowRight`, `github`).

function IconSvg({ children }: { children: ReactNode }) {
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
      {children}
    </svg>
  );
}

function LogoutIcon() {
  return (
    <IconSvg>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </IconSvg>
  );
}

function ArrowRightIcon() {
  return (
    <IconSvg>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </IconSvg>
  );
}

function GithubIcon() {
  return (
    <IconSvg>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </IconSvg>
  );
}
