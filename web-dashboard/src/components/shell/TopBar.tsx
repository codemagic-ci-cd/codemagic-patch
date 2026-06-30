// Topbar (account avatar menu, right). The team switcher was removed
// with self-host single-team mode — there is exactly one fixed team, so there
// is nothing to switch between; the active team's name still shows in the
// sidebar header and breadcrumbs. A global search box and
// notification bell are intentionally out of OSS scope (no non-functional UI is
// shipped). Below --breakpoint-shell the sidebar is hidden, so the topbar grows
// a hamburger + brand home link to keep navigation and branding reachable.
// AccountMenu renders immediately (its data-dependent labels skeleton internally).

import { Link } from "react-router";

import { PRODUCT_NAME } from "../../branding";
import { AccountMenu } from "./AccountMenu";

export interface TopBarProps {
  /** Opens the sub-760px navigation drawer (MobileNavDrawer). */
  onOpenNav: () => void;
  /** Home target for the mobile brand link (active team, or `/`). */
  homeTo: string;
}

export function TopBar({ onOpenNav, homeTo }: TopBarProps) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3.5 border-b border-border bg-[rgba(255,255,255,.82)] px-7 py-3 backdrop-blur-[14px] max-shell:px-4 max-shell:py-2.5">
      <button
        type="button"
        className="hidden size-9 flex-none place-items-center rounded-control border border-border-strong bg-surface text-fg-2 [transition:.15s] hover:border-blue hover:text-fg [&_svg]:size-[19px] max-shell:[display:grid]"
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
      <Link
        to={homeTo}
        className="hidden items-center gap-2 font-extrabold text-fg max-shell:flex"
        aria-label={PRODUCT_NAME}
      >
        <span className="grid size-7 flex-none place-items-center rounded-[8px] bg-[linear-gradient(135deg,var(--color-blue),var(--color-aqua))] [&_svg]:size-4">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 2.2l2.2 6.1 6.1 2.2-6.1 2.2L12 18.8l-2.2-6.1L3.7 10.5l6.1-2.2z"
              fill="#fff"
            />
          </svg>
        </span>
        <span className="text-[14.5px] tracking-[-.02em]">Codemagic</span>
      </Link>
      <div className="flex-1" />
      <AccountMenu />
    </header>
  );
}
