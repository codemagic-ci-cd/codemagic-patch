// API tokens screen.
// Account-scoped: tokens are per-user, so no team context is read. The table
// renders the server's `maskedPrefix` VERBATIM (only the masked
// prefix is ever shown — the `cpk_live_…` strings are placeholders,
// not a format contract) and, per the column list, omits the
// derived "Status" column. Create validates client-side
// (display_name required; expires_in_days empty OR an integer 1–3650) and on
// 201 swaps into the SHOW-ONCE secret modal: `disableEscapeClose`
// kills Esc/overlay/X, and the single exit ("Done") stays disabled until the
// "I've saved it" acknowledgement is checked; the copy control is the
// auto-focused element (Modal initialFocusRef). Revoke is tier-2
// type-to-confirm per the ConfirmDialog contract ("irreversible: … revoke
// token"); a 404 means the token is already gone → toast + refetch
// ("Revoke 404 if not found").

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
} from "../api/hooks/tokens";
import { HttpProblemError } from "../api/problem";
import { ConfirmDialog } from "../components/overlay/ConfirmDialog";
import { Modal } from "../components/overlay/Modal";
import { useToast } from "../components/overlay/ToastProvider";
import { CheckIcon, CopyIcon, useCopyState } from "../components/ui/Copyable";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import type { ApiTokenCreateBody, ApiTokenCreateResponse } from "../api/types";
import type { ApiTokenMetadata } from "../model/apiToken";
import { formatDate, formatRelativeTime } from "../model/format";
import { buttonVariants } from "../components/ui/Button";
import {
  CODEBLOCK,
  CODEBLOCK_COPY_BTN,
  CODEBLOCK_COPY_BTN_COPIED,
  CODEBLOCK_COPY_BTN_IDLE,
} from "../components/ui/codeblock";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
} from "../components/ui/form";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { TBL, TBL_TD, TBL_TH, TBL_TR, TBL_WRAP } from "../components/ui/table";
import { GitHubTeamIntegrationCard } from "../components/github/GitHubTeamIntegrationCard";

const EXPIRES_IN_DAYS_MAX = 3650;

