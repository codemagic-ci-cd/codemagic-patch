import type { ReactNode } from "react";

import { PAGE_SUB, PAGE_TITLE } from "./typography";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

/** Shared management-page heading, description, and optional action region. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start gap-[18px]">
      <div className="min-w-0 flex-1">
        <h1 className={PAGE_TITLE}>{title}</h1>
        {description !== undefined ? (
          <p className={PAGE_SUB}>{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="flex items-center gap-2.5">{actions}</div>
      ) : null}
    </div>
  );
}
