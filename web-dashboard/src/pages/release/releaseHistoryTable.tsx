// Release history table layout (DeploymentDetailPage).
//
// - release / actions: shrink-to-content (w-[1%]).
// - note: single-line truncate (~38ch) on the cell text.
// - data: shared preset for status, rollout, target, and metric columns.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TBL_TD, TBL_TH } from "../../components/ui/table";

const FIT = "w-[1%] whitespace-nowrap";
const DATA_CELL =
  "text-center font-mono text-[12.5px] tabular-nums";

const NOTE_TEXT =
  "block max-w-[38ch] truncate text-[13px] font-medium text-fg";

const TIP_SHOW_DELAY_MS = 100;

/** Truncated release note with a styled hover tooltip for the full text. */
export function ReleaseNoteText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const showTipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  const clearShowTipTimeout = () => {
    if (showTipTimeoutRef.current !== null) {
      clearTimeout(showTipTimeoutRef.current);
      showTipTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearShowTipTimeout();
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const measure = () => {
      setTruncated(el.scrollWidth > el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [text]);

  return (
    <>
      <span
        ref={ref}
        className={NOTE_TEXT}
        onMouseEnter={(event) => {
          if (!truncated) {
            return;
          }
          clearShowTipTimeout();
          const rect = event.currentTarget.getBoundingClientRect();
          const pos = { left: rect.left, top: rect.bottom + 8 };
          showTipTimeoutRef.current = setTimeout(() => {
            setTipPos(pos);
            showTipTimeoutRef.current = null;
          }, TIP_SHOW_DELAY_MS);
        }}
        onMouseLeave={() => {
          clearShowTipTimeout();
          setTipPos(null);
        }}
      >
        {text}
      </span>
      {truncated && tipPos !== null
        ? createPortal(
            <div
              className="hover-tip"
              role="tooltip"
              style={{ left: tipPos.left, top: tipPos.top }}
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function th(...parts: string[]): string {
  return [TBL_TH, ...parts].join(" ");
}

function td(...parts: string[]): string {
  return [TBL_TD, ...parts].join(" ");
}

/** th/td class presets — always use the matching pair for a column. */
export const releaseHistoryCol = {
  th: {
    release: th(FIT, "!px-[12px]"),
    note: TBL_TH,
    data: th("!px-[10px]", "!text-center"),
    actions: th(FIT, "!px-[8px]", "!text-center"),
  },
  td: {
    release: td(FIT, "!px-[12px]"),
    note: TBL_TD,
    data: td("!px-[10px]", DATA_CELL),
    actions: td(FIT, "!px-[8px]", "text-center"),
  },
} as const;

export function ReleaseHistoryTableHead({
  actionsLabel = "Actions",
}: {
  /** Pass `null` for the skeleton header (icon column, no sr-only label). */
  actionsLabel?: string | null;
}) {
  return (
    <tr>
      <th className={releaseHistoryCol.th.release}>Release</th>
      <th className={releaseHistoryCol.th.note}>Note</th>
      <th className={releaseHistoryCol.th.data}>Status</th>
      <th className={releaseHistoryCol.th.data}>Rollout</th>
      <th className={releaseHistoryCol.th.data}>Target</th>
      <th className={releaseHistoryCol.th.data}>Active</th>
      <th className={releaseHistoryCol.th.data}>Success</th>
      <th className={releaseHistoryCol.th.data}>Failed</th>
      <th
        className={releaseHistoryCol.th.actions}
        aria-hidden={actionsLabel === null ? true : undefined}
      >
        {actionsLabel === null ? null : (
          <span className="sr-only">{actionsLabel}</span>
        )}
      </th>
    </tr>
  );
}
