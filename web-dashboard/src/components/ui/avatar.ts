// Avatar literals (legacy `.av` family), shared by every consumer that builds
// a deterministic avatar: TeamSwitcher, AccountMenu, and the
// Teams/Members/Profile pages. The legacy `.av` rule set a default gradient
// and the `.av.aqua/.magenta/.yellow` modifiers REPLACED only that gradient;
// under the no-merge contract the base string here carries NO gradient and
// every tint (including the default "blue") supplies exactly one — so a tinted
// avatar never co-applies two background-image declarations.
//
// Size is the same wholesale-swap: `.av` is 30px/rounded-sm/12px, `.av.sm`
// 24px/7px/10px, `.av.lg` 56px/15px/21px. AVATAR_SIZE picks one set; the base
// omits size utilities so a sized avatar emits exactly one of each.

// Geometry + type only (no gradient, no size — those compose in). Exported so
// odd one-off sizes (the team-switch trigger's 24px/7px/11px avatar, which the
// legacy `.team-switch__btn .av` rule made distinct from `.av.sm`'s 10px text)
// can compose base + tint + an explicit single size set without co-applying two.
// `[display:grid]` not `grid`: the legacy `.grid{display:grid;gap:18px}`
// component class shares the `grid` token (the gap is moot with one child, but
// carrying the legacy class breaks the wholesale-conversion invariant).
export const AVATAR_BASE =
  "[display:grid] flex-none place-items-center font-bold uppercase tracking-[-.02em] text-white";

/** Size variants (legacy `.av` / `.av.sm` / `.av.lg`); md is the bare `.av`. */
const AVATAR_SIZE = {
  md: "size-[30px] rounded-sm text-[12px]",
  sm: "size-6 rounded-[7px] text-[10px]",
  lg: "size-14 rounded-[15px] text-[21px]",
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZE;

/** Tints replace ONLY the gradient; "blue" is the legacy default `.av`. */
export const AVATAR_TINT = {
  blue: "bg-[linear-gradient(135deg,var(--color-blue),var(--color-blue-bright))]",
  aqua: "bg-[linear-gradient(135deg,var(--color-aqua),var(--color-blue-bright))]",
  magenta: "bg-[linear-gradient(135deg,var(--color-magenta),#b517d6)]",
  yellow: "bg-[linear-gradient(135deg,var(--color-yellow),var(--color-orange))]",
} as const;

export type AvatarTint = keyof typeof AVATAR_TINT;

/** Tints in the legacy `t.color` cycle order ("" default → aqua → magenta → yellow). */
const AVATAR_TINT_CYCLE: readonly AvatarTint[] = [
  "blue",
  "aqua",
  "magenta",
  "yellow",
];

/** Full avatar class string for an explicit tint + size. */
export function avatarClass(tint: AvatarTint, size: AvatarSize = "md"): string {
  return `${AVATAR_BASE} ${AVATAR_SIZE[size]} ${AVATAR_TINT[tint]}`;
}

// Legacy `.team-switch__btn .av`: both topbar triggers (TeamSwitcher + the
// AccountMenu, which reuses team-switch__btn) sized their avatar to 24px/7px but
// 11px text — distinct from `.av.sm`'s 10px. One explicit size set (no-merge).
const TRIGGER_AVATAR_SIZE = "size-6 rounded-[7px] text-[11px]";

/** Topbar-trigger avatar (the 24px/7px/11px variant), tinted. */
export function triggerAvatarClass(tint: AvatarTint): string {
  return `${AVATAR_BASE} ${AVATAR_TINT[tint]} ${TRIGGER_AVATAR_SIZE}`;
}

/** Deterministic tint pick from an id (legacy `t.color` hash over the cycle). */
export function avatarTintFor(id: string): AvatarTint {
  let sum = 0;
  for (let index = 0; index < id.length; index += 1) {
    sum = (sum + id.charCodeAt(index)) % AVATAR_TINT_CYCLE.length;
  }
  return AVATAR_TINT_CYCLE[sum] ?? "blue";
}

/** Convenience: deterministic-tinted avatar class for an id (the common case). */
export function avatarClassFor(id: string, size: AvatarSize = "md"): string {
  return avatarClass(avatarTintFor(id), size);
}
