// Portal-rendered dropdown panel for the hand-rolled row kebab menus
// (DeploymentTable / DeploymentDetailPage / MembersPage). The legacy `.menu`
// panel was an `absolute` child of the `.kebab` wrapper, so it was clipped by
// the `overflow-auto` table wrapper (TBL_WRAP) — a wide table needs horizontal
// scroll, and CSS forces the cross-axis (`overflow-y`) to compute as `auto`
// too, so the panel could never escape the wrapper with overflow alone.
//
// Rendering the panel through a portal to <body> with `position: fixed`
// anchored to the trigger's bounding box takes it out of every clipping
// ancestor while keeping the right-aligned look. The trigger keeps owning
// open-state / outside-click / Esc / Arrow focus behavior; this only relocates
// and positions the panel. Because the portal stays a child of the trigger in
// the React tree, keydown still bubbles to the wrapper's onKeyDown handler.

import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";

import { MENU } from "./menu";

/** Gap between the trigger and the panel (matches the legacy `mt-2`). */
const PANEL_GAP = 8;
/** Min viewport inset kept on the right/top/bottom edges. */
const VIEWPORT_INSET = 8;

export interface DropdownPanelProps {
  open: boolean;
  /** Trigger the panel is anchored to (right edge + below, flips up if needed). */
  anchorRef: RefObject<HTMLElement | null>;
  /** Attached to the panel so the owner can drive focus/queries on its items. */
  menuRef: RefObject<HTMLDivElement | null>;
  menuId: string;
  /** `aria-label` for the `role="menu"` panel. */
  label: string;
  /** The `role="menuitem"` rows. */
  children: ReactNode;
}

/**
 * Right-aligned dropdown panel anchored to `anchorRef`, portaled to <body> so
 * no `overflow` ancestor can clip it. Repositions on scroll/resize and flips
 * above the trigger when there isn't room below.
 */
export function DropdownPanel({
  open,
  anchorRef,
  menuRef,
  menuId,
  label,
  children,
}: DropdownPanelProps) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      if (anchor === null) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const right = Math.max(VIEWPORT_INSET, window.innerWidth - rect.right);
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      let top = rect.bottom + PANEL_GAP;
      // Flip above the trigger when the panel would overflow the viewport
      // bottom and there is more room above than below.
      const roomBelow = window.innerHeight - rect.bottom - PANEL_GAP;
      const roomAbove = rect.top - PANEL_GAP;
      if (menuHeight > roomBelow && roomAbove > roomBelow) {
        top = Math.max(VIEWPORT_INSET, rect.top - PANEL_GAP - menuHeight);
      }
      setPos({ top, right });
    };
    update();
    // Capture-phase scroll catches the table's own scroll container too.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, anchorRef, menuRef]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className={MENU}
      id={menuId}
      role="menu"
      aria-label={label}
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        right: pos?.right ?? VIEWPORT_INSET,
        // Inline position overrides the literal's `absolute`; `mt-2`'s margin is
        // neutralized so the gap lives entirely in `top` (correct when flipped).
        marginTop: 0,
        // Hidden for the first layout pass until measured, so it never flashes
        // at the wrong spot.
        visibility: pos === null ? "hidden" : "visible",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
