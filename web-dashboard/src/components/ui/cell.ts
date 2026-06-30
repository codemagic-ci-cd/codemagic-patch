// Table-cell content literals (legacy `.cell-main` / `.cell-sub` / `.cell-app`
// / `.app-ico`). 1:1 port of the legacy rules — the primary/secondary line
// pairs and the app identicon used inside `.tbl` rows. `.app-ico`'s 10px
// radius is off-grid (no @theme token) so it stays arbitrary; the gradient
// fill is injected inline by callers (decorative identicon).
export const CELL_MAIN = "flex items-center gap-2.5 font-bold text-fg";

export const CELL_SUB = "mt-0.5 text-[12px] text-fg-3";

export const CELL_APP = "flex items-center gap-[11px]";

export const APP_ICO =
  "grid size-[34px] flex-none place-items-center rounded-[10px] text-[13px] font-extrabold text-white";
