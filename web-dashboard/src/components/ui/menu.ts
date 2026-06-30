// Dropdown-menu literals (legacy `.menu` family), shared by the five
// hand-rolled dropdowns: TeamSwitcher, AccountMenu, MembersPage row actions,
// and the DeploymentDetailPage / DeploymentTable kebab menus. Styling only —
// each consumer keeps its own open/outside-click/focus behavior
// (consolidating that is a post-migration refactor, out of parity scope).
//
// Item glyphs are sized per-icon (size-[17px]) instead of a [&_svg]
// descendant rule: TeamSwitcher's trailing check glyph (size-4) would
// conflict with a descendant sizer under the no-merge contract (Button.tsx),
// and a descendant tint would out-specificity the check's own text-blue.
export const MENU =
  "absolute z-[60] mt-2 min-w-[248px] animate-pop rounded-[14px] border border-border bg-surface p-1.5 shadow-lg";

export const MENU_RIGHT = "right-0";

export const MENU_LABEL =
  "px-[11px] pb-[5px] pt-[9px] text-[10.5px] font-bold uppercase tracking-[.1em] text-fg-3";

export const MENU_SEP = "mx-1 my-1.5 h-px bg-border";

// Tone is composed alongside MENU_ITEM (never both tones at once): the
// legacy modifiers swapped the item color wholesale. Items mix <button> and
// <Link>, so line-height intentionally stays inherited per element (UA
// normal on buttons, body 1.5 on links — exactly the legacy rendering).
export const MENU_ITEM =
  "flex w-full items-center gap-[11px] rounded-sm border-0 bg-transparent px-[11px] py-[9px] text-left text-[13.5px] font-medium hover:bg-surface-2";

export const MENU_ITEM_TONE = {
  default: "text-fg",
  active: "text-blue",
  danger: "text-red",
  /** Informational rows (legacy `.muted` inside a menu). */
  muted: "text-fg-3",
} as const;

/** Standard 17px item glyph; idle items tint it text-fg-3 explicitly. */
export const MENU_ICON = "size-[17px]";

/** Trailing checkmark on the active team row. */
export const MENU_CHECK = "ml-auto size-4 text-blue";

export const KEBAB = "relative";

export const KEBAB_BTN =
  "grid size-8 place-items-center rounded-sm border border-transparent bg-transparent text-fg-3 [transition:.13s] hover:bg-surface-3 hover:text-fg [&_svg]:size-[18px]";
