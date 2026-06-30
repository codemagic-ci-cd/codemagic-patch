// Topbar / inline icon-button literal (legacy `.icon-btn`), shared by the
// AppDetailPage rename button, ReleaseDetailPage worker-job refresh, and the
// DeploymentTable retry affordance. 1:1 port of the legacy `.icon-btn` rule
// (geometry skin + the `:hover` state), MINUS the parts every call site sets
// itself so two co-applied classes never set one property (no-merge contract,
// see Button.tsx):
//   - width/height: each consumer supplies its own `size-*`.
//   - border-radius: 11px (`rounded-control`) for the topbar buttons, but the
//     DeploymentTable retry pill wants `rounded-[7px]`, so radius stays a
//     per-call-site class.
//   - the legacy `.icon-btn svg{18px}` descendant: emitted by the call site as
//     `[&_svg]:size-[18px]`, except DeploymentTable, whose child icon carries
//     its own `size-[13px]` — keeping svg sizing off the shared literal avoids
//     a descendant-vs-direct utilities-layer collision on that icon.
// The legacy fill was the surface token; the one call site that passed
// `bg-white` over it (ReleaseDetailPage) is the same color, so it drops the
// redundant override and inherits `bg-surface` here.
export const ICON_BTN =
  "relative grid place-items-center border border-border bg-surface text-fg-2 [transition:.15s] hover:border-border-strong hover:text-fg hover:shadow-xs";
