// Callout literals (legacy `.callout` family). Geometry + the svg/`<b>`
// descendant rules live on the base; each tone swaps the border color, text
// color and the icon color wholesale — two co-applied classes never set the
// same property (no-merge contract, see Button.tsx). Callouts are outlined,
// not filled: the brand review wants inline notices to carry their tone on
// the border only, the surface stays plain. Tone text uses the @theme
// `--color-tone-*` roles so both themes stay aligned.
export const CALLOUT =
  "flex gap-[11px] rounded-md border bg-surface px-[15px] py-[13px] text-[13px]/[1.5] [&_svg]:mt-px [&_svg]:size-[18px] [&_svg]:flex-none [&_b]:font-bold";

export const CALLOUT_TONE = {
  info: "border-blue text-blue-deep [&_svg]:text-blue",
  warn: "border-yellow text-tone-warn [&_svg]:text-yellow",
  danger: "border-red text-tone-danger [&_svg]:text-red",
  green: "border-green text-tone-success [&_svg]:text-green-deep",
} as const;

export type CalloutTone = keyof typeof CALLOUT_TONE;
