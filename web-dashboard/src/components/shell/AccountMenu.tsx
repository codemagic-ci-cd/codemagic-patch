// Account avatar menu (topbar-right: avatar → Profile / API Tokens /
// Logout; `displayName ?? email` fallback). Identity comes from
// useSession() — the credential store's SessionUser is synchronous, so the
// topbar renders immediately (a skeleton avatar covers the brief boot-restore
// window). Logout calls logoutSession() (best-effort revoke, guaranteed
// local clear) and then navigates to /login per the task contract.
// DOM/classes follow the topbar structure — including its
// inline-styled identity header — except the dead "Documentation" item (this
// menu is fixed to Profile / API tokens / Log out). Keyboard: Esc
// closes and refocuses the trigger, first item focused on open,
// ArrowUp/Down cycle, outside pointerdown closes.

import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import { useSession } from "../../auth/AuthProvider";
import { logoutSession } from "../../auth/webConfig";
import { avatarClass, triggerAvatarClass } from "../ui/avatar";
import { Skeleton } from "../ui/Skeleton";
import type { SessionUser } from "../../api/types";
import {
  MENU,
  MENU_ICON,
  MENU_ITEM,
  MENU_ITEM_TONE,
  MENU_RIGHT,
  MENU_SEP,
} from "../ui/menu";

export function AccountMenu() {
  const { user } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current !== null &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    }
  }, [open]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveMenuItemFocus(menuRef.current, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusMenuItemEdge(menuRef.current, event.key === "Home" ? "first" : "last");
    }
  };

  const handleLogout = async () => {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    try {
      await logoutSession();
    } finally {
      setOpen(false);
      void navigate("/login");
    }
  };

  return (
    <div className="relative" ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="flex items-center gap-2.5 rounded-control border border-border-strong bg-surface py-[5px] pl-[5px] pr-[7px] text-[13.5px] font-semibold text-fg shadow-xs [transition:.15s] hover:border-blue hover:shadow-glow"
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Account menu"
        onClick={() => setOpen((value) => !value)}
      >
        {user === null ? (
          <Skeleton width={30} height={30} />
        ) : (
          <span className={triggerAvatarClass("blue")}>
            {userInitials(user)}
          </span>
        )}
        <MenuIcon className="size-[15px] text-fg-3">
          <polyline points="6 9 12 15 18 9" />
        </MenuIcon>
      </button>
      {open && (
        <div className={`${MENU} ${MENU_RIGHT}`}>
          {/* Identity header sits OUTSIDE role=menu — it is not a menuitem, and
              nesting a plain div in role=menu is invalid for assistive tech. */}
          <div className="flex items-center gap-[11px] pt-[11px] px-3 pb-[9px]">
            {user === null ? (
              <>
                <Skeleton width={30} height={30} />
                <div className="min-w-0">
                  <Skeleton width={120} variant="text" />
                  <Skeleton width={150} variant="text" />
                </div>
              </>
            ) : (
              <>
                <span className={avatarClass("blue")}>{userInitials(user)}</span>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-bold">
                    {user.displayName ?? user.email}
                  </div>
                  <div className="text-[12px] text-fg-3">
                    {user.email}
                  </div>
                </div>
              </>
            )}
          </div>
          <div className={MENU_SEP} />
          <div id={menuId} role="menu" aria-label="Account" ref={menuRef}>
            <Link
              className={`${MENU_ITEM} ${MENU_ITEM_TONE.default}`}
              role="menuitem"
              to="/account/profile"
              onClick={() => setOpen(false)}
            >
              <MenuIcon className={`${MENU_ICON} text-fg-3`}>
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21v-1a6 6 0 0 1 12 0v1" />
              </MenuIcon>
              Profile
            </Link>
            <Link
              className={`${MENU_ITEM} ${MENU_ITEM_TONE.default}`}
              role="menuitem"
              to="/account/tokens"
              onClick={() => setOpen(false)}
            >
              <MenuIcon className={`${MENU_ICON} text-fg-3`}>
                <circle cx="7.5" cy="15.5" r="4.5" />
                <path d="m10.7 12.3 8.8-8.8M16 6l3 3M14 8l2 2" />
              </MenuIcon>
              API tokens
            </Link>
            <div className={MENU_SEP} />
            <button
              type="button"
              className={`${MENU_ITEM} ${MENU_ITEM_TONE.danger}`}
              role="menuitem"
              disabled={signingOut}
              onClick={() => {
                void handleLogout();
              }}
            >
              <MenuIcon className={`${MENU_ICON} text-red`}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </MenuIcon>
              {signingOut ? "Signing out…" : "Log out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Up to two initials from `displayName ?? email` (email → its local part). */
function userInitials(user: SessionUser): string {
  const source = user.displayName ?? emailLocalPart(user.email);
  const words = source.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined) {
    return "?";
  }
  const second = words[1];
  if (second === undefined) {
    return first.slice(0, 2).toUpperCase();
  }
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function emailLocalPart(email: string): string {
  const atIndex = email.indexOf("@");
  return atIndex > 0 ? email.slice(0, atIndex) : email;
}

/** Focusable menu items (skips aria-disabled and natively-disabled controls,
 *  e.g. the busy "Log out" button, which cannot receive focus). */
function enabledMenuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>("[role='menuitem']"),
  ).filter(
    (item) =>
      item.getAttribute("aria-disabled") !== "true" &&
      !(item instanceof HTMLButtonElement && item.disabled),
  );
}

/** ArrowUp/Down focus cycling among the menu's items (wraps; enters from the trigger). */
function moveMenuItemFocus(menu: HTMLElement | null, delta: number): void {
  if (menu === null) {
    return;
  }
  const items = enabledMenuItems(menu);
  if (items.length === 0) {
    return;
  }
  const index = items.findIndex((item) => item === document.activeElement);
  const nextIndex =
    index === -1
      ? delta > 0
        ? 0
        : items.length - 1
      : (index + delta + items.length) % items.length;
  items[nextIndex]?.focus();
}

/** Home/End jump to the first/last enabled menu item. */
function focusMenuItemEdge(menu: HTMLElement | null, edge: "first" | "last"): void {
  if (menu === null) {
    return;
  }
  const items = enabledMenuItems(menu);
  if (items.length === 0) {
    return;
  }
  (edge === "first" ? items[0] : items[items.length - 1])?.focus();
}

function MenuIcon({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
