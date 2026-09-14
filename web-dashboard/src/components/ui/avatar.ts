// Avatar literals (legacy `.av` family), shared by every consumer that builds
// a deterministic avatar: the Teams/Members/Profile pages. The legacy `.av`
// rule painted a gradient and cycled per-id tints; the brand pass replaced
// that with one solid fill — the Codemagic app draws every avatar in the
// same brand blue — so the only variant left is size.
//
// Size is a wholesale swap: `.av` is 30px/rounded-sm/12px, `.av.sm`
// 24px/7px/10px, `.av.lg` 56px/15px/21px. AVATAR_SIZE picks one set; the base
// omits size utilities so a sized avatar emits exactly one of each.

// Geometry + type + fill (no size — that composes in). Exported so odd
// one-off sizes (the team-switch trigger's 24px/7px/11px avatar, which the
// legacy `.team-switch__btn .av` rule made distinct from `.av.sm`'s 10px text)
// can compose base + an explicit single size set without co-applying two.
// `[display:grid]` not `grid`: the legacy `.grid{display:grid;gap:18px}`
// component class shares the `grid` token (the gap is moot with one child, but
// carrying the legacy class breaks the wholesale-conversion invariant).
export const AVATAR_BASE =
  "[display:grid] flex-none place-items-center bg-blue font-bold uppercase tracking-[-.02em] text-white";

/** Size variants (legacy `.av` / `.av.sm` / `.av.lg`); md is the bare `.av`. */
const AVATAR_SIZE = {
  md: "size-[30px] rounded-sm text-[12px]",
  sm: "size-6 rounded-[7px] text-[10px]",
  lg: "size-14 rounded-[15px] text-[21px]",
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZE;

/** Full avatar class string for a size. */
export function avatarClass(size: AvatarSize = "md"): string {
  return `${AVATAR_BASE} ${AVATAR_SIZE[size]}`;
}