export function TokensPage() {
  const toast = useToast();
  const tokensQuery = useApiTokens();
  const revoke = useRevokeApiToken();

  const [createOpen, setCreateOpen] = useState(false);
  /** Set right after a 201 — owns the non-dismissible show-once modal. */
  const [secret, setSecret] = useState<ApiTokenCreateResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenMetadata | null>(
    null,
  );

  const closeRevoke = () => {
    setRevokeTarget(null);
    revoke.reset();
  };

  const handleRevoke = () => {
    if (revokeTarget === null) {
      return;
    }
    revoke.mutate(revokeTarget.id, {
      onSuccess: () => {
        toast.success("Token revoked", {
          description: `${revokeTarget.displayName} can no longer authenticate.`,
        });
        closeRevoke();
      },
      onError: (error) => {
        // 404 = already gone server-side — tell the user and resync the list.
        if (error instanceof HttpProblemError && error.status === 404) {
          toast.error("Token not found — it may already be revoked.");
          void tokensQuery.refetch();
          closeRevoke();
        }
        // Anything else stays inline in the dialog's error slot.
      },
    });
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-3 text-[27px] font-extrabold leading-[1.1] tracking-[-.025em]">
            API tokens
          </h1>
          <p className="mt-1.5 max-w-[62ch] text-[14px] text-fg-2">
            Personal access tokens for the CLI and CI. These are per-user, not
            per-team.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            className={buttonVariants({ intent: "primary" })}
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon /> Create token
          </button>
        </div>
      </div>

      <div className={`${CALLOUT} ${CALLOUT_TONE.info} mb-[18px]`}>
        <InfoIcon />
        <div>
          Only the masked prefix is ever shown. The full token is revealed{" "}
          <b>once at creation</b> and cannot be retrieved again.
        </div>
      </div>

      {tokensQuery.isPending ? (
        <div
          className="rounded-lg border border-border bg-surface p-[22px] shadow-sm"
          role="status"
          aria-label="Loading API tokens"
        >
          <Skeleton variant="line" />
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : tokensQuery.isError ? (
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <ErrorState
            error={tokensQuery.error}
            onRetry={() => {
              void tokensQuery.refetch();
            }}
          />
        </div>
      ) : tokensQuery.data.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <EmptyState
            icon={<KeyIcon />}
            title="No API tokens yet"
            description="Create a token to authenticate the CLI or CI against this server."
            action={
              <button
                type="button"
                className={buttonVariants({ intent: "primary" })}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon /> Create token
              </button>
            }
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface shadow-sm">
          <div className={TBL_WRAP}>
            <table className={TBL}>
              <thead>
                <tr>
                  <th className={TBL_TH}>Name</th>
                  <th className={TBL_TH}>Token</th>
                  <th className={TBL_TH}>Created</th>
                  <th className={TBL_TH}>Expires</th>
                  <th className={TBL_TH}>Last used</th>
                  <th className={TBL_TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokensQuery.data.map((token) => (
                  <tr key={token.id} className={TBL_TR}>
                    <td className={TBL_TD}>
                      <span className="font-semibold">
                        {token.displayName}
                      </span>
                    </td>
                    <td className={TBL_TD}>
                      {/* Server-issued masked prefix — a truncated, non-
                          actionable fragment, so it renders as plain mono text
                          (not a copyable pill, which would imply a usable value). */}
                      <span className="font-mono text-[12.5px] font-semibold text-fg">
                        {token.maskedPrefix}
                      </span>
                    </td>
                    <td className={TBL_TD}>
                      <span
                        className="text-fg-3 text-[13px]"
                      >
                        {formatDate(token.createdAt)}
                      </span>
                    </td>
                    <td className={TBL_TD}>
                      <span
                        className="text-fg-3 text-[13px]"
                      >
                        {token.expiresAt === null
                          ? "Never"
                          : formatDate(token.expiresAt)}
                      </span>
                    </td>
                    <td className={TBL_TD}>
                      {/* Last-used is the column where recency matters most for
                          spotting stale tokens — relative time, while
                          Created/Expires stay absolute. */}
                      <span
                        className="text-fg-3 text-[13px]"
                        title={
                          token.lastUsedAt === null
                            ? undefined
                            : formatDate(token.lastUsedAt)
                        }
                      >
                        {token.lastUsedAt === null
                          ? "Never"
                          : formatRelativeTime(token.lastUsedAt)}
                      </span>
                    </td>
                    <td className={`${TBL_TD} text-right`}>
                      <button
                        type="button"
                        className={buttonVariants({ intent: "dangerGhost", size: "sm" })}
                        onClick={() => setRevokeTarget(token)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <GitHubTeamIntegrationCard />

      {/* Conditional mount resets the form state on every open. */}
      {createOpen ? (
        <CreateTokenModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            setSecret(created);
          }}
        />
      ) : null}

      {secret !== null ? (
        <TokenSecretModal secret={secret} onDone={() => setSecret(null)} />
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        variant="typeToConfirm"
        confirmationText={revokeTarget?.displayName ?? ""}
        title="Revoke token"
        description="Any CLI or CI using this token will stop working immediately."
        icon={<TrashIcon />}
        confirmLabel="Revoke token"
        busy={revoke.isPending}
        error={
          revoke.isError &&
          !(
            revoke.error instanceof HttpProblemError &&
            revoke.error.status === 404
          )
            ? problemMessage(revoke.error)
            : undefined
        }
        onCancel={closeRevoke}
        onConfirm={handleRevoke}
      >
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mb-3.5`}>
          <AlertIcon />
          <div>
            This action is <b>immediate and irreversible</b>. Pipelines that
            depend on this token will start failing. Make sure to rotate to a
            new token before revoking.
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Create modal (request side)
// ---------------------------------------------------------------------------

interface CreateTokenModalProps {
  onClose: () => void;
  onCreated: (created: ApiTokenCreateResponse) => void;
}

function CreateTokenModal({ onClose, onCreated }: CreateTokenModalProps) {
  const create = useCreateApiToken();
  const [displayName, setDisplayName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    displayName?: string;
    expiresInDays?: string;
  }>({});

  const requestClose = () => {
    if (!create.isPending) {
      onClose();
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) {
      return;
    }

    const name = displayName.trim();
    const expiryRaw = expiresInDays.trim();
    const errors: { displayName?: string; expiresInDays?: string } = {};
    if (name.length === 0) {
      errors.displayName = "Display name is required.";
    }
    // Empty = non-expiring; otherwise a whole number of days, 1–3650.
    let expiry: number | undefined;
    if (expiryRaw.length > 0) {
      const parsed = Number(expiryRaw);
      if (
        !/^\d+$/.test(expiryRaw) ||
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > EXPIRES_IN_DAYS_MAX
      ) {
        errors.expiresInDays = `Enter a whole number between 1 and ${EXPIRES_IN_DAYS_MAX}, or leave empty.`;
      } else {
        expiry = parsed;
      }
    }
    setFieldErrors(errors);
    if (errors.displayName !== undefined || errors.expiresInDays !== undefined) {
      return;
    }

    const body: ApiTokenCreateBody = { display_name: name };
    if (expiry !== undefined) {
      body.expires_in_days = expiry;
    }
    create.mutate(body, {
      onSuccess: (created) => onCreated(created),
    });
  };

  return (
    <Modal
      open
      onClose={requestClose}
      title="Create API token"
      description="The full token is shown only once after creation."
      icon={<KeyIcon />}
      footer={
        <>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle" })}
            onClick={requestClose}
            disabled={create.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-token-form"
            className={buttonVariants({ intent: "primary" })}
            disabled={create.isPending}
            aria-busy={create.isPending || undefined}
          >
            {create.isPending ? (
              <span className="spinner sm" aria-hidden="true" />
            ) : null}
            Create token
          </button>
        </>
      }
    >
      <form id="create-token-form" onSubmit={handleSubmit} noValidate>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Display name</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. My Laptop or GitHub Actions CI"
            autoComplete="off"
            aria-invalid={fieldErrors.displayName !== undefined || undefined}
          />
          {fieldErrors.displayName !== undefined ? (
            <span className={FIELD_ERR} role="alert">
              {fieldErrors.displayName}
            </span>
          ) : null}
        </label>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>Expires in (days)</span>
          <input
            className={`${INPUT} ${INPUT_STATE.normal}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={EXPIRES_IN_DAYS_MAX}
            step={1}
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
            placeholder="365"
            aria-invalid={fieldErrors.expiresInDays !== undefined || undefined}
          />
          {fieldErrors.expiresInDays !== undefined ? (
            <span className={FIELD_ERR} role="alert">
              {fieldErrors.expiresInDays}
            </span>
          ) : (
            <span className={FIELD_HINT}>
              Leave empty for a non-expiring token · max {EXPIRES_IN_DAYS_MAX}{" "}
              days
            </span>
          )}
        </label>
        {create.isError ? (
          <div className={`${CALLOUT} ${CALLOUT_TONE.danger}`} role="alert">
            <AlertIcon />
            <div>{problemMessage(create.error)}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Show-once secret modal (reveal side)
// ---------------------------------------------------------------------------

interface TokenSecretModalProps {
  secret: ApiTokenCreateResponse;
  onDone: () => void;
}

function TokenSecretModal({ secret, onDone }: TokenSecretModalProps) {
  const { state, copy } = useCopyState();
  const [acknowledged, setAcknowledged] = useState(false);
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);
  const codeRef = useRef<HTMLElement | null>(null);

  // Clipboard fallback (browser capability fallbacks): the full token
  // is already visible inside the codeblock — auto-select it on entering the
  // fallback state (clipboard missing OR write rejected) so a manual copy is
  // one keystroke, mirroring Copyable's auto-selected input.
  useEffect(() => {
    if (state === "fallback") {
      selectNodeContents(codeRef.current);
    }
  }, [state]);

  const handleCopy = () => {
    if (state === "fallback") {
      // Clipboard already proved unavailable — just re-select for manual copy.
      selectNodeContents(codeRef.current);
      return;
    }
    void copy(secret.token);
  };

  const copied = state === "copied";

  return (
    <Modal
      open
      // Unreachable while disableEscapeClose hides every dismissal path; the
      // dialog only closes through the acknowledged "Done" button below.
      onClose={() => {}}
      disableEscapeClose
      title="Copy your new token"
      description="This is the only time the full token is shown."
      icon={<KeyIcon />}
      tone="green"
      initialFocusRef={copyButtonRef}
      footer={
        <button
          type="button"
          className={buttonVariants({ intent: "primary" })}
          disabled={!acknowledged}
          onClick={onDone}
        >
          I&rsquo;ve copied it — done
        </button>
      }
    >
      <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mb-3.5`}>
        <AlertIcon />
        <div>
          <b>Store this token now.</b> Once you close this dialog it cannot be
          retrieved — you will need to create a new token.
        </div>
      </div>
      <div className={CODEBLOCK}>
        <button
          type="button"
          ref={copyButtonRef}
          className={`${CODEBLOCK_COPY_BTN} ${
            copied ? CODEBLOCK_COPY_BTN_COPIED : CODEBLOCK_COPY_BTN_IDLE
          }`}
          aria-label="Copy token to clipboard"
          onClick={handleCopy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <code ref={codeRef}>
          {secret.token}
        </code>
      </div>
      <span role="status" className="sr-only">
        {copied
          ? "Copied to clipboard"
          : state === "fallback"
            ? "Clipboard unavailable — token selected, copy it manually"
            : ""}
      </span>
      <label className="mt-3.5 flex items-center gap-2.5 text-[13px] font-semibold">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I&rsquo;ve saved it — this token won&rsquo;t be shown again
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Selects a node's full text content (manual-copy fallback). */
function selectNodeContents(node: HTMLElement | null): void {
  const selection = window.getSelection();
  if (node === null || selection === null) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Inline problem copy for modal error slots (most specific text wins). */
function problemMessage(error: unknown): string {
  if (error instanceof HttpProblemError) {
    return error.detail ?? error.title ?? "The request was rejected.";
  }
  return "The request failed. Check your connection and try again.";
}

// Icon paths use lucide-style glyphs (`plus`, `key`, `info`, `alert`, `trash`).

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

function PlusIcon() {
  return (
    <IconSvg>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </IconSvg>
  );
}

function KeyIcon() {
  return (
    <IconSvg>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 8.8-8.8M16 6l3 3M14 8l2 2" />
    </IconSvg>
  );
}

function InfoIcon() {
  return (
    <IconSvg>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="12" y1="8" x2="12" y2="8" />
    </IconSvg>
  );
}

function AlertIcon() {
  return (
    <IconSvg>
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </IconSvg>
  );
}

function TrashIcon() {
  return (
    <IconSvg>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </IconSvg>
  );
}
