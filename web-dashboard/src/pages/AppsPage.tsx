// App list screen. Data-backed columns
// only: the App DTO carries no deployment count / platform / per-app metrics,
// so the "Deployments", "Active users" and "30-day success" columns
// (and the platform filter) are omitted — columns are App
// (name → detail link), Code signing (`.pin.sign` / `.chip outline`), and
// Created. "Create app" is gated `app.create`: denied roles see the button
// DISABLED inside the `.tip` wrapper with a "Requires admin" tooltip
// (RBAC matrix convention "Disabled = greyed with tooltip" — never hidden).
// The create modal posts via useCreateApp (the Idempotency-Key is minted in
// the hook), maps `409 app-conflict` to an inline name error (error catalog:
// "already exists."), and on success toasts + switches to a success step that
// surfaces the auto-created deployment keys plus the public SDK URLs so the
// developer can wire the client before the CLI is useful.

import { useId, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { useApps, useCreateApp } from "../api/hooks/apps";
import { useSdkConfig } from "../api/hooks/sdkConfig";
import { classifyProblem, HttpProblemError } from "../api/problem";
import { Modal } from "../components/overlay/Modal";
import { useToast } from "../components/overlay/ToastProvider";
import { Copyable } from "../components/ui/Copyable";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Skeleton } from "../components/ui/Skeleton";
import { useTeamRole } from "../rbac/useTeamRole";
import { apiServerUrl } from "../lib/cliSnippet";
import { formatDate } from "../model/format";
import type { App } from "../model/app";
import type { Deployment } from "../model/deployment";
import type { FormEvent } from "react";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { APP_ICO, CELL_APP, CELL_MAIN } from "../components/ui/cell";
import { CHIP } from "../components/ui/chip";
import { PIN, PIN_TONE } from "../components/ui/pin";
import {
  FIELD,
  FIELD_ERR,
  FIELD_HINT,
  FIELD_LABEL,
  INPUT,
  INPUT_STATE,
  TOGGLE,
  TOGGLE_INPUT,
  TOGGLE_TRACK,
} from "../components/ui/form";
import { TBL, TBL_TD, TBL_TH, TBL_TR, TBL_WRAP } from "../components/ui/table";
import { PAGE_SUB, PAGE_TITLE } from "../components/ui/typography";

export function AppsPage() {
  // :teamId is always bound on this route (router.tsx nests the page under
  // teams/:teamId); the assertion keeps the hooks below string-typed.
  const teamId = useParams().teamId as string;
  const appsQuery = useApps(teamId);
  const {
    can,
    isLoading: roleLoading,
    downgradeToViewer,
  } = useTeamRole(teamId);
  const [createOpen, setCreateOpen] = useState(false);

  const canCreate = !roleLoading && can("app.create");
  // While the role still resolves the button is plain-disabled (no tooltip)
  // so the loading window never flashes "Requires admin" at admins/owners.
  const showDeniedTip = !roleLoading && !canCreate;

  const openCreate = () => {
    setCreateOpen(true);
  };

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-[18px]">
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE}>
            Apps
          </h1>
          <p className={PAGE_SUB}>
            React Native OTA targets in this team. Each app auto-creates a
            Staging and Production deployment.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {showDeniedTip ? (
            // RBAC "Disabled" convention: rendered greyed (never hidden) with
            // the `.tip` hover tooltip; `.btn[disabled]` removes
            // pointer events, so the wrapper owns the hover. The sr-only
            // suffix carries the reason to screen readers.
            <span className="tip" data-tip="Requires admin">
              <button type="button" className={buttonVariants({ intent: "primary" })} disabled>
                <PlusIcon /> Create app
                <span className="sr-only"> — requires admin</span>
              </button>
            </span>
          ) : (
            <button
              type="button"
              className={buttonVariants({ intent: "primary" })}
              disabled={roleLoading}
              onClick={openCreate}
            >
              <PlusIcon /> Create app
            </button>
          )}
        </div>
      </div>

      {appsQuery.isPending ? (
        <div
          className="rounded-lg border border-border bg-surface shadow-sm"
          role="status"
          aria-label="Loading apps"
        >
          <AppTableSkeleton />
        </div>
      ) : appsQuery.isError ? (
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <ErrorState
            error={appsQuery.error}
            onRetry={() => {
              void appsQuery.refetch();
            }}
          />
        </div>
      ) : appsQuery.data.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-[22px] shadow-sm">
          <EmptyState
            icon={<PackageIcon />}
            title="No apps yet"
            description="Create your first app to get Staging and Production deployments, then publish releases from the CLI."
            action={
              canCreate ? (
                <button
                  type="button"
                  className={buttonVariants({ intent: "primary" })}
                  onClick={openCreate}
                >
                  <PlusIcon /> Create app
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface shadow-sm">
          <AppTable teamId={teamId} apps={appsQuery.data} />
        </div>
      )}

      {createOpen ? (
        <CreateAppModal
          teamId={teamId}
          onClose={() => {
            setCreateOpen(false);
          }}
          onForbidden={downgradeToViewer}
        />
      ) : null}
    </>
  );
}

