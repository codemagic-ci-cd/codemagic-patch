// Signing/mandatory pin literals (legacy `.pin` / `.pin.sign`). Geometry +
// type + the svg size live on the base; each tone swaps fill + bg wholesale —
// two co-applied classes never set the same property (no-merge contract, see
// Button.tsx). The bare `.pin` is the yellow "mandatory" tone; `.pin.sign` is
// green (green-deep @theme token).
export const PIN =
  "inline-flex items-center gap-[5px] rounded-[7px] px-2 py-[3px] text-[11.5px] font-bold [&_svg]:size-[13px]";

export const PIN_TONE = {
  mandatory: "bg-yellow-tint text-yellow",
  sign: "bg-green-tint text-green-deep",
} as const;

export type PinTone = keyof typeof PIN_TONE;
