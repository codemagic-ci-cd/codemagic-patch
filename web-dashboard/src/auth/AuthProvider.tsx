// Session context for the SPA: exposes the credential store to
// React via useSyncExternalStore and performs the boot-time session restore —
// when a refresh token survived the reload but no access token is in memory,
// exactly one refresh rotation (the client's shared single-flight
// `refreshSession`) runs before `bootStatus` flips to "ready". Restore
// failures clear the session, so RequireAuth then redirects to
// /login.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { refreshSession } from "../api/client";
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  getSessionSnapshot,
  subscribe,
} from "./credentialStore";
import type { SessionUser } from "../api/types";

/** "restoring" until the one boot refresh settles; guards gate on this first. */
export type BootStatus = "restoring" | "ready";

export interface AuthSession {
  user: SessionUser | null;
  /**
   * Derived from the store's user presence. Optimistic while
   * `bootStatus === "restoring"` (the persisted user is already visible);
   * guards must check `bootStatus` before trusting it — a failed restore
   * clears the session and flips this to false.
   */
  isAuthenticated: boolean;
  bootStatus: BootStatus;
}

const AuthSessionContext = createContext<AuthSession | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const session = useSyncExternalStore(subscribe, getSessionSnapshot);
  const [bootStatus, setBootStatus] = useState<BootStatus>(() =>
    session.refreshToken !== null && session.accessToken === null
      ? "restoring"
      : "ready",
  );

  useEffect(() => {
    let active = true;
    void restoreBootSession().finally(() => {
      if (active) {
        setBootStatus("ready");
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthSession>(
    () => ({
      user: session.user,
      isAuthenticated: session.user !== null,
      bootStatus,
    }),
    [session.user, bootStatus],
  );

  return <AuthSessionContext value={value}>{children}</AuthSessionContext>;
}

/** Session context accessor; throws when rendered outside <AuthProvider>. */
export function useSession(): AuthSession {
  const value = useContext(AuthSessionContext);
  if (value === null) {
    throw new Error("useSession must be used within an <AuthProvider>");
  }
  return value;
}

/**
 * At most one boot refresh rotation per page load: a no-op unless a refresh
 * token is stored without an in-memory access token. Reads the store live
 * (not the render snapshot) so a StrictMode remount joins the in-flight
 * single-flight rotation — or skips entirely once it landed — instead of
 * rotating twice. Never rejects; any failure clears the session.
 */
async function restoreBootSession(): Promise<void> {
  if (getRefreshToken() === null || getAccessToken() !== null) {
    return;
  }
  try {
    await refreshSession();
  } catch {
    // refreshSession already clears the session on every failure path; kept
    // explicit so the "restore failure → signed out" contract reads here.
    clearSession();
  }
}
