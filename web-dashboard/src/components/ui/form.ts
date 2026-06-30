// Form-control literals (legacy `.field`/`.input`/`.select`/`.textarea`/
// `.toggle` families). Created with the Stage-4 primitives; call sites adopt
// them per page stage, so the legacy CSS blocks survive until their last
// consumer flips (wholesale per element — no element carries both).
//
// Input border-color/shadow live in INPUT_STATE (normal | invalid), never in
// the base string: the legacy `.input.invalid` swapped them wholesale, and
// two co-applied classes must not set the same property (no-merge contract,
// see Button.tsx). Form controls keep the UA line-height (no explicit
// leading) except .textarea, whose legacy rule set 1.55.
export const FIELD = "mb-4 block";

export const FIELD_LABEL = "mb-[7px] block text-[13px] font-semibold text-fg";

export const FIELD_HINT = "mt-[7px] text-[12px] text-fg-3";

export const FIELD_ERR =
  "mt-[7px] flex items-center gap-[5px] text-[12px] text-red [&_svg]:size-[13px]";

export const INPUT =
  "w-full rounded-control border bg-surface px-[13px] py-2.5 text-[13.5px] text-fg [font-family:inherit] [transition:.15s] placeholder:text-fg-faint focus:outline-none";

export const INPUT_STATE = {
  normal: "border-border-strong focus:border-blue focus:shadow-glow",
  invalid: "border-red shadow-[0_0_0_4px_var(--color-red-tint)]",
} as const;

/**
 * <select> adds the chevron via the legacy `.select` background-image rule
 * (a data-URI can't live in a utility class name); compose `INPUT` +
 * `SELECT_EXTRA` + the `select` class until Stage 11 moves the arrow rule
 * into the keep-list.
 */
export const SELECT_EXTRA = "appearance-none pr-[38px]";

export const TEXTAREA_EXTRA = "min-h-[84px] resize-y leading-[1.55]";

// Toggle: the hidden checkbox is a `peer`; the track styles itself and its
// thumb (::after) off peer-checked / peer-focus-visible, replacing the
// legacy `input:checked + .track` sibling selectors.
export const TOGGLE =
  "relative inline-flex cursor-pointer items-center gap-[11px] text-[13.5px] font-medium";

export const TOGGLE_INPUT = "peer absolute opacity-0";

export const TOGGLE_TRACK =
  "relative h-6 w-[42px] flex-none rounded-pill bg-border-strong [transition:.2s] after:absolute after:left-[3px] after:top-[3px] after:size-[18px] after:rounded-pill after:bg-white after:shadow-sm after:content-[''] after:[transition:.2s] peer-checked:bg-blue peer-checked:after:translate-x-[18px] peer-focus-visible:shadow-glow";

// Range slider (legacy `.slider`). The track properties convert; the WebKit
// thumb (::-webkit-slider-thumb) and the Firefox thumb (::-moz-range-thumb)
// CANNOT be utilities, so they stay in app.css's component keep-list as the
// `.slider` thumb rules — SLIDER carries the `slider` marker so those pseudo rules
// still apply. The base sets appearance/geometry/track-fill/outline; the
// thumb owns none of those, so the keep-list rule and SLIDER never collide
// (no-merge contract, see Button.tsx).
export const SLIDER =
  "slider h-[7px] w-full appearance-none rounded-pill bg-surface-3 outline-none";

// Radio card (legacy `.radio-card` / `.radio-card.sel`). Geometry + the
// accent-colored input live on the base; selection swaps border-COLOR + bg +
// shadow wholesale via RADIO_CARD_STATE (idle | sel) — two co-applied classes
// never set the same property (no-merge contract, see Button.tsx). Idle keeps
// the legacy hover (border → blue); `.sel` pins border-blue and drops hover
// (the selected card has no hover transition in the legacy rule cascade).
export const RADIO_CARD =
  "flex cursor-pointer gap-3 rounded-md border p-3.5 [transition:.15s] [&_input]:mt-0.5 [&_input]:accent-blue";

export const RADIO_CARD_STATE = {
  idle: "border-border-strong hover:border-blue",
  sel: "border-blue bg-blue-tint shadow-glow",
} as const;

/** Legacy `.radio-card .rc-title`. */
export const RC_TITLE = "text-[13.5px] font-bold";

/** Legacy `.radio-card .rc-desc`. */
export const RC_DESC = "mt-[3px] text-[12.5px] text-fg-2";
