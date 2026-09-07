// Row-level click affordance for `.tbl` rows whose first cell already links to
// a detail page.
//
// The <Link> keeps owning navigation semantics — keyboard focus, middle-click,
// "open in new tab", the status-bar URL preview. This is strictly a pointer
// convenience layered on top, so it deliberately stands down whenever the click
// belongs to something else: an interactive descendant (the row kebab, a copy
// button, the link itself), a modified click the browser would handle its own
// way, or a click that merely ends a text selection in a cell.

import type { MouseEvent } from "react";

/** Co-apply with TBL_TR on a row that carries these handlers. */
export const TBL_TR_CLICKABLE = "cursor-pointer";

const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
].join(", ");

export function shouldActivateRow(event: MouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) {
    return false;
  }

  // Cmd/Ctrl/Shift/middle clicks mean "open elsewhere"; a programmatic
  // navigate() would swallow that intent, so leave them to the row's <a>.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }

  if (
    event.target instanceof Element &&
    event.target.closest(INTERACTIVE_SELECTOR) !== null
  ) {
    return false;
  }

  return (window.getSelection()?.toString() ?? "") === "";
}

/**
 * Props for a `<tr>` that should navigate as a whole:
 * `<tr {...clickableRowProps(TBL_TR, () => void navigate(path))}>`.
 *
 * The row's base class is taken as an argument rather than merged by the
 * caller, so spreading can never clobber the `className` the row needs for its
 * hover tint and divider rules.
 */
export function clickableRowProps(
  baseClassName: string,
  onActivate: () => void,
): {
  className: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
} {
  return {
    className: `${baseClassName} ${TBL_TR_CLICKABLE}`,
    onClick: (event) => {
      if (!shouldActivateRow(event)) {
        return;
      }
      onActivate();
    },
  };
}
