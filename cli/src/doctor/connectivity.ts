import type { DoctorCheckResult } from "../commands/doctor";

/** Diagnostics never print userinfo or signed query strings. */
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

export function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function compareUrl(
  id: string,
  actual: string | undefined,
  expected: string | undefined,
  source: string,
): DoctorCheckResult {
  if (actual === undefined || expected === undefined)
    return {
      id,
      title: "SDK URL comparison",
      status: "skip",
      reason: "unresolved",
      detail: "Comparison needs a resolved application value and server value.",
      evidence: { source },
    };
  const normalize = (value: string) => {
    const url = httpUrl(value);
    return url
      ? `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`
      : undefined;
  };
  const matches =
    normalize(actual) !== undefined &&
    normalize(actual) === normalize(expected);
  return {
    id,
    title: "SDK URL comparison",
    status: matches ? "pass" : "warn",
    detail: matches
      ? "Application URL matches the selected server configuration."
      : "Application URL differs; verify whether this is an intentional proxy or domain alias.",
    evidence: { source, actual: safeUrl(actual), expected: safeUrl(expected) },
    ...(!matches
      ? {
          advice: [
            "Check the complete URL, including its path prefix, against the app's intended environment.",
          ],
        }
      : {}),
  };
}

/** Public transport evidence only: never request protocol files or forward auth. */
export async function probeDownloadOrigin(
  fetcher: typeof fetch,
  value: string,
): Promise<DoctorCheckResult> {
  const base = {
    id: "download-connectivity",
    title: "Download endpoint connectivity",
  };
  let url = httpUrl(value);
  if (!url)
    return {
      ...base,
      status: "fail",
      detail: "Download URL must use HTTP(S) without embedded credentials.",
    };
  const endpoint = safeUrl(value);
  let method = "HEAD";
  let redirects = 0;
  let loginRedirect = false;
  const isLoopback = (host: string) =>
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "[::1]";
  let loopback = isLoopback(url.hostname);
  // A deadline covers the entire redirect/fallback chain, including response bodies.
  const signal = AbortSignal.timeout(10_000);
  try {
    while (true) {
      signal.throwIfAborted();
      const response = await fetcher(url.toString(), {
        method,
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: method === "GET" ? { Range: "bytes=0-1023" } : {},
      });
      // Headers are sufficient transport evidence. Cancel even when Range is ignored.
      await response.body?.cancel();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects++ >= 5)
          return {
            ...base,
            status: "warn",
            reason: "unresolved",
            detail:
              "HTTP responded, but the redirect chain could not be resolved within five redirects.",
            evidence: { endpoint },
          };
        let next: URL | undefined;
        try {
          next = httpUrl(new URL(location, url).toString());
        } catch {
          /* invalid Location is unresolved HTTP evidence */
        }
        if (!next)
          return {
            ...base,
            status: "warn",
            reason: "unresolved",
            detail: "HTTP responded with an unsupported redirect target.",
            evidence: { endpoint },
          };
        loginRedirect ||=
          /\/(login|signin|sign-in|oauth|authorize)(\/|$)/i.test(next.pathname);
        url = next;
        loopback ||= isLoopback(next.hostname);
        continue;
      }
      if (method === "HEAD" && [405, 501].includes(response.status)) {
        method = "GET";
        continue;
      }
      const warning =
        response.status >= 500 ||
        response.status === 429 ||
        loginRedirect ||
        loopback;
      return {
        ...base,
        status: warning ? "warn" : "pass",
        detail: `HTTP ${response.status} establishes CLI-side transport reachability only; OTA files and device connectivity were not verified.`,
        evidence: {
          endpoint,
          finalEndpoint: safeUrl(url.toString()),
          httpStatus: response.status,
          redirects,
          method,
          loginRedirect,
          loopback,
        },
        ...(warning
          ? {
              advice: [
                loopback
                  ? "Check the device or emulator's route to this local address."
                  : "Inspect the download service, access policy, and redirect routing.",
              ],
            }
          : {}),
      };
    }
  } catch (error) {
    const cause =
      error instanceof Error &&
      error.cause &&
      typeof error.cause === "object" &&
      "code" in error.cause
        ? String(error.cause.code)
        : undefined;
    const category = signal.aborted
      ? "timeout"
      : cause === "ENOTFOUND" || cause === "EAI_AGAIN"
        ? "dns"
        : cause === "ECONNREFUSED"
          ? "connection_refused"
          : cause?.startsWith("CERT_") || cause?.startsWith("ERR_TLS_")
            ? "tls"
            : "network";
    return {
      ...base,
      status: "fail",
      detail: "The download endpoint could not be reached from this CLI.",
      evidence: { endpoint, category },
      advice: [
        "Check the app's download URL, DNS, TLS configuration, and network access.",
      ],
    };
  }
}

/** Preserve machine-readable values; remove only URL credentials and suffix secrets. */
export function redactUrlText(value: string): string {
  return value.replace(/https?:\/\/[^\s`"<>]+/g, (match) => {
    const punctuation = match.match(/[.,;!?)]+$/)?.[0] ?? "";
    const url = punctuation ? match.slice(0, -punctuation.length) : match;
    return url.replace(/^(https?:\/\/)[^/?#]*@/, "$1").replace(/[?#].*$/, "") + punctuation;
  });
}
