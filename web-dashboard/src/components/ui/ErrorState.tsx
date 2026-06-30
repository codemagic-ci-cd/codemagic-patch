// Error-state region (mandatory screen state). HttpProblemError
// instances are classified via the shared `classifyProblem`; everything else
// (network failures, render crashes) gets the generic retryable copy.
// Layout renders through the EmptyState shell with the danger icon tone;
// `role="alert"` makes blocking errors assertive.

import { classifyProblem, HttpProblemError } from "../../api/problem";
import type { ProblemBehavior } from "../../api/problem";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

interface BehaviorCopy {
  headline: string;
  description: string;
  /** False suppresses the Retry button (no retry loop rows). */
  retryable: boolean;
}

// One row per ProblemBehavior value — the Record errors on drift when
// api/problem.ts gains or renames a behavior.
const BEHAVIOR_COPY: Record<ProblemBehavior, BehaviorCopy> = {
  "session-expired": {
    headline: "Session expired",
    description: "Sign in again to continue.",
    retryable: false,
  },
  "account-disabled": {
    headline: "Account or team disabled",
    description: "Contact an administrator to restore access.",
    retryable: false,
  },
  "registration-closed": {
    headline: "This server is invite-only",
    description: "Ask an admin to invite your email address.",
    retryable: false,
  },
  forbidden: {
    headline: "Permission required",
    description: "Your role doesn't allow this action.",
    retryable: false,
  },
  "not-found": {
    headline: "Not found or no access",
    description: "It may have been deleted, or you may not have access.",
    retryable: false,
  },
  "configuration-error": {
    headline: "Server not configured",
    description: "Web sign-in isn't configured on this server.",
    retryable: true,
  },
  "validation-error": {
    headline: "Request rejected",
    description: "The request failed validation.",
    retryable: false,
  },
  "status-transition-conflict": {
    headline: "Status changes can't be combined with edits",
    description: "Apply the status change on its own.",
    retryable: false,
  },
  "invalid-status-transition": {
    headline: "Not allowed in the current state",
    description: "The current release status doesn't permit this change.",
    retryable: false,
  },
  "blocking-job": {
    headline: "Another release job is in progress",
    description: "Wait for the active job to finish, then retry.",
    retryable: true,
  },
  "release-conflict": {
    headline: "Blocked by an active rollout",
    description: "An active partial rollout blocks this operation.",
    retryable: false,
  },
  "duplicate-release": {
    headline: "Identical release already exists",
    description: "The destination already has this content.",
    retryable: false,
  },
  "rollback-no-op": {
    headline: "Target content already live",
    description: "There is nothing to roll back to.",
    retryable: false,
  },
  "name-conflict": {
    headline: "Name already exists",
    description: "Choose a different name.",
    retryable: false,
  },
  "last-owner": {
    headline: "Can't remove the last owner",
    description: "Assign another owner first.",
    retryable: false,
  },
  "invitation-conflict": {
    headline: "Invitation conflict",
    description: "The invitation changed — refresh and try again.",
    retryable: false,
  },
  "role-not-supported": {
    headline: "Role unavailable",
    description: "The selected role isn't supported by this server.",
    retryable: false,
  },
  "idempotency-retry": {
    headline: "Still processing",
    description: "A previous attempt of this request is still being processed.",
    retryable: true,
  },
  "idempotency-mismatch": {
    headline: "Conflicting request",
    description: "A different request already used this idempotency key.",
    retryable: false,
  },
  "rate-limited": {
    headline: "Too many requests",
    description: "Wait a moment before trying again.",
    retryable: true,
  },
  "provider-unavailable": {
    headline: "Sign-in temporarily unavailable",
    description: "GitHub couldn't be reached — try again shortly.",
    retryable: true,
  },
  retryable: {
    headline: "Server error",
    description: "Something went wrong on the server.",
    retryable: true,
  },
  generic: {
    headline: "Something went wrong",
    description: "The request couldn't be completed.",
    retryable: true,
  },
};

const UNKNOWN_ERROR_COPY: BehaviorCopy = {
  headline: "Something went wrong",
  description:
    "An unexpected error occurred. Check your connection and try again.",
  retryable: true,
};

// Icon paths render the `alert` and `refresh` glyphs.
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

export interface ErrorStateProps {
  /** Anything thrown: HttpProblemError renders classified copy, the rest generic. */
  error: unknown;
  /** Renders a Retry button when provided AND the error class allows retry. */
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  let copy = UNKNOWN_ERROR_COPY;
  let description = UNKNOWN_ERROR_COPY.description;
  if (error instanceof HttpProblemError) {
    copy = BEHAVIOR_COPY[classifyProblem(error)];
    // Server-provided detail is the most specific context when present.
    description = error.detail ?? copy.description;
  }

  return (
    <EmptyState
      role="alert"
      tone="danger"
      icon={<AlertIcon />}
      title={copy.headline}
      description={description}
      action={
        copy.retryable && onRetry !== undefined ? (
          <Button intent="ghost" onClick={onRetry}>
            <RefreshIcon /> Retry
          </Button>
        ) : null
      }
    />
  );
}
