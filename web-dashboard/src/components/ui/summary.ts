// Mutation-summary literals (legacy `.summary` family — the UI's `--yes`
// equivalent). Shared by ConfirmDialog's summary variant and the bespoke
// previews in RollbackModal / RolloutModal / TeamOverviewPage.
export const SUMMARY =
  "my-3.5 rounded-md border border-border bg-surface-2 px-4 py-1";

export const SUMMARY_ROW =
  "flex items-center gap-3 border-b border-border py-[11px] text-[13px] last:border-b-0";

/** Left column ("Rollout", "Target" …). */
export const SUMMARY_KEY = "w-[140px] flex-none font-semibold text-fg-3";

/** Right column; lays out value + transition arrows. */
export const SUMMARY_VALUE = "flex items-center gap-2 font-semibold";

/** The `25% → 50%` transition arrow. */
export const SUMMARY_ARROW = "text-fg-faint";
