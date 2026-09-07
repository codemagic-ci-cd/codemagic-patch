/**
 * Host-level status for the dashboard (`GET /v1/server/status`).
 *
 * Probes are injected by name so this module stays free of Docker, cloud and
 * database APIs: the runtime supplies one collector per key of
 * `ServerStatusChecks`, and `collectServerStatus` runs them concurrently,
 * each under its own timeout, folding every outcome into the shared probe
 * envelope so one slow or failing probe never hides the rest. Adding a probe
 * is one new key in `ServerStatusChecks` plus one collector — nothing else.
 */

import { statfs } from "node:fs/promises";

import { PATCH_SERVER_RELEASE_TAG_PREFIX } from "./latestServerRelease";
import type {
  ReadinessCheckResult,
  ServerStatus,
  ServerStatusChecks,
  ServerStatusDiskDetails,
  ServerStatusDownloadUrlDetails,
  ServerStatusProbe,
  ServerStatusTopology,
} from "./types";

/** Collectors return this instead of details when the probe does not apply. */
export interface ProbeSkip {
  readonly reason: string;
  readonly skip: true;
}

export function skipProbe(reason: string): ProbeSkip {
  return { reason, skip: true };
}

export type ProbeCollector<TDetails extends object> = () => Promise<
  ProbeSkip | TDetails
>;

type ProbeDetails<TProbe> = TProbe extends { status: "ok" }
  ? Omit<TProbe, "status">
  : never;

export type ServerStatusProbeCollectors = {
  [K in keyof ServerStatusChecks]: ProbeCollector<
    ProbeDetails<ServerStatusChecks[K]>
  >;
};

export interface ServerStatusCollectors {
  probes: ServerStatusProbeCollectors;
  readRunningVersion(): string | null;
  topology: ServerStatusTopology;
}

export interface CollectServerStatusOptions {
  /** Upper bound per probe; a probe past it reports `error`, not a hang. */
  probeTimeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export async function collectServerStatus(
  collectors: ServerStatusCollectors,
  options: CollectServerStatusOptions = {},
): Promise<ServerStatus> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const names = Object.keys(collectors.probes) as Array<
    keyof ServerStatusChecks
  >;
  const entries = await Promise.all(
    names.map(
      async (name) =>
        [
          name,
          await runProbe(
            name,
            collectors.probes[name] as ProbeCollector<object>,
            probeTimeoutMs,
          ),
        ] as const,
    ),
  );
  // Every key of ServerStatusChecks is present because `names` is exactly
  // the collectors' keys; the mapped type cannot express that to tsc.
  const checks = Object.fromEntries(entries) as unknown as ServerStatusChecks;

  const running = collectors.readRunningVersion();
  const latest =
    checks.latest_release.status === "ok"
      ? checks.latest_release.version
      : null;

  return {
    checks,
    topology: collectors.topology,
    version: {
      running,
      update_available: compareRunningToLatest(running, latest),
    },
  };
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/** Compose service names the bundled overlays pin into the server's env. */
const BUNDLED_DATABASE_HOST = "postgres";
const BUNDLED_STORAGE_HOST = "minio";

export function resolveServerStatusTopology(input: {
  databaseUrl: string | undefined;
  hosting: ServerStatusTopology["hosting"];
  s3Endpoint: string | undefined;
  storageAdapter: "gcs" | "memory" | "s3";
}): ServerStatusTopology {
  return {
    database:
      urlHostname(input.databaseUrl) === BUNDLED_DATABASE_HOST
        ? "bundled"
        : "external",
    hosting: input.hosting,
    storage:
      input.storageAdapter === "memory"
        ? "none"
        : input.storageAdapter === "s3" &&
            urlHostname(input.s3Endpoint) === BUNDLED_STORAGE_HOST
          ? "bundled"
          : "external",
  };
}

function urlHostname(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function runProbe<TDetails extends object>(
  name: string,
  collector: ProbeCollector<TDetails>,
  timeoutMs: number,
): Promise<ServerStatusProbe<TDetails>> {
  try {
    const outcome = await withTimeout(collector(), timeoutMs);
    if (isProbeSkip(outcome)) {
      return { reason: outcome.reason, status: "skipped" };
    }
    return { status: "ok", ...outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `${name}: ${message}`, status: "error" };
  }
}

function isProbeSkip(value: unknown): value is ProbeSkip {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { skip?: unknown }).skip === true
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Built-in collectors
// ---------------------------------------------------------------------------

/**
 * Folds the readiness check into a probe: `ok` when every readiness check
 * passed, otherwise an error naming the failed checks.
 */
export function readinessProbe(
  readiness: () => Promise<ReadinessCheckResult>,
): ProbeCollector<Record<never, never>> {
  return async () => {
    const result = await readiness();
    if (result.ok) {
      return {};
    }
    const failed = Object.entries(result.checks)
      .filter(([, state]) => state !== "ok")
      .map(([check]) => check);
    throw new Error(`readiness check failed: ${failed.join(", ")}`);
  };
}

export interface DownloadUrlProbeOptions {
  fetchImpl?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  /** `PUBLIC_BASE_URL` as the server resolved it (no trailing slash). */
  url: string;
}

export const DEFAULT_DOWNLOAD_URL_TIMEOUT_MS = 4_000;

/**
 * Probes the public download origin the way a device would reach it. Any
 * HTTP answer means DNS, TCP and TLS all worked — the bucket prefix itself
 * usually answers 403 or 404, so the status code is reported, not judged.
 * A loopback origin is skipped: from inside the container it names this
 * process (or nothing), never the host-mapped storage port local eval uses.
 */
export function downloadUrlProbe(
  options: DownloadUrlProbeOptions,
): ProbeCollector<ServerStatusDownloadUrlDetails> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_DOWNLOAD_URL_TIMEOUT_MS;
  const url = options.url;
  return async () => {
    if (isLoopbackUrl(url)) {
      return skipProbe("loopback download URL is not probed from the server");
    }
    const response = await fetchImpl(url, {
      headers: { "user-agent": "codemagic-patch-server" },
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return { http_status: response.status, url };
  };
}

export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export async function readProcessDisk(
  path = "/",
): Promise<ServerStatusDiskDetails> {
  const stats = await statfs(path);
  const blockSize = Number(stats.bsize);
  return {
    free_bytes: Number(stats.bavail) * blockSize,
    path,
    total_bytes: Number(stats.blocks) * blockSize,
  };
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

export function compareRunningToLatest(
  running: string | null,
  latest: string | null,
): boolean | null {
  const runningVersion = parseSemver(running);
  const latestVersion = parseSemver(latest);
  if (runningVersion === null || latestVersion === null) {
    return null;
  }
  return compareSemver(runningVersion, latestVersion) < 0;
}

export function parseSemver(
  raw: string | null | undefined,
): [number, number, number] | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let value = raw.trim();
  if (value.startsWith(PATCH_SERVER_RELEASE_TAG_PREFIX)) {
    value = value.slice(PATCH_SERVER_RELEASE_TAG_PREFIX.length);
  } else if (value.startsWith("v")) {
    value = value.slice(1);
  }
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}
