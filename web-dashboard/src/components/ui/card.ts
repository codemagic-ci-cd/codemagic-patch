// Card / panel literals (legacy `.card` family), shared by ErrorBoundary,
// MetricsPage and ReleaseDetailPage. 1:1 port of the legacy
// `.card` / `.card-pad` / `.card-head` rules. The `.card-head h3` rule was a
// descendant selector (font size + weight on a class-less <h3>), so it stays a
// `[&_h3]` descendant here rather than a co-applied class — exactly the legacy
// rendering, and never colliding with another class under the no-merge
// contract (see Button.tsx).
export const CARD =
  "rounded-lg border border-border bg-surface shadow-sm";

export const CARD_PAD = "p-[22px]";

export const CARD_HEAD =
  "flex items-center gap-3 border-b border-border px-[22px] py-[18px] [&_h3]:text-[15px] [&_h3]:font-bold";

/** Legacy `.card-head .right`: trailing action cluster pinned right. */
export const CARD_HEAD_RIGHT = "ml-auto flex items-center gap-2";
