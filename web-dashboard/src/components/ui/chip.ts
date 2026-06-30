// Chip literals (legacy `.chip` family), shared by the small inline status
// pills on the Teams / Profile / Invitations screens (and future stages). 1:1
// port of the legacy `.chip` / `.chip.{blue,aqua,green,yellow,magenta,red}`
// rules. Geometry, type and the 1px border WIDTH live on the base; each tone
// swaps the background / text-color / border-COLOR wholesale — two co-applied
// classes never set the same property (no-merge contract, see Button.tsx).
export const CHIP =
  "inline-flex items-center gap-1.5 rounded-[8px] border px-[9px] py-[3px] text-[11.5px] font-semibold [&_svg]:size-[13px]";

/** Tones; "neutral" is the bare `.chip` (surface-2 fill, visible border). */
export const CHIP_TONE = {
  neutral: "border-border bg-surface-2 text-fg-2",
  blue: "border-transparent bg-blue-tint text-blue",
  aqua: "border-transparent bg-aqua-tint text-[#0496c0]",
  green: "border-transparent bg-green-tint text-green-deep",
  yellow: "border-transparent bg-yellow-tint text-[#9a560f]",
  magenta: "border-transparent bg-magenta-tint text-[#a417b8]",
  red: "border-transparent bg-red-tint text-red",
} as const;

export type ChipTone = keyof typeof CHIP_TONE;
