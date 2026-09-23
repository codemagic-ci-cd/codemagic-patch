// Status literals shared by StatusChip (release status: grey label + led) and
// JobBadge (worker-job status: filled pill). Tones stay semantic so the two
// keep their palettes aligned where states overlap (failed, etc.).
export const STATUS_PILL =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill py-1 pl-2 pr-2.5 text-[12px] font-bold tracking-[-.01em]";

export const STATUS_LED =
  "size-[7px] rounded-pill bg-current shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_22%,transparent)]";

/** Pulsing led for in-flight states (legacy `.live`). */
export const STATUS_LED_LIVE = "animate-led-pulse";

/** Label row for StatusChip: grey text, tone lives on the led only. */
export const STATUS_LABEL =
  "inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-semibold tracking-[-.01em] text-fg-2";

export type StatusTone =
  | "green"
  | "blue"
  | "slate"
  | "red"
  | "muted"
  | "amber"
  | "dead";

export const STATUS_TONE: Record<StatusTone, string> = {
  green: "bg-green-tint text-green-deep",
  blue: "bg-blue-tint text-blue",
  slate: "bg-slate-tint text-tone-slate",
  red: "bg-red-tint text-red",
  muted: "bg-surface-3 text-tone-muted",
  amber: "bg-yellow-tint text-tone-amber",
  dead: "bg-dead text-white",
};

/** Led `currentColor` when the label is grey rather than the pill tone. */
export const STATUS_DOT_TONE: Record<StatusTone, string> = {
  green: "text-green",
  blue: "text-blue",
  slate: "text-tone-slate",
  red: "text-red",
  muted: "text-tone-muted",
  amber: "text-tone-amber",
  dead: "text-dead",
};
