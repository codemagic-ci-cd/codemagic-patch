// Status-pill literals shared by StatusChip (release status), JobBadge
// (worker-job status) and the DeploymentDetailPage header pill. 1:1 port of
// the legacy `.status` / `.st-*` / `.led` rules; tones are semantic so the
// two chips keep their palettes aligned where states overlap (failed, etc.).
export const STATUS_PILL =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill py-1 pl-2 pr-2.5 text-[12px] font-bold tracking-[-.01em]";

export const STATUS_LED =
  "size-[7px] rounded-pill bg-current shadow-[0_0_0_3px_color-mix(in_srgb,currentColor_22%,transparent)]";

/** Pulsing led for in-flight states (legacy `.live`). */
export const STATUS_LED_LIVE = "animate-led-pulse";

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
  slate: "bg-slate-tint text-[#5a6480]",
  red: "bg-red-tint text-red",
  muted: "bg-surface-3 text-[#5b6480]",
  amber: "bg-yellow-tint text-[#7a675a]",
  dead: "bg-[#7a0a25] text-white",
};
