// Route guard for authenticated routes (redirect contract). Chosen
// shape: a react-router v7 layout route rendering <Outlet /> (not a children
// prop) so the route map nests every protected route under one element.
// While the AuthProvider boot restore is pending it renders a minimal
// unstyled centered placeholder (the design system owns real styling); unauthenticated
// users are redirected to /login carrying the current location as returnTo.

import { Navigate, Outlet, useLocation } from "react-router";

import { useSession } from "./AuthProvider";

export function RequireAuth() {
  const { bootStatus, isAuthenticated } = useSession();
  const location = useLocation();

  if (bootStatus === "restoring") {
    // Layout-only inline centering until the design system lands.
    return (
      <div
        role="status"
        className="flex min-h-screen items-center justify-center"
      >
        Restoring session…
      </div>
    );
  }

  if (!isAuthenticated) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  return <Outlet />;
}
