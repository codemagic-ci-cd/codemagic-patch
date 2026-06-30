// Definition-list literals (legacy `.dl dt` / `.dl dd`), shared by the metadata
// panels on ReleaseDetail / Metrics / Profile. The last row of each type drops
// its divider (legacy `:last-of-type` border-bottom:0). Apply `DL` to the <dl>
// itself; DL_DT / DL_DD to the <dt> / <dd>.
//
// DL_DD carries `min-w-0 [overflow-wrap:anywhere]` so a single long unbreakable
// value (e.g. a long account email) wraps within its row instead of forcing the
// 1fr track — and the whole grid — past the min-w-0 content area on narrow phones.
export const DL = "grid-cols-[auto_1fr] [display:grid]";

export const DL_DT =
  "whitespace-nowrap border-b border-border py-3 pr-[22px] text-[12.5px] font-semibold text-fg-3 last-of-type:border-b-0";

export const DL_DD =
  "m-0 flex min-w-0 flex-wrap items-center gap-[9px] border-b border-border py-3 font-medium [overflow-wrap:anywhere] last-of-type:border-b-0";
