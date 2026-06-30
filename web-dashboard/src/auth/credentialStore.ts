// SPA session/credential store — browser counterpart of `cli/src/credentialStore.ts`
// (shape reference only; its node:fs implementation is not importable here).
//
// Security posture (token lifecycle): the access token lives in memory
// only and is never written to any web storage. `sessionStorage` persists only
// `{ refreshToken, refreshTokenExpiresAt, user }` so a reload can restore the
// session via one refresh rotation (boot restore). Per-tab sessions are an
// accepted consequence of the sessionStorage scope.
//
// Module-level singleton with a subscribe/snapshot API shaped for React's
// `useSyncExternalStore`: `getSessionSnapshot()` returns a cached object that
// is replaced (never mutated) only when the session actually changes.

import type { RefreshResponse, SessionResponse, SessionUser } from "../api/types";

/** Namespaced sessionStorage key; bump the version suffix on shape changes. */
export const SESSION_STORAGE_KEY = "codemagic-patch.dashboard.session.v1";

export interface SessionToken {
  token: string;
  expiresAt: string;
}

/** Stable store snapshot — a new object replaces it on every session change. */
export interface SessionSnapshot {
  accessToken: SessionToken | null;
  refreshToken: SessionToken | null;
  user: SessionUser | null;
}

/** Exactly what sessionStorage persists — never the access token. */
interface PersistedSession {
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: SessionUser;
}

const EMPTY_SESSION_SNAPSHOT: SessionSnapshot = {
  accessToken: null,
  refreshToken: null,
  user: null,
};

const listeners = new Set<() => void>();

let snapshot: SessionSnapshot = EMPTY_SESSION_SNAPSHOT;
let hydrated = false;

/** Installs a full session — called after the OAuth callback exchange. */
export function setSession(payload: SessionResponse): void {
  ensureHydrated();
  replaceSnapshot({
    accessToken: {
      token: payload.accessToken,
      expiresAt: payload.accessTokenExpiresAt,
    },
    refreshToken: {
      token: payload.refreshToken,
      expiresAt: payload.refreshTokenExpiresAt,
    },
    user: payload.user,
  });
}

/** Refresh rotation — replaces both tokens, keeps the current user. */
export function updateTokens(payload: RefreshResponse): void {
  ensureHydrated();
  replaceSnapshot({
    accessToken: {
      token: payload.accessToken,
      expiresAt: payload.accessTokenExpiresAt,
    },
    refreshToken: {
      token: payload.refreshToken,
      expiresAt: payload.refreshTokenExpiresAt,
    },
    user: snapshot.user,
  });
}

/** Memory-only access token; `null` when signed out (or before boot restore). */
export function getAccessToken(): SessionToken | null {
  ensureHydrated();
  return snapshot.accessToken;
}

/** sessionStorage-backed refresh token (hydrated once per page load). */
export function getRefreshToken(): SessionToken | null {
  ensureHydrated();
  return snapshot.refreshToken;
}

export function getUser(): SessionUser | null {
  ensureHydrated();
  return snapshot.user;
}

/** Wipes the in-memory session and the persisted sessionStorage entry. */
export function clearSession(): void {
  ensureHydrated();
  removePersistedSession();
  replaceSnapshot(EMPTY_SESSION_SNAPSHOT);
}

/** Change subscription, `useSyncExternalStore`-compatible. */
export function subscribe(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stable cached snapshot for `useSyncExternalStore` — the same object is
 * returned until the session changes, so render loops cannot occur.
 */
export function getSessionSnapshot(): SessionSnapshot {
  ensureHydrated();
  return snapshot;
}

function ensureHydrated(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;

  const persisted = readPersistedSession();
  if (persisted !== null) {
    snapshot = {
      accessToken: null,
      refreshToken: {
        token: persisted.refreshToken,
        expiresAt: persisted.refreshTokenExpiresAt,
      },
      user: persisted.user,
    };
  }
}

function replaceSnapshot(next: SessionSnapshot): void {
  if (
    sameToken(snapshot.accessToken, next.accessToken) &&
    sameToken(snapshot.refreshToken, next.refreshToken) &&
    sameUser(snapshot.user, next.user)
  ) {
    return;
  }

  snapshot = next;
  persistSnapshot(next);
  emit();
}

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function persistSnapshot(value: SessionSnapshot): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    if (value.refreshToken === null || value.user === null) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }

    const persisted: PersistedSession = {
      refreshToken: value.refreshToken.token,
      refreshTokenExpiresAt: value.refreshToken.expiresAt,
      user: value.user,
    };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Storage unavailable (private mode / quota / blocked): degrade to a
    // memory-only session that ends with the tab instead of surviving reloads.
  }
}

function removePersistedSession(): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing to wipe when storage is unreachable.
  }
}

function readPersistedSession(): PersistedSession | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }

  let raw: string | null;
  try {
    raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }

  if (raw === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON → treat as signed out.
    return null;
  }

  if (!isPersistedSession(parsed)) {
    // Unexpected shape → treat as signed out.
    return null;
  }

  // Re-pick known fields so stray persisted properties never reach React state.
  return {
    refreshToken: parsed.refreshToken,
    refreshTokenExpiresAt: parsed.refreshTokenExpiresAt,
    user: {
      id: parsed.user.id,
      email: parsed.user.email,
      displayName: parsed.user.displayName,
      createdAt: parsed.user.createdAt,
    },
  };
}

function isPersistedSession(value: unknown): value is PersistedSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "refreshToken" in value &&
    typeof value.refreshToken === "string" &&
    "refreshTokenExpiresAt" in value &&
    typeof value.refreshTokenExpiresAt === "string" &&
    "user" in value &&
    isSessionUser(value.user)
  );
}

function isSessionUser(value: unknown): value is SessionUser {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "email" in value &&
    typeof value.email === "string" &&
    "displayName" in value &&
    (typeof value.displayName === "string" || value.displayName === null) &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function sameToken(a: SessionToken | null, b: SessionToken | null): boolean {
  if (a === b) {
    return true;
  }

  return a !== null && b !== null && a.token === b.token && a.expiresAt === b.expiresAt;
}

function sameUser(a: SessionUser | null, b: SessionUser | null): boolean {
  if (a === b) {
    return true;
  }

  return (
    a !== null &&
    b !== null &&
    a.id === b.id &&
    a.email === b.email &&
    a.displayName === b.displayName &&
    a.createdAt === b.createdAt
  );
}
