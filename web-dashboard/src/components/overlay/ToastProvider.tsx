// Toast context + stacked auto-dismiss toasts.
// `useToast()` exposes toast.success/error/info(message, opts?) plus
// dismiss(id). Announcements follow an aria-live split: success/info
// land in a polite region, errors in an assertive one — both regions are
// portal-mounted ONCE and stay in the DOM (live regions must pre-exist for
// screen readers to announce insertions). Every toast has a manual dismiss
// button; hover or keyboard focus pauses the auto-dismiss timer (opt-out per
// toast). Entry animation is the shared `rise` keyframes (app.css @theme),
// which base.css suppresses under prefers-reduced-motion; removal is instant
// (no JS-driven exit animation), so reduced-motion users see no movement at
// all.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastOptions {
  /** Secondary line under the message (".t-sub"). */
  description?: string;
  /**
   * Auto-dismiss delay. Defaults: 4200ms (success/info) /
   * 7000ms (error/warning). `<= 0` disables auto-dismiss (manual dismiss only).
   */
  durationMs?: number;
  /** Pause the auto-dismiss timer on hover/focus. Default: true. */
  pauseOnHover?: boolean;
}

export interface ToastApi {
  /** Each returns the toast id (usable with `dismiss`). */
  success(message: string, options?: ToastOptions): string;
  error(message: string, options?: ToastOptions): string;
  info(message: string, options?: ToastOptions): string;
  warning(message: string, options?: ToastOptions): string;
  dismiss(id: string): void;
}

interface ToastRecord {
  id: string;
  kind: ToastKind;
  message: string;
  description?: string;
  durationMs: number;
  pauseOnHover: boolean;
}

const DEFAULT_DURATION_MS = 4200;
const ERROR_DURATION_MS = 7000;
/** Grace period when resuming an already-elapsed timer after hover/focus. */
const MIN_RESUME_MS = 500;

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string, options?: ToastOptions): string => {
      const id = crypto.randomUUID();
      setToasts((current) => [
        ...current,
        {
          id,
          kind,
          message,
          description: options?.description,
          durationMs:
            options?.durationMs ??
            (kind === "error" || kind === "warning"
              ? ERROR_DURATION_MS
              : DEFAULT_DURATION_MS),
          pauseOnHover: options?.pauseOnHover ?? true,
        },
      ]);
      return id;
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, options) => push("success", message, options),
      error: (message, options) => push("error", message, options),
      info: (message, options) => push("info", message, options),
      warning: (message, options) => push("warning", message, options),
      dismiss,
    }),
    [push, dismiss],
  );

  const politeToasts = toasts.filter((toast) => toast.kind !== "error");
  const errorToasts = toasts.filter((toast) => toast.kind === "error");

  return (
    <ToastContext value={api}>
      {children}
      {createPortal(
        <div className="fixed bottom-6 right-6 z-[200] flex max-w-[380px] flex-col gap-2.5 max-shell:left-4 max-shell:right-4 max-shell:max-w-none">
          <div
            className="flex flex-col gap-2.5"
            role="status"
            aria-live="polite"
            aria-atomic="false"
          >
            {politeToasts.map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
          </div>
          <div
            className="flex flex-col gap-2.5"
            role="alert"
            aria-live="assertive"
            aria-atomic="false"
          >
            {errorToasts.map((toast) => (
              <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext>
  );
}

/** Toast api accessor; throws when rendered outside <ToastProvider>. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return api;
}

// Kind tint applied to BOTH svgs (status glyph and dismiss ×): the legacy
// `.toast.ok svg { color: … }` hit every descendant svg directly, so the
// dismiss icon was tinted too (and stayed tinted on hover — a direct color
// always beats the button's inherited hover color). Ported verbatim.
const KIND_TINT: Record<ToastKind, string> = {
  success: "text-[#34d399]",
  error: "text-[#ff6b8a]",
  info: "text-aqua",
  warning: "text-[#fbbf24]",
};

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}) {
  // Auto-dismiss bookkeeping lives in refs so hover/focus pauses never
  // re-render; `remaining` survives across pause/resume cycles.
  const remainingMsRef = useRef(toast.durationMs);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (toast.durationMs <= 0) {
      return;
    }
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onDismiss(toast.id);
    }, remainingMsRef.current);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [toast.id, toast.durationMs, onDismiss]);

  const pause = () => {
    if (!toast.pauseOnHover || timerRef.current === null) {
      return;
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingMsRef.current = Math.max(
      0,
      remainingMsRef.current - (Date.now() - startedAtRef.current),
    );
  };

  const resume = () => {
    if (
      !toast.pauseOnHover ||
      toast.durationMs <= 0 ||
      timerRef.current !== null
    ) {
      return;
    }
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(
      () => {
        timerRef.current = null;
        onDismiss(toast.id);
      },
      Math.max(remainingMsRef.current, MIN_RESUME_MS),
    );
  };

  return (
    <div
      data-toast
      className="flex animate-[rise_.2s_ease_both] items-start gap-[11px] rounded-md bg-ink px-4 py-3.5 text-[13.5px] text-white shadow-lg"
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <KindIcon kind={toast.kind} />
      <div>
        <div className="font-bold">{toast.message}</div>
        {toast.description !== undefined ? (
          <div className="mt-[2px] text-[12.5px] text-[#aeb4cf]">
            {toast.description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="ml-auto grid size-6 flex-none place-items-center rounded-[7px] border-0 bg-transparent hover:bg-[rgba(255,255,255,.14)]"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <svg
          className={`size-3.5 ${KIND_TINT[toast.kind]}`}
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
      </button>
    </div>
  );
}

/** Status icons tinted per kind (KIND_TINT). */
function KindIcon({ kind }: { kind: ToastKind }) {
  return (
    <svg
      className={`mt-px size-[18px] flex-none ${KIND_TINT[kind]}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "success" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <polyline points="16 9.5 11 14.5 8.5 12" />
        </>
      ) : kind === "error" || kind === "warning" ? (
        <>
          <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12" y2="17" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <line x1="12" y1="8" x2="12" y2="8" />
        </>
      )}
    </svg>
  );
}
