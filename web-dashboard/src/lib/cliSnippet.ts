// Builds the canonical `cmpatch release-react` snippet shown across the dashboard
// (deployment CLI hints). The dashboard talks to the
// API at the same origin (VITE_API_BASE_URL defaults to ""), so it can fill in
// --server-url itself; only --platform stays a placeholder because the dashboard
// cannot know whether the app targets ios or android. Centralising this keeps
// every "publish from the CLI" hint copy-paste-runnable and consistent.

/** The server URL a CLI user should pass as `--server-url` to reach this API. */
export function apiServerUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  // An absolute API base (separate API domain) wins; otherwise the dashboard and
  // API share an origin, so the browser origin is the right --server-url.
  return /^https?:\/\//i.test(configured) ? configured : window.location.origin;
}

// App/deployment names are free-form (the server only requires them non-empty),
// so a name can contain spaces or shell metacharacters. Single-quote anything
// that isn't already a bare shell-safe token so the snippet survives a literal
// copy-paste; leave plain tokens (slugs, URLs) unquoted for readability.
function shellArg(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Shell-safe, obviously-a-placeholder token. The dashboard can't know the app's
// platform; an unedited `PLATFORM` produces a clear CLI error ("--platform must
// be either ios or android") rather than a broken shell line (which `<ios|android>`
// would, since `<`, `|`, `>` are shell metacharacters).
const PLATFORM_PLACEHOLDER = "PLATFORM";

export function buildReleaseReactSnippet(input: {
  app: string;
  deployment: string;
  platform?: "ios" | "android";
}): string {
  return [
    "cmpatch release-react",
    `--server-url ${shellArg(apiServerUrl())}`,
    `--app ${shellArg(input.app)}`,
    `--deployment ${shellArg(input.deployment)}`,
    `--platform ${input.platform ?? PLATFORM_PLACEHOLDER}`,
  ].join(" ");
}
