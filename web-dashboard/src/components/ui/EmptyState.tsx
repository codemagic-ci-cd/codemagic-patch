// Empty-state region (mandatory screen state). Visual contract: the `.empty`
// markup (`.empty > .empty__ico + h3 + p + .btn`), ported to utility literals.
// The icon and action are slots so each screen supplies its own glyph and CTA.
// ErrorState renders through this shell with the danger icon tone (legacy
// `.empty__ico.danger`).

import { clsx } from "clsx";
import type { AriaRole, ReactNode } from "react";

export interface EmptyStateProps {
  /** Glyph rendered inside the tinted icon square (decorative). */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Action slot, e.g. a primary Button or a CliCommandBuilder. */
  action?: ReactNode;
  /** Icon tint: default blue, "danger" red (ErrorState). */
  tone?: "default" | "danger";
  /** Region role, e.g. "alert" for blocking errors (ErrorState). */
  role?: AriaRole;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "default",
  role,
}: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center gap-1.5 px-6 py-[52px] text-center"
      role={role}
    >
      {icon !== undefined ? (
        <div
          className={clsx(
            "mb-2 grid size-16 place-items-center rounded-lg [&_svg]:size-[30px]",
            tone === "danger" ? "bg-red-tint text-red" : "bg-blue-tint text-blue",
          )}
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-[17px] font-extrabold">{title}</h3>
      {description !== undefined ? (
        <p className="mt-[2px] mb-4 max-w-[46ch] text-fg-2">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
