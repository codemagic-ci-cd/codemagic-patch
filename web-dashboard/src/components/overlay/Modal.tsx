// Portal-rendered modal dialog implementing the accessibility contract:
// a REAL focus trap (Tab/Shift+Tab cycle inside the dialog plus document-level
// focus recapture), focus moves into the dialog on open and RESTORES to the
// opener on close, Esc closes unless `disableEscapeClose` (the show-once
// secret modal), and body scroll is locked while open. There is deliberately
// no auto-focus on the first control: by default focus lands on the dialog
// container itself so destructive confirm buttons are never default-focused
// (ConfirmDialog relies on this); pass `initialFocusRef` where the caller wants
// a specific control focused (e.g. the show-once modal's copy button).
// Stacked modals (e.g. the show-once PAT modal opened from the members modal)
// are supported via a module-level stack: only the top-most dialog handles
// Esc/Tab/recapture, and the scroll lock is reference-counted.

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";

/** Tint of the icon tile; ports the legacy .modal__ico modifiers. */
export type ModalTone = "default" | "danger" | "warn" | "green";

// Icon-tile literals (legacy `.modal__ico`) — exported for the one screen
// that borrows the tile outside a dialog (CallbackPage's sign-in-failed art).
export const MODAL_ICON =
  "grid size-[42px] flex-none place-items-center rounded-[12px] [&_svg]:size-[21px]";

export const MODAL_ICON_TONE: Record<ModalTone, string> = {
  default: "bg-blue-tint text-blue",
  danger: "bg-red-tint text-red",
  warn: "bg-yellow-tint text-yellow",
  green: "bg-green-tint text-green-deep",
};

export interface ModalProps {
  open: boolean;
  /**
   * Close request (Esc / overlay click / X button). The owner controls the
   * dialog by flipping `open`; this never closes anything by itself.
   */
  onClose: () => void;
  title: ReactNode;
  /** Secondary line in the header (wired to aria-describedby). */
  description?: ReactNode;
  /** Inline SVG for the .modal__ico tile; the tile is omitted when absent. */
  icon?: ReactNode;
  tone?: ModalTone;
  /** .modal.wide (620px instead of 520px). */
  wide?: boolean;
  /**
   * Show-once secret modal: Esc no longer closes. Unless explicitly
   * overridden this also disables overlay click-to-close and hides the X
   * button, making the dialog dismissible only through its own actions.
   */
  disableEscapeClose?: boolean;
  /** Default: `!disableEscapeClose`. */
  closeOnOverlayClick?: boolean;
  /** Default: `!disableEscapeClose`. */
  showCloseButton?: boolean;
  /**
   * Element focused when the dialog opens. Default: the dialog container
   * (deliberately NOT the first control — destructive confirm must not
   * be default-focused).
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Rendered inside .modal__foot when provided. */
  footer?: ReactNode;
  children?: ReactNode;
}

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function tabbableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
  ).filter((element) => element.getClientRects().length > 0);
}

/** Top-most-wins registry so stacked modals do not fight over Esc/Tab/focus. */
const modalStack: HTMLElement[] = [];

/** Reference-counted body scroll lock (stacked modals unlock exactly once). */
let scrollLockCount = 0;
let previousBodyOverflow = "";

function lockBodyScroll(): void {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLockCount += 1;
}

function unlockBodyScroll(): void {
  scrollLockCount -= 1;
  if (scrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
  }
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  tone = "default",
  wide = false,
  disableEscapeClose = false,
  closeOnOverlayClick,
  showCloseButton,
  initialFocusRef,
  footer,
  children,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Guards overlay click-to-close against text-selection drags that merely
  // END on the overlay: the press must also have started there.
  const mouseDownOnOverlayRef = useRef(false);

  // Latest-value mirrors so the open effect below subscribes once per open.
  const onCloseRef = useRef(onClose);
  const escapeDisabledRef = useRef(disableEscapeClose);
  useEffect(() => {
    onCloseRef.current = onClose;
    escapeDisabledRef.current = disableEscapeClose;
  }, [onClose, disableEscapeClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }

    // Captured before focus moves into the dialog; restored on close.
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    modalStack.push(dialog);
    lockBodyScroll();

    const isTopModal = () => modalStack[modalStack.length - 1] === dialog;

    (initialFocusRef?.current ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal()) {
        return;
      }
      if (event.key === "Escape") {
        if (!escapeDisabledRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const tabbables = tabbableElements(dialog);
      if (tabbables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const activeInDialog = active !== null && dialog.contains(active);
      if (event.shiftKey) {
        // Shift+Tab from the first control or the container wraps to the end.
        if (!activeInDialog || active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!activeInDialog || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Hardening on top of the Tab handling: if focus ever lands outside the
    // top-most dialog (programmatic focus, browser quirks), pull it back in.
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopModal()) {
        return;
      }
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        dialog.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn);
      const stackIndex = modalStack.indexOf(dialog);
      if (stackIndex !== -1) {
        modalStack.splice(stackIndex, 1);
      }
      unlockBodyScroll();
      if (opener !== null && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open, initialFocusRef]);

  if (!open) {
    return null;
  }

  const overlayClosable = closeOnOverlayClick ?? !disableEscapeClose;
  const showX = showCloseButton ?? !disableEscapeClose;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex animate-fade items-center justify-center overflow-auto bg-[rgba(10,14,34,.5)] p-6 backdrop-blur-[4px]"
      onMouseDown={(event) => {
        mouseDownOnOverlayRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const pressStartedHere = mouseDownOnOverlayRef.current;
        mouseDownOnOverlayRef.current = false;
        if (
          overlayClosable &&
          pressStartedHere &&
          event.target === event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={`flex max-h-[calc(100vh-48px)] w-full animate-rise flex-col overflow-hidden rounded-xl bg-surface shadow-lg ${
          wide ? "max-w-[620px]" : "max-w-[520px]"
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="flex items-start gap-3.5 px-6 pb-4 pt-[22px]">
          {icon !== undefined ? (
            <div
              className={`${MODAL_ICON} ${MODAL_ICON_TONE[tone]}`}
              aria-hidden="true"
            >
              {icon}
            </div>
          ) : null}
          <div>
            <h3 id={titleId} className="text-[18px] font-extrabold tracking-[-.02em]">
              {title}
            </h3>
            {description !== undefined ? (
              <p id={descriptionId} className="mt-1 text-[13.5px] text-fg-2">
                {description}
              </p>
            ) : null}
          </div>
          {showX ? (
            <button
              type="button"
              className="ml-auto grid size-8 flex-none place-items-center rounded-sm border-0 bg-surface-2 text-fg-3 hover:bg-surface-3 hover:text-fg [&_svg]:size-[17px]"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
        <div className="overflow-auto px-6 pb-2 pt-1">{children}</div>
        {footer !== undefined ? (
          <div className="mt-3 flex justify-end gap-2.5 border-t border-border bg-surface px-6 pb-[22px] pt-[18px]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function CloseIcon() {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
