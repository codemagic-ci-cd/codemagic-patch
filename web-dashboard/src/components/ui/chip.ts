// Chip literals (legacy `.chip` family), shared by the small inline status
// pills on the Teams / Profile / Invitations screens and by role badges.
// Geometry follows the Codemagic app's status pills (invoice "paid" etc.):
// ~24px tall, 12px semibold, 6px corners, no leading dot. The 1px border
// WIDTH lives on the base; each tone swaps the background / text-color /
// border-COLOR wholesale — two co-applied classes never set the same
// property (no-merge contract, see Button.tsx).
export const CHIP =
  "inline-flex items-center gap-1.5 rounded-[6px] border px-3 py-1 text-[12px] font-semibold leading-4 [&_svg]:size-[13px]";

/** Tones; "neutral" is the bare `.chip` (surface-2 fill, visible border). */
export const CHIP_TONE = {
  neutral: "border-border bg-surface-2 text-fg-2",
  blue: "border-transparent bg-blue-tint text-blue",
  aqua: "border-transparent bg-aqua-tint text-tone-aqua",
  green: "border-transparent bg-green-tint text-green-deep",
  yellow: "border-transparent bg-yellow-tint text-tone-yellow",
  magenta: "border-transparent bg-magenta-tint text-tone-magenta",
  red: "border-transparent bg-red-tint text-red",
  slate: "border-transparent bg-slate-tint text-tone-slate",
} as const;

/** Role badge tones (legacy `.role-*`); unknown role keys fall back to neutral. */
const ROLE_CHIP_TONE: Record<string, string> = {
  owner: CHIP_TONE.magenta,
  admin: CHIP_TONE.blue,
  developer: CHIP_TONE.aqua,
  viewer: CHIP_TONE.slate,
};

/** Full class string for a role badge (MembersPage rows/dialogs, TeamOverview). */
export function roleChipClass(roleKey: string): string {
  return `${CHIP} ${ROLE_CHIP_TONE[roleKey] ?? CHIP_TONE.neutral}`;
}

export type ChipTone = keyof typeof CHIP_TONE;
