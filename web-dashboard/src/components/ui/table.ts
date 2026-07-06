// Table literals (legacy `.tbl` family — `.tbl-wrap`, `.tbl`, th/td/tr rules).
// 1:1 port of the legacy rules; header/cell styling lives on each th/td, the
// row carries the hover tint and drops the divider on the last row's cells
// (legacy `tbody tr:last-child td{border-bottom:0}`). Shared by the
// MembersPage / Tokens / Apps tables.
export const TBL_WRAP = "overflow-auto";

export const TBL = "w-full border-collapse text-[13.5px]";

export const TBL_TH =
  "border-b border-border bg-surface-2 px-[18px] py-[13px] text-left text-[11px] font-bold uppercase tracking-[.06em] whitespace-nowrap text-fg-3";

export const TBL_TD = "border-b border-border px-[18px] py-[15px] align-middle";

export const TBL_TR =
  "[transition:.12s] hover:bg-surface-2 [&:last-child>td]:border-b-0";

/** Right-aligned column (legacy `.tbl .right`), on a th or td. */
export const TBL_RIGHT = "text-right";

/**
 * Numeric column (legacy `.tbl .num`): right-aligned tabular mono, slightly
 * smaller than the body cell. Only ever co-applied with TBL_TD on a <td>; the
 * font-size/family it sets are distinct from TBL_TD's (no-merge contract).
 */
export const TBL_NUM =
  "text-right font-mono text-[12.5px] tabular-nums";
