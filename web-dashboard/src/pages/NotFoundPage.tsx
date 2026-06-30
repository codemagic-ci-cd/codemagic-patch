// 404 catch-all for the route map `*`.
// Mounted inside the guarded AppShell (the shell wraps ALL
// guarded routes), so this page renders only the content column — the card
// with the empty state. The shared <Breadcrumbs/> derives nothing
// from unmatched paths (renders null for most), so a static "404"
// crumb is reproduced here. "Back to
// overview" targets `/`, whose loader re-runs the last-team redirect. Icon
// inlines the `zap` path.

import { Link } from "react-router";

import { EmptyState } from "../components/ui/EmptyState";
import { buttonVariants } from "../components/ui/Button";

export function NotFoundPage() {
  return (
    <>
      <nav
        className="mb-[18px] flex items-center gap-2 text-[13px] font-medium text-fg-3"
        aria-label="Breadcrumb"
      >
        <span className="font-semibold text-fg" aria-current="page">
          404
        </span>
      </nav>
      <div className="mt-8 rounded-lg border border-border bg-surface p-[22px] shadow-sm">
        <EmptyState
          icon={<ZapIcon />}
          title="Page not found"
          description="That route doesn't exist or you don't have access to it."
          action={
            <Link className={buttonVariants({ intent: "primary" })} to="/">
              Back to overview
            </Link>
          }
        />
      </div>
    </>
  );
}

// Icon path uses the lucide-style `zap` glyph.
function ZapIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
