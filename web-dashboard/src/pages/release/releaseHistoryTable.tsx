// Release history table layout (DeploymentDetailPage).
//
// - release / actions: shrink-to-content (w-[1%]).
// - note: default width; absorbs leftover space.
// - data: shared preset for status, rollout, target, and metric columns.

import { TBL_TD, TBL_TH } from "../../components/ui/table";

const FIT = "w-[1%] whitespace-nowrap";
const DATA_CELL =
  "text-center font-mono text-[12.5px] tabular-nums";

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
