// Mobile topbar: hamburger + brand home link. Below --breakpoint-shell the
// sidebar is hidden, so this bar keeps navigation and branding reachable.
// Desktop chrome lives in the sidebar (including Profile); this header is
// `hidden` above the shell breakpoint so it does not leave an empty strip.

import { Link } from "react-router";

import { PRODUCT_NAME } from "../../branding";
import { PatchBrand } from "../brand/PatchBrand";

export interface TopBarProps {
  /** Opens the sub-760px navigation drawer (MobileNavDrawer). */
  onOpenNav: () => void;
  /** Opens the ⌘K command palette — the touch equivalent of the shortcut. */
  onOpenPalette: () => void;
  /** Home target for the mobile brand link (active team, or `/`). */
  homeTo: string;
}

export function TopBar({ onOpenNav, onOpenPalette, homeTo }: TopBarProps) {
  // Mobile-only. Lives above the content scrollport, so it stays put
  // without a sticky offset; the evaluation banner is a sibling above
  // the shell grid.
  return (
    <header className="z-30 hidden items-center gap-3.5 border-b border-border bg-[color-mix(in_srgb,var(--color-canvas)_82%,transparent)] px-4 py-2.5 backdrop-blur-[14px] max-shell:flex">
      <button
        type="button"
        className="grid size-9 flex-none place-items-center rounded-control border border-border-strong bg-surface text-fg-2 [transition:.15s] hover:border-action-primary hover:text-fg [&_svg]:size-[19px]"
        aria-label="Open navigation"
        aria-haspopup="dialog"
        onClick={onOpenNav}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <Link to={homeTo} className="flex items-center" aria-label={PRODUCT_NAME}>
        <PatchBrand decorative className="h-7 w-auto" />
      </Link>
      <button
        type="button"
        className="ml-auto grid size-9 flex-none place-items-center rounded-control border border-border-strong bg-surface text-fg-2 [transition:.15s] hover:border-action-primary hover:text-fg [&_svg]:size-[19px]"
        aria-label="Search commands"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={onOpenPalette}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
      </button>
    </header>
  );
}
