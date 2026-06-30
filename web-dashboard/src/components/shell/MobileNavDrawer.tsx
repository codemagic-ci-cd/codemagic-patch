// Sub-760px navigation drawer. Below --breakpoint-shell the desktop sidebar is
// `display:none` (Sidebar.tsx `max-shell:hidden`) and the TopBar holds only the
// account menu, so primary nav would otherwise be unreachable. The TopBar
// hamburger opens this off-canvas drawer, which re-renders the shared
// SidebarBody behind a focus trap mirroring the Modal contract: focus moves in
// on open and restores to the opener on close, Esc / overlay-click close, body
// scroll is locked, Tab cycles inside, and links close the drawer on tap. It
// also auto-closes if the viewport grows past the breakpoint while open.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { SidebarBody } from "./Sidebar";

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface MobileNavDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Active team id (route param or last-team fallback); null hides team nav. */
  teamId: string | null;
}

export function MobileNavDrawer({ open, onClose, teamId }: MobileNavDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0);

    (focusables()[0] ?? panel).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const activeInPanel = active !== null && panel.contains(active);
      if (event.shiftKey) {
        if (!activeInPanel || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
      } else if (!activeInPanel || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Resizing up to a width where the desktop sidebar reappears makes the
    // drawer redundant — close it (and release the scroll lock) instead of
    // leaving an invisible CSS-hidden overlay with body scroll still locked.
    const wideQuery = window.matchMedia("(min-width: 760px)");
    const handleWide = (event: MediaQueryListEvent) => {
      if (event.matches) {
        onCloseRef.current();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    wideQuery.addEventListener("change", handleWide);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      wideQuery.removeEventListener("change", handleWide);
      document.body.style.overflow = previousBodyOverflow;
      if (opener !== null && opener.isConnected) {
        opener.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex animate-fade bg-[rgba(10,14,34,.5)] backdrop-blur-[4px] shell:hidden"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        tabIndex={-1}
        className="sb-art flex h-full w-[272px] max-w-[82vw] animate-drawer-in flex-col overflow-y-auto border-r border-sb-border bg-sb-bg text-sb-text shadow-lg"
      >
        <SidebarBody teamId={teamId} collapsed={false} onNavigate={onClose} />
      </div>
    </div>,
    document.body,
  );
}
