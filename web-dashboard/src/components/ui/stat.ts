// Stat-tile literals (legacy `.stat` family on TeamOverviewPage's count
// tiles). 1:1 port of the legacy rules; the colored top strip (`.stat::after`,
// a pseudo-element painting `var(--accent)`) cannot be a utility — it stays in
// app.css's component keep-list as the `.stat-strip::after` rule, and STAT carries
// the `stat-strip` marker plus `relative overflow-hidden` so it paints.
//
// `--accent` / `--accent-tint` are injected inline by the caller (preserve that
// mechanism); the icon reads them with the legacy blue fallbacks.
export const STAT =
  "stat-strip relative overflow-hidden rounded-lg border border-border bg-surface px-5 py-[18px] shadow-sm";

export const STAT_TOP =
  "flex items-center gap-[9px] text-[12.5px] font-semibold text-fg-2";

/** Icon-chip geometry (legacy `.stat__ico` minus its accent fill/color). */
export const STAT_ICO_BASE =
  "grid size-[30px] place-items-center rounded-sm [&_svg]:size-[17px]";

/** Default accent skin; the caller injects `--accent…` inline (blue fallback). */
export const STAT_ICO_ACCENT =
  "bg-[var(--accent-tint,var(--color-blue-tint))] text-[var(--accent,var(--color-blue))]";

// The trailing unit (legacy `.stat__val small`, e.g. the success-rate "%") is a
// nested <small>: a descendant rule, not a co-applied class, so it never
// collides with the value's own size/weight (no-merge contract).
export const STAT_VAL =
  "mt-3 text-[30px] font-extrabold leading-none tracking-[-.03em] tabular-nums [&_small]:text-[15px] [&_small]:font-semibold [&_small]:text-fg-3";

export const STAT_META =
  "mt-[9px] flex items-center gap-1.5 text-[12px] text-fg-3";
