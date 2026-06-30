// Top-level render-crash boundary (cross-cutting error boundary). Class
// component because React only delivers render/lifecycle errors through
// getDerivedStateFromError/componentDidCatch. It wraps RouterProvider in
// App.tsx, so every route element is covered, while data
// errors never reach it (query failures surface through ErrorState, auth
// failures through RequireAuth). The fallback is a full-page error card
// built from the app grid > main > content column > .card.card-pad > .empty
// (same utilities as AppShell — the sidebar column stays empty here) and
// offers a hard reload — after a render crash React state is unreliable, so
// re-rendering in place is deliberately not offered. role="alert" announces
// the failure assertively; the icon inlines the `alert` path, the same
// convention as ErrorState.

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { buttonVariants } from "./ui/Button";
import { CARD, CARD_PAD } from "./ui/card";
import { EmptyState } from "./ui/EmptyState";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // Keep the component stack reachable for bug reports; no telemetry in MVP.
    console.error(
      "Unhandled render error caught by ErrorBoundary:",
      error,
      errorInfo.componentStack,
    );
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      // `[display:grid]` not `grid`: avoids the legacy `.grid{gap:18px}`
      // component class injecting a column gap (same as AppShell).
      return (
        <div className="[display:grid] min-h-screen grid-cols-[var(--sb-w)_1fr] max-shell:grid-cols-[1fr]">
          <main className="flex min-w-0 flex-col">
            <div className="mx-auto w-full max-w-[var(--maxw)] flex-1 p-7 max-shell:p-[18px]">
              <div className={`${CARD} ${CARD_PAD} mt-8`}>
                <EmptyState
                  role="alert"
                  tone="danger"
                  icon={<AlertIcon />}
                  title="Something went wrong"
                  description={
                    <>
                      The dashboard hit an unexpected error and can&apos;t
                      continue. Reload the page to recover.
                    </>
                  }
                  action={
                    <button
                      type="button"
                      className={buttonVariants({ intent: "primary" })}
                      onClick={reloadPage}
                    >
                      Reload page
                    </button>
                  }
                />
              </div>
            </div>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

function reloadPage(): void {
  window.location.reload();
}

// Icon path renders the `alert` glyph.
function AlertIcon() {
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
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </svg>
  );
}
