// The dashboard talks to the API at the same origin (VITE_API_BASE_URL
// defaults to ""), so it can resolve the `--server-url` a CLI user needs —
// used to pre-fill the New release wizard's CLI command builder.

/** The server URL a CLI user should pass as `--server-url` to reach this API. */
export function apiServerUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  // An absolute API base (separate API domain) wins; otherwise the dashboard and
  // API share an origin, so the browser origin is the right --server-url.
  return /^https?:\/\//i.test(configured) ? configured : window.location.origin;
}
