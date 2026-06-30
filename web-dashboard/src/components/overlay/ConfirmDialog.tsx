// Confirmation dialog implementing the two confirmation tiers on top
// of Modal:
//   tier 1 `variant="summary"` — reversible-but-impactful mutations (disable,
//     increase rollout, promote, rollback): title + explicit mutation-summary
//     rows (the UI's `--yes` equivalent) + Confirm/Cancel. The confirm button
//     is never default-focused — Modal's default focus is the dialog
//     container — which satisfies "destructive confirm not default-focused".
//   tier 2 `variant="typeToConfirm"` — irreversible mutations (delete
//     app/deployment, clear history, revoke token): the red destructive
//     button stays disabled until the user types the exact confirmation
//     string. The text input IS default-focused (safe: the destructive
//     button is disabled until the string matches).
// `busy` renders a pending confirm (spinner + disabled controls) and blocks
// dismissal so an in-flight mutation cannot be abandoned mid-submit; `error`
// is an inline problem slot (e.g. the 409 active-release-job blocking notice
// — pair it with confirmLabel="Retry") announced assertively.

import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { Modal } from "./Modal";
import { buttonVariants } from "../ui/Button";
import { CALLOUT, CALLOUT_BLOCK, CALLOUT_TONE } from "../ui/callout";
import { FIELD, FIELD_LABEL, INPUT, INPUT_STATE } from "../ui/form";
import { SUMMARY, SUMMARY_KEY, SUMMARY_ROW, SUMMARY_VALUE } from "../ui/summary";

/** One row of the tier-1 mutation summary (ui/summary literals). */
export interface MutationSummaryRow {
  /** Left column, e.g. "Rollout". */
  label: ReactNode;
  /**
   * Right column, e.g. `25% <span className={SUMMARY_ARROW}>→</span> 50%`
   * (ui/summary's arrow literal styles transition arrows).
   */
  value: ReactNode;
}

interface ConfirmDialogBaseProps {
  open: boolean;
  /** Cancel/Esc/overlay-click/X. Ignored while `busy`. */
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Optional .modal__ico SVG; tinted red for destructive dialogs. */
  icon?: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: ReactNode;
  /** Pending state: spinner on confirm, all dismissal paths disabled. */
  busy?: boolean;
  /**
   * Inline problem slot rendered as an assertive danger callout (blocking
   * errors are aria-live assertive), e.g. a 409 active-release-job
   * notice while confirmLabel switches to "Retry".
   */
  error?: ReactNode;
  /** Extra body content above the summary/confirmation input (callouts…). */
  children?: ReactNode;
}

export type ConfirmDialogProps = ConfirmDialogBaseProps &
  (
    | {
        variant: "summary";
        summary: MutationSummaryRow[];
        /** Red confirm button + danger icon tint (e.g. disable release). */
        destructive?: boolean;
      }
    | {
        variant: "typeToConfirm";
        /** Exact string the user must type, e.g. the resource name. */
        confirmationText: string;
      }
  );

export function ConfirmDialog(props: ConfirmDialogProps) {
  // Remount the stateful inner dialog on every open/close transition so the
  // tier-2 confirmation input never carries stale text into a reopen
  // (effect-free state reset).
  return (
    <ConfirmDialogContent key={props.open ? "open" : "closed"} {...props} />
  );
}

function ConfirmDialogContent(props: ConfirmDialogProps) {
  const {
    open,
    onCancel,
    onConfirm,
    title,
    description,
    icon,
    confirmLabel,
    cancelLabel = "Cancel",
    busy = false,
    error,
    children,
  } = props;
  const [typed, setTyped] = useState("");
  const confirmationInputRef = useRef<HTMLInputElement | null>(null);

  const destructive =
    props.variant === "typeToConfirm" ? true : (props.destructive ?? false);
  const confirmBlocked =
    props.variant === "typeToConfirm" && typed !== props.confirmationText;

  const requestClose = () => {
    if (!busy) {
      onCancel();
    }
  };

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={title}
      description={description}
      icon={icon}
      tone={destructive ? "danger" : "default"}
      initialFocusRef={
        props.variant === "typeToConfirm" ? confirmationInputRef : undefined
      }
      footer={
        <>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle" })}
            onClick={requestClose}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={buttonVariants({
              intent: destructive ? "danger" : "primary",
            })}
            onClick={onConfirm}
            disabled={busy || confirmBlocked}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner sm m-0" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {props.variant === "summary" ? (
        <div className={SUMMARY}>
          {props.summary.map((row, index) => (
            <div className={SUMMARY_ROW} key={index}>
              <span className={SUMMARY_KEY}>{row.label}</span>
              <span className={SUMMARY_VALUE}>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <label className={FIELD}>
          <span className={FIELD_LABEL}>
            Type <code>{props.confirmationText}</code> to confirm
          </span>
          <input
            ref={confirmationInputRef}
            className={`${INPUT} ${INPUT_STATE.normal}`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={props.confirmationText}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
      )}
      {error !== undefined && error !== null ? (
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} ${CALLOUT_BLOCK}`} role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}
    </Modal>
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
