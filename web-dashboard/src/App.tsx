// App composition root. Provider order is the locked contract:
// QueryClientProvider → AuthProvider → ToastProvider → ErrorBoundary →
// RouterProvider. Query cache outermost so AuthProvider's boot restore and
// every routed screen share one cache; auth above toasts/routes so any UI can
// read the session; ErrorBoundary directly around RouterProvider so a route
// render crash swaps only the routed tree for the full-page error card while
// the toast live regions stay mounted. RouterProvider is imported from
// react-router/dom, the v7 browser entry that wires ReactDOM.flushSync, and
// both `router` and `queryClient` are module-scope singletons, so this
// component never recreates them. StrictMode lives in main.tsx.
// ThemeSync mounts beside that tree (returns null) so `data-theme` stays in
// sync after the index.html blocking script.

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router/dom";

import { AuthProvider } from "./auth/AuthProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/overlay/ToastProvider";
import { queryClient } from "./queryClient";
import { router } from "./router";
import { ThemeSync } from "./theme/ThemeSync";

export default function App() {
  return (
    <>
      <ThemeSync />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <ErrorBoundary>
              <RouterProvider router={router} />
            </ErrorBoundary>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </>
  );
}
