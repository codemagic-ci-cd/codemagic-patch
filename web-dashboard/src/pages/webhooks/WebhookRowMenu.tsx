// The "more" menu on a webhook row, for the actions used less often than
// Send test and Deliveries. Same open/outside-click/Esc behavior as the other
// hand-rolled row menus (see ui/menu.ts); the panel is portaled so the table's
// scroll wrapper cannot clip it.

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { DropdownPanel } from "../../components/ui/DropdownPanel";
import {
  KEBAB,
  KEBAB_BTN,
  MENU_ITEM,
  MENU_ITEM_TONE,
  MENU_SEP,
} from "../../components/ui/menu";
import type { Webhook } from "../../model/webhook";

interface WebhookRowMenuProps {
  onDelete: () => void;
  onEdit: () => void;
  onRotateSecret: () => void;
  onToggleStatus: () => void;
  webhook: Webhook;
}

export function WebhookRowMenu({
  onDelete,
  onEdit,
  onRotateSecret,
  onToggleStatus,
  webhook,
}: WebhookRowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = `Actions for ${webhook.url}`;

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      // The panel is portaled out of `rootRef`, so it counts as inside too.
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target) !== true &&
        menuRef.current?.contains(event.target) !== true
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
    if (open && event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  const item = (text: string, run: () => void, tone: string = MENU_ITEM_TONE.default) => (
    <button
      type="button"
      className={`${MENU_ITEM} ${tone}`}
      role="menuitem"
      onClick={() => {
        setOpen(false);
        run();
      }}
    >
      {text}
    </button>
  );

  return (
    <div className={`${KEBAB} inline-block`} ref={rootRef} onKeyDown={handleKeyDown}>
      <button
        type="button"
        className={KEBAB_BTN}
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="19" r="1.6" fill="currentColor" />
        </svg>
      </button>
      <DropdownPanel
        open={open}
        anchorRef={buttonRef}
        menuRef={menuRef}
        menuId={menuId}
        label={label}
      >
        {item("Edit", onEdit)}
        {item(webhook.status === "active" ? "Disable" : "Enable", onToggleStatus)}
        {item("Rotate secret", onRotateSecret)}
        <div className={MENU_SEP} />
        {item("Delete", onDelete, MENU_ITEM_TONE.danger)}
      </DropdownPanel>
    </div>
  );
}