// --- AppTable ---------------------------------------------------------------

function AppTable({ teamId, apps }: { teamId: string; apps: App[] }) {
  const navigate = useNavigate();
  return (
    <div className={TBL_WRAP}>
      <table className={TBL}>
        <thead>
          <tr>
            <th className={TBL_TH}>App</th>
            <th className={TBL_TH}>Code signing</th>
            <th className={`${TBL_TH} text-right`}>Created</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => {
            const detailPath = `/teams/${teamId}/apps/${app.id}`;
            return (
              <tr
                key={app.id}
                className={`${TBL_TR} cursor-pointer`}
                onClick={(event) => {
                  // The name <Link> owns navigation semantics (and keyboard
                  // access); the row-level click is a pointer convenience —
                  // skip it when the click already landed on the link.
                  if (
                    event.target instanceof Element &&
                    event.target.closest("a") !== null
                  ) {
                    return;
                  }
                  void navigate(detailPath);
                }}
              >
                <td className={TBL_TD}>
                  <div className={CELL_APP}>
                    <span
                      className={APP_ICO}
                      style={{ background: gradientFor(app.id) }}
                      aria-hidden="true"
                    >
                      {initialsFor(app.name)}
                    </span>
                    <div>
                      <div className={CELL_MAIN}>
                        <Link to={detailPath}>{app.name}</Link>
                      </div>
                    </div>
                  </div>
                </td>
                <td className={TBL_TD}>
                  {app.requireCodeSigning ? (
                    <span className={`${PIN} ${PIN_TONE.sign}`}>
                      <ShieldIcon /> Signed
                    </span>
                  ) : (
                    <span className={`${CHIP} border-border bg-transparent text-fg-2`}>
                      Off
                    </span>
                  )}
                </td>
                <td className={`${TBL_TD} text-right`}>
                  {formatDate(app.createdAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const SKELETON_ROW_COUNT = 5;

function AppTableSkeleton() {
  return (
    <div className={TBL_WRAP} aria-hidden="true">
      <table className={TBL}>
        <thead>
          <tr>
            <th className={TBL_TH}>App</th>
            <th className={TBL_TH}>Code signing</th>
            <th className={`${TBL_TH} text-right`}>Created</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
            <tr key={index} className={TBL_TR}>
              <td className={TBL_TD}>
                <div className={CELL_APP}>
                  <Skeleton width={34} height={34} />
                  <Skeleton width={150} height={13} />
                </div>
              </td>
              <td className={TBL_TD}>
                <Skeleton width={64} height={20} />
              </td>
              <td className={`${TBL_TD} text-right`}>
                <Skeleton width={90} height={13} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Create app modal --------------------------------------------------------

interface CreateAppModalProps {
  teamId: string;
  onClose: () => void;
  /** RBAC inference: a server-denied create downgrades the team to viewer. */
  onForbidden: () => void;
}

interface CreatedResult {
  app: App;
  deployments: Deployment[];
}

function CreateAppModal({ teamId, onClose, onForbidden }: CreateAppModalProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const createApp = useCreateApp();
  const formId = useId();
  const nameErrorId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [requireCodeSigning, setRequireCodeSigning] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedResult | null>(null);

  const pending = createApp.isPending;

  // Mirrors ConfirmDialog's busy contract: an in-flight create (idempotent,
  // key minted in the hook and reused across its retries) can't be dismissed,
  // otherwise the success step — the only surface showing the new deployment
  // keys — would be lost.
  const handleClose = () => {
    if (pending) {
      return;
    }
    onClose();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    setSubmitError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("App name is required.");
      nameInputRef.current?.focus();
      return;
    }
    setNameError(null);
    createApp.mutate(
      {
        name: trimmed,
        team_id: teamId,
        ...(requireCodeSigning ? { require_code_signing: true } : {}),
      },
      {
        onSuccess: ({ app, deployments }) => {
          toast.success(`App "${app.name}" created`, {
            description:
              "Staging and Production deployments were created automatically.",
          });
          setCreated({ app, deployments });
        },
        onError: (error) => {
          if (error instanceof HttpProblemError) {
            const behavior = classifyProblem(error);
            if (behavior === "name-conflict") {
              // 409 app-conflict → inline on the name field (error catalog).
              setNameError("An app with this name already exists in this team.");
              nameInputRef.current?.focus();
              return;
            }
            if (behavior === "validation-error") {
              const nameFieldError = error.errors?.find(
                (fieldError) => fieldError.field === "name",
              );
              setNameError(
                nameFieldError?.message ??
                  error.detail ??
                  "The request failed validation.",
              );
              nameInputRef.current?.focus();
              return;
            }
            if (behavior === "forbidden") {
              onForbidden();
              setSubmitError(
                "Your role doesn't allow creating apps — requires admin.",
              );
              return;
            }
            setSubmitError(
              error.detail ?? error.title ?? "The app couldn't be created.",
            );
            return;
          }
          setSubmitError(
            "Network error — check your connection and try again.",
          );
        },
      },
    );
  };

  if (created !== null) {
    // Success step: surface deployment keys + SDK URLs before leaving —
    // the toast already announced the creation. CLI publish comes later,
    // once the client is wired and reinstalled.
    return (
      <AppCreatedSuccess
        appName={created.app.name}
        deployments={created.deployments}
        onClose={onClose}
        onGoToApp={() => {
          onClose();
          void navigate(`/teams/${teamId}/apps/${created.app.id}`);
        }}
      />
    );
  }

  return (
    <Modal
      open
      onClose={handleClose}
      title="Create app"
      description="Staging and Production deployments are created automatically."
      icon={<PackageIcon />}
      initialFocusRef={nameInputRef}
      footer={
        <>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle" })}
            onClick={handleClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonVariants({ intent: "primary" })}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? <span className="spinner sm" aria-hidden="true" /> : null}
            Create app
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit}>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>App name</span>
          <input
            ref={nameInputRef}
            className={`${INPUT} ${INPUT_STATE.normal}`}
            placeholder="e.g. harbor-android"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError !== null) {
                setNameError(null);
              }
            }}
            disabled={pending}
            aria-invalid={nameError !== null || undefined}
            aria-describedby={nameError !== null ? nameErrorId : undefined}
          />
          {nameError !== null ? (
            <span className={FIELD_ERR} id={nameErrorId} role="alert">
              <AlertIcon /> {nameError}
            </span>
          ) : (
            <span className={FIELD_HINT}>
              Use a unique name per platform, e.g. <code>my-app-android</code> /{" "}
              <code>my-app-ios</code>.
            </span>
          )}
        </label>
        <label className={`${TOGGLE} mt-1 mb-1.5`}>
          <input
            type="checkbox"
            className={TOGGLE_INPUT}
            checked={requireCodeSigning}
            onChange={(event) => {
              setRequireCodeSigning(event.target.checked);
            }}
            disabled={pending}
          />
          <span className={TOGGLE_TRACK} /> Require code signing
        </label>
        <div className={`${CALLOUT} ${CALLOUT_TONE.warn} mt-2.5`}>
          <AlertIcon />
          <div>
            When code signing is on, unsigned releases are{" "}
            <b>rejected at publish time</b>. Configure your signing key in CI
            before enabling.
          </div>
        </div>
        {submitError !== null ? (
          <div
            className={`${CALLOUT} ${CALLOUT_TONE.danger} mt-2.5`}
            role="alert"
          >
            <AlertIcon />
            <div>{submitError}</div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

// --- Presentation helpers ----------------------------------------------------

const CONNECT_APP_DOCS_URL =
  "https://github.com/codemagic-ci-cd/codemagic-patch#part-4--connect-your-react-native-app";

function AppCreatedSuccess({
  appName,
  deployments,
  onClose,
  onGoToApp,
}: {
  appName: string;
  deployments: Deployment[];
  onClose: () => void;
  onGoToApp: () => void;
}) {
  const sdkConfigQuery = useSdkConfig();
  const apiUrl = apiServerUrl();
  const downloadBaseUrl = sdkConfigQuery.data?.downloadBaseUrl;

  return (
    <Modal
      open
      onClose={onClose}
      title="App created"
      description={`${appName} is ready. Wire these into the SDK, rebuild, then reinstall the app.`}
      footer={
        <>
          <button type="button" className={buttonVariants({ intent: "subtle" })} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className={buttonVariants({ intent: "primary" })}
            onClick={onGoToApp}
          >
            Go to app
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {deployments.map((deployment) => (
          <div
            key={deployment.id}
            className="flex items-center justify-between gap-[14px]"
          >
            <span className="shrink-0 text-[13.5px] font-semibold text-fg-2">
              {deployment.name}
            </span>
            <Copyable
              value={deployment.deploymentKey}
              display="masked"
              maskHead={6}
              maskTail={4}
              ariaLabel={`Copy ${deployment.name} deployment key`}
            />
          </div>
        ))}
        <p className="m-0 mb-2 text-[12.5px] leading-snug text-fg-3">
          Deployment keys are SDK config values, not secrets.
        </p>
        <div className="flex items-center justify-between gap-[14px]">
          <span className="shrink-0 font-mono text-[12.5px] font-semibold text-fg-2">
            CodemagicPatchApiUrl
          </span>
          <Copyable
            value={apiUrl}
            display="masked"
            maskHead={14}
            maskTail={8}
            ariaLabel="Copy CodemagicPatchApiUrl"
          />
        </div>
        <div className="flex items-center justify-between gap-[14px]">
          <span className="shrink-0 font-mono text-[12.5px] font-semibold text-fg-2">
            CodemagicPatchDownloadBaseUrl
          </span>
          {sdkConfigQuery.isPending ? (
            <Skeleton width={160} variant="text" />
          ) : sdkConfigQuery.isError || downloadBaseUrl === undefined ? (
            <span className="text-[12.5px] font-medium text-fg-3">
              Unavailable
            </span>
          ) : (
            <Copyable
              value={downloadBaseUrl}
              display="masked"
              maskHead={14}
              maskTail={8}
              ariaLabel="Copy CodemagicPatchDownloadBaseUrl"
            />
          )}
        </div>
        <p className="m-0 text-[12.5px] leading-snug text-fg-3">
          <a
            className="font-semibold text-blue hover:underline"
            href={CONNECT_APP_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Connect your React Native app
          </a>
        </p>
      </div>
    </Modal>
  );
}

// Identicon gradients — decorative only; the initials are aria-hidden.
const APP_ICON_GRADIENTS = [
  "linear-gradient(135deg,#0051ff,#008bf7)",
  "linear-gradient(135deg,#00ceff,#008bf7)",
  "linear-gradient(135deg,#fe19ff,#b517d6)",
  "linear-gradient(135deg,#ff9100,#ff4d13)",
  "linear-gradient(135deg,#0031ea,#0051ff)",
  "linear-gradient(135deg,#008bf7,#00ceff)",
  "linear-gradient(135deg,#10b981,#059669)",
  "linear-gradient(135deg,#ff4d13,#ec0c43)",
] as const;

/** Stable gradient pick so an app keeps its tile color across refetches. */
function gradientFor(appId: string): string {
  let hash = 0;
  for (let index = 0; index < appId.length; index += 1) {
    hash = (hash * 31 + appId.charCodeAt(index)) >>> 0;
  }
  return APP_ICON_GRADIENTS[hash % APP_ICON_GRADIENTS.length];
}

/** Tile initials: "harbor-android" → "ha", single words → first two. */
function initialsFor(appName: string): string {
  const segments = appName
    .split(/[^\p{L}\p{N}]+/u)
    .filter((segment) => segment.length > 0);
  const first = segments[0] ?? appName;
  const second = segments[1];
  const initials =
    second !== undefined
      ? `${first.charAt(0)}${second.charAt(0)}`
      : first.slice(0, 2);
  return initials === "" ? "?" : initials.toLowerCase();
}

// --- Icons (paths mirror the shared icon set) --------------------------------

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function PackageIcon() {
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
      <path d="M16.5 9.4 7.5 4.21M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="m12 13 0 8" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 4 5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V5l-8-3z" />
      <polyline points="9 11.5 11.5 14 15 9.5" />
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
