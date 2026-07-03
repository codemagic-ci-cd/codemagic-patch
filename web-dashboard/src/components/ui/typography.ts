// Typography literals — the lone survivor of the legacy page-header / heading
// family (`.page-head`/`.page-title` etc. converted inline in Stage 9). 1:1
// port of the legacy `.section-title` rule; shared by MetricsPage and
// ReleaseDetailPage section headings.
export const SECTION_TITLE =
  "flex items-center gap-2.5 text-[16px] font-bold tracking-[-.01em]";

// Page-header literals (legacy `.page-title` / `.page-sub`), shared by every
// page's <h1> and its lede paragraph. Previously hand-rolled byte-identically
// across ~11 pages — a single source so a scale tweak lands everywhere.
export const PAGE_TITLE =
  "flex items-center gap-3 text-[27px] font-extrabold leading-[1.1] tracking-[-.025em]";

export const PAGE_SUB = "mt-1.5 max-w-[62ch] text-[14px] text-fg-2";
