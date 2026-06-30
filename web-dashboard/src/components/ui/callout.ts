// Callout literals (legacy `.callout` family). 1:1 port of the legacy rules:
// geometry + the svg/`<b>` descendant rules live on the base; each tone swaps
// the fill, text color and the icon color wholesale — two co-applied classes
// never set the same property (no-merge contract, see Button.tsx). The
// hardcoded tone text hexes have no @theme token, so they stay hex.
export const CALLOUT =
  "flex gap-[11px] rounded-md px-[15px] py-[13px] text-[13px]/[1.5] [&_svg]:mt-px [&_svg]:size-[18px] [&_svg]:flex-none [&_b]:font-bold";

export const CALLOUT_TONE = {
  info: "bg-blue-tint text-[#1a3da8] [&_svg]:text-blue",
  warn: "bg-yellow-tint text-[#8a5414] [&_svg]:text-yellow",
  danger: "bg-red-tint text-[#9a0a30] [&_svg]:text-red",
  green: "bg-green-tint text-[#0a6e4f] [&_svg]:text-green-deep",
} as const;

export type CalloutTone = keyof typeof CALLOUT_TONE;

/** Legacy `.callout.is-block`: a 22%-mix border tracking the tone's text color. */
export const CALLOUT_BLOCK =
  "border border-[color-mix(in_srgb,currentColor_22%,transparent)]";
