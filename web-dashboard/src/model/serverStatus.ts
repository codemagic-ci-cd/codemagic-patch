// Logic for the Status page: disk-bar geometry, the API-origin probe, and
// version copy. The API probe runs in the browser because the API origin is
// this page's own origin (`connect-src 'self'` allows it) and what the browser
// sees is the point. The download origin is a different host, so the server
// probes it and reports the result in `checks.download_url`.
// A CORS `fetch` cannot tell a MinIO/S3 403 from DNS or TLS failure. `no-cors`
// resolves when TCP (and TLS, if HTTPS) completed, including 403, and rejects
// on DNS, certificate, connection refused, mixed-content, or timeout.

import type {
  ServerStatusDownloadUrl,
  ServerStatusProbe,
  ServerStatusTopology,
} from "../api/types";
import { formatDate } from "./format";

export type ServerStatusAvailability = "available" | "unavailable" | "unknown";

/**
 * Whether this deployment serves the Status page at all. Only a 501 (no
 * status handler — managed hosting) hides it; any other failure keeps the
 * entry so the page can show the error and offer a retry.
 */
export function serverStatusAvailability(input: {
  isPending: boolean;
  unavailable: boolean;
}): ServerStatusAvailability {
  if (input.unavailable) {
    return "unavailable";
  }
  if (input.isPending) {
    return "unknown";
  }
  return "available";
}

/** Health-card row label for a probe; `null` omits the row (`skipped`). */
export function probeReadiness(
  probe: ServerStatusProbe<object>,
): "not-ready" | "ready" | null {
  if (probe.status === "skipped") {
    return null;
  }
  return probe.status === "ok" ? "ready" : "not-ready";
}

export type DiskBarKey = "used" | "free";

export interface DiskBarSegment {
  bytes: number;
  key: DiskBarKey;
}

export function diskBarSegments(input: {
  freeBytes: number;
  totalBytes: number;
}): DiskBarSegment[] {
  const total = Math.max(0, input.totalBytes);
  const free = Math.min(total, Math.max(0, input.freeBytes));
  const used = total - free;

  return [
    { bytes: used, key: "used" },
    { bytes: free, key: "free" },
  ];
}

/** Loopback API origins (local eval, host Vite) skip the browser probe. */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined) {
    return false;
  }
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

const PROBE_TIMEOUT_MS = 8_000;

export async function probeOpaqueUrl(
  url: string,
  options?: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const parent = options?.signal;
  if (parent?.aborted) {
    return false;
  }
  const onParentAbort = (): void => {
    controller.abort();
  };
  parent?.addEventListener("abort", onParentAbort);
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  try {
    await fetchImpl(url, {
      cache: "no-store",
      method: "GET",
      mode: "no-cors",
      redirect: "follow",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Card pill: DB readiness plus the server-side download-origin probe. A
 * `skipped` download probe (loopback origin) is not a failure.
 */
export function healthReadyState(input: {
  databaseOk: boolean;
  downloadUrl: ServerStatusProbe<ServerStatusDownloadUrl>;
}): "not-ready" | "ready" {
  if (!input.databaseOk) {
    return "not-ready";
  }
  return input.downloadUrl.status === "error" ? "not-ready" : "ready";
}

/** Download URL row label from the server-side probe envelope. */
export function downloadUrlLabel(
  probe: ServerStatusProbe<ServerStatusDownloadUrl>,
): "Not checked" | "Reachable" | "Unreachable" {
  if (probe.status === "skipped") {
    return "Not checked";
  }
  return probe.status === "ok" ? "Reachable" : "Unreachable";
}

// ---------------------------------------------------------------------------
// Topology-driven visibility
// ---------------------------------------------------------------------------

/**
 * The Disk card measures the API container's root disk, which only says
 * something when a bundled Postgres or MinIO volume shares that disk.
 */
export function showDiskCard(topology: ServerStatusTopology): boolean {
  return topology.database === "bundled" || topology.storage === "bundled";
}

/** Upgrading is an operator step, so the version card is self-host only. */
export function showVersionCard(topology: ServerStatusTopology): boolean {
  return topology.hosting === "self-hosted";
}

export function statusPageDescription(topology: ServerStatusTopology): string {
  if (topology.hosting === "managed") {
    return "Connectivity of this Patch instance to its database, object storage, and download origin.";
  }
  const bundled = [
    ...(topology.database === "bundled" ? ["Postgres"] : []),
    ...(topology.storage === "bundled" ? ["MinIO"] : []),
  ];
  if (bundled.length === 0) {
    return "Host health for this Patch install. Database and object storage are external services, so only their connectivity is checked here.";
  }
  return `Host health for this Patch install. Disk free space is measured from the API container, which on a default Compose VM is usually the same disk as ${bundled.join(" and ")}.`;
}

const PATCH_SERVER_TAG_PREFIX = "codemagic-patch-server-";
const DAY_MS = 24 * 60 * 60 * 1000;

/** GitHub tag `codemagic-patch-server-v0.2.0` or `0.2.0` → `v0.2.0`. */
export function formatPatchServerVersion(
  tag: string | null | undefined,
): string | null {
  if (tag === null || tag === undefined) {
    return null;
  }
  let value = tag.trim();
  if (value.length === 0) {
    return null;
  }
  if (value.startsWith(PATCH_SERVER_TAG_PREFIX)) {
    value = value.slice(PATCH_SERVER_TAG_PREFIX.length);
  }
  if (!value.startsWith("v")) {
    value = `v${value}`;
  }
  return value;
}

/**
 * Prose age for a GitHub publish time ("today", "1 day ago", "3 days ago").
 * Beyond 30 days, falls back to the absolute date.
 */
export function formatDaysAgo(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const deltaMs = Math.max(0, now - date.getTime());
  const days = Math.floor(deltaMs / DAY_MS);
  if (days < 1) {
    return "today";
  }
  if (days === 1) {
    return "1 day ago";
  }
  if (days <= 30) {
    return `${days} days ago`;
  }
  return formatDate(iso);
}
