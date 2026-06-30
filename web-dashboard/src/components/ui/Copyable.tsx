// Copy-to-clipboard pill.
// Visual contract: the `.copyable` markup ported to utility literals —
// masked middle-ellipsis (`fp_a17c…<b>e93f</b>`), full values
// (`<b>value</b>`), optional leading label (`Deployment key <b>…</b>`).
// The copied skin swaps wholesale (ternary, never appended) — see Button.tsx
// for the no-merge contract. The `<b>` keeps the legacy 600 weight (UA bold
// is 700).
//
// Clipboard strategy (Browser capability fallbacks):
// `navigator.clipboard.writeText` first; when unavailable or rejected, the
// FULL value is revealed in an auto-selected readonly input so the user can
// copy manually ("selectable text field fallback"). The fallback state is
// sticky — re-clicking the copy button re-selects the field.

import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "fallback";

const COPIED_RESET_MS = 1600;

export interface CopyStateHandle {
  state: CopyState;
  copy: (value: string) => Promise<void>;
}

/**
 * Shared by Copyable and CliCommandBuilder: attempts a clipboard write and tracks
 * the transient "Copied" affordance. "copied" resets to "idle" after a short
 * delay; "fallback" (no clipboard API / write rejected) is sticky so callers
 * keep their selectable text on screen.
 */
export function useCopyState(): CopyStateHandle {
  const [state, setState] = useState<CopyState>("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const copy = useCallback(async (value: string) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Insecure contexts (and jsdom) expose no Clipboard API despite the
    // non-optional lib.dom typing — guard at runtime.
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      try {
        await clipboard.writeText(value);
        setState("copied");
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          setState("idle");
        }, COPIED_RESET_MS);
        return;
      } catch {
        // Permission denied / not focused — fall through to selectable text.
      }
    }
    setState("fallback");
  }, []);

  return { state, copy };
}

// Icon paths render the `copy` and `check` glyphs.
export function CopyIcon() {
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
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function CheckIcon() {
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

export interface CopyableProps {
  /** Full text written to the clipboard (always copied unmasked). */
  value: string;
  /**
   * "full" renders the whole value; "masked" middle-ellipsizes it
   * (e.g. `abc1…789`). Values too short to mask render in full.
   */
  display?: "full" | "masked";
  /** Leading characters kept by the masked display. */
  maskHead?: number;
  /** Trailing characters kept by the masked display (rendered emphasized). */
  maskTail?: number;
  /** Plain-text label rendered before the value, e.g. "Deployment key". */
  label?: string;
  /** Copy-button accessible name; defaults to `Copy ${label}` / "Copy to clipboard". */
  ariaLabel?: string;
}

export function Copyable({
  value,
  display = "full",
  maskHead = 4,
  maskTail = 3,
  label,
  ariaLabel,
}: CopyableProps) {
  const { state, copy } = useCopyState();
  const fallbackRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state === "fallback") {
      fallbackRef.current?.select();
    }
  }, [state]);

  const handleCopy = () => {
    if (state === "fallback") {
      // Clipboard already proved unavailable — just re-select for manual copy.
      fallbackRef.current?.select();
      return;
    }
    void copy(value);
  };

  const copied = state === "copied";
  const masked =
    display === "masked" && value.length > maskHead + maskTail + 1;
  const copyButtonLabel =
    ariaLabel ?? (label !== undefined ? `Copy ${label}` : "Copy to clipboard");

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-sm border py-1 pr-1.5 pl-[11px] font-mono text-[12.5px] text-fg-2 ${
        copied ? "border-green bg-green-tint" : "border-border bg-surface-2"
      }`}
    >
      {label !== undefined ? <>{label} </> : null}
      {state === "fallback" ? (
        <input
          ref={fallbackRef}
          className="min-w-0 border-0 bg-transparent p-0 font-mono text-[12.5px] font-semibold text-fg outline-none"
          readOnly
          value={value}
          size={Math.min(value.length, 36)}
          aria-label={label ?? "Value to copy"}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : masked ? (
        <>
          {value.slice(0, maskHead)}…
          <b className="font-semibold text-fg">{value.slice(-maskTail)}</b>
        </>
      ) : (
        <b className="font-semibold text-fg">{value}</b>
      )}
      <button
        type="button"
        className={`grid h-6 w-[26px] place-items-center rounded-[7px] border-0 bg-transparent [transition:.13s] hover:bg-surface-3 ${
          copied ? "text-green-deep" : "text-fg-3 hover:text-blue"
        }`}
        aria-label={copyButtonLabel}
        onClick={handleCopy}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <span role="status" className="sr-only">
        {copied
          ? "Copied to clipboard"
          : state === "fallback"
            ? "Clipboard unavailable — value selected, copy it manually"
            : ""}
      </span>
    </span>
  );
}
