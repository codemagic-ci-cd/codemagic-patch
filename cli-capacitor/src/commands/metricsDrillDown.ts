// deployment timeseries, and deployment | release failures | failure-events —
// cli/src/commands/{deploymentTimeseries,failures}.ts (@codemagic/patch-cli 0.7.0): the
// numbers behind the dashboard's deployment chart and its failure dialog, with the same
// endpoints, queries, validation and table columns. A server without the feature (501)
// gets one sentence instead of a problem record. See cli-capacitor-tech-spec › Provenance.

import { withUnavailableFeatureMessage } from "../api";
import { authenticatedRequest, type ApiTarget } from "../authenticatedRequest";
import {
  BINARY_VERSION_FILTER_FLAGS,
  CONNECTION_FLAGS,
  DEPLOYMENT_SELECTOR_FLAGS,
  DEPLOYMENT_USAGE,
  FORMAT_FLAG,
  readApiTarget,
  readBinaryVersionFilter,
  readBoolean,
  readDeploymentSelector,
  readInteger,
  readReleaseSelector,
  readString,
  RELEASE_SELECTOR_FLAGS,
  RELEASE_USAGE,
  type CommandDefinition,
  type CommandOutput,
  type FlagSpec,
  type FlagValues,
} from "../command";
import type { CliDeps } from "../deps";
import { UsageError } from "../errors";
import { isRecord } from "../output";
import { renderTable } from "../render";
import { pathWithQuery, resolveDeploymentId, resolveReleaseId } from "../resolveNames";

const TIMESERIES_UNAVAILABLE =
  "This server does not publish deployment time series (server too old or timeseries disabled).";
const FAILURES_UNAVAILABLE =
  "This server does not publish failure drill-down (server too old or failure detail disabled).";

const DAY_MS = 24 * 60 * 60 * 1000;
// The dashboard's chart presets: a window of whole days ending now (`1y` is 365 days).
const RANGE_DAYS: Record<string, number> = { "1y": 365, "30d": 30, "7d": 7, "90d": 90 };

const deploymentTimeseries: CommandDefinition = {
  flags: [
    ...DEPLOYMENT_SELECTOR_FLAGS,
    { help: "Window ending now; not with --from/--to", name: "range", type: "string", value: "7d|30d|90d|1y" },
    { help: "Range start, ISO 8601 (from that UTC day)", name: "from", type: "string", value: "iso" },
    { help: "Range end, ISO 8601 (default: now)", name: "to", type: "string", value: "iso" },
    ...BINARY_VERSION_FILTER_FLAGS,
    { help: "Most per-release series in the JSON output", name: "series-limit", type: "string", value: "n" },
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "ACTIVE is the devices active that day; `deployment metrics`' ACTIVE is a lifetime count.",
    "Without --range or --from/--to the server's default applies (the last 30 days).",
    "The per-release series are in --format json.",
  ],
  path: ["deployment", "timeseries"],
  run: async (values, deps) => {
    const query = {
      ...readTimeseriesRange(values, deps.now()),
      ...readBinaryVersionFilter(values),
      series_limit: readInteger(values, "series-limit", { min: 1 }),
    };
    const target = readApiTarget(values, deps);
    const deploymentId = await resolveDeploymentId(deps, target, readDeploymentSelector(values));
    const result = await withUnavailableFeatureMessage(
      authenticatedRequest(
        deps,
        target,
        pathWithQuery(`/v1/metrics/deployments/${encodeURIComponent(deploymentId)}/timeseries`, query),
        { method: "GET" },
      ),
      TIMESERIES_UNAVAILABLE,
    );
    const totals = isRecord(result) && Array.isArray(result.totals) ? result.totals.filter(isRecord) : [];

    return {
      columns: [
        { header: "DAY", path: "day" },
        { header: "ACTIVE", path: "active_devices" },
        { header: "DOWNLOADED", path: "downloaded" },
        { header: "READY", path: "installed" },
        { header: "FAILED", path: "failed" },
        { header: "APPLIED", path: "success" },
      ],
      empty: "No activity in this range.",
      ...timeseriesFooter(result),
      json: result,
      kind: "list",
      // Buckets start at UTC midnight, so the date part is the day.
      rows: totals.map((bucket) => ({
        ...bucket,
        day: typeof bucket.bucket_start === "string" ? bucket.bucket_start.slice(0, 10) : undefined,
      })),
    };
  },
  summary: "Show a deployment's counters per UTC day, as the dashboard's chart does",
  usage: `${DEPLOYMENT_USAGE} [--range <7d|30d|90d|1y> | --from <iso> --to <iso>] [flags]`,
};

/** `--range`, or `--from` / `--to` (either alone; the server defaults the other). */
function readTimeseriesRange(values: FlagValues, now: number): { from?: string; to?: string } {
  const range = readString(values, "range");
  const from = readString(values, "from");
  const to = readString(values, "to");
  if (range === undefined) return { from, to };
  if (from !== undefined || to !== undefined) throw new UsageError("--range cannot be combined with --from or --to.");
  const days = RANGE_DAYS[range];
  if (days === undefined) throw new UsageError(`--range must be one of ${Object.keys(RANGE_DAYS).join(", ")}.`);

  return { from: new Date(now - days * DAY_MS).toISOString(), to: new Date(now).toISOString() };
}

/**
 * The lines under the daily table: the per-release series the JSON carries, and the
 * binary versions that reported, which are the values the filter flags take.
 */
function timeseriesFooter(result: unknown): { footer?: string } {
  if (!isRecord(result)) return {};
  const lines: string[] = [];
  const series = Array.isArray(result.series) ? result.series : [];
  if (series.length > 0 || result.series_truncated === true) {
    const truncated = result.series_truncated === true ? " (truncated)" : "";
    lines.push(`Per-release series: ${series.length}${truncated}. Read them with --format json.`);
  }
  const versions = Array.isArray(result.binary_versions)
    ? result.binary_versions.filter((version): version is string => typeof version === "string")
    : [];
  if (versions.length > 0) {
    lines.push(
      `Binary versions in range: ${versions.join(", ")}. Narrow with --binary-version or --binary-version-prefix.`,
    );
  }

  return lines.length === 0 ? {} : { footer: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Failures: a reason's codes, one code's distribution, and its single events
// ---------------------------------------------------------------------------

type Scope = "deployment" | "release";

const SCOPE_SELECTOR: Record<Scope, { flags: readonly FlagSpec[]; usage: string }> = {
  deployment: { flags: DEPLOYMENT_SELECTOR_FLAGS, usage: DEPLOYMENT_USAGE },
  release: { flags: RELEASE_SELECTOR_FLAGS, usage: RELEASE_USAGE },
};

const REASON_FLAG: FlagSpec = {
  help: "Failure reason, a key of failure_reasons in `metrics --format json`, e.g. network",
  name: "reason",
  type: "string",
  value: "reason",
};

const BUCKET_FLAGS: readonly FlagSpec[] = [
  REASON_FLAG,
  { help: "Show this code's exit reasons and messages", name: "code", type: "string", value: "code" },
  { help: "Same, for the failures that carried no code (not all codes)", name: "no-code", type: "boolean" },
];

const EVENT_FLAGS: readonly FlagSpec[] = [
  REASON_FLAG,
  { help: "Events with this code", name: "code", type: "string", value: "code" },
  { help: "Events that carried no code instead (not all codes)", name: "no-code", type: "boolean" },
  { help: "Events per page, 1-100 (default: 25)", name: "limit", type: "string", value: "n" },
  { help: "Next page: the cursor the previous page ended with", name: "cursor", type: "string", value: "cursor" },
];

/**
 * A reason, and a code bucket: a code, the no-code bucket, or (for `failures` alone)
 * none, which lists the reason's codes. The no-code bucket is an omitted `code`, as the
 * server and the dashboard define it.
 */
function readFailureBucket(values: FlagValues, scope: Scope): { bucket?: { code?: string }; reason: string } {
  const reason = readString(values, "reason");
  const code = readString(values, "code");
  const noCode = readBoolean(values, "no-code");
  if (reason === undefined) {
    throw new UsageError(
      `Missing required flag --reason. Take one from failure_reasons in \`${scope} metrics --format json\`.`,
    );
  }
  if (code !== undefined && noCode) throw new UsageError("--code cannot be combined with --no-code.");

  return { ...(code !== undefined ? { bucket: { code } } : noCode ? { bucket: {} } : {}), reason };
}

async function resolveScopePath(values: FlagValues, deps: CliDeps, target: ApiTarget, scope: Scope): Promise<string> {
  return scope === "deployment"
    ? `deployments/${encodeURIComponent(await resolveDeploymentId(deps, target, readDeploymentSelector(values)))}`
    : `releases/${encodeURIComponent(await resolveReleaseId(deps, target, readReleaseSelector(values)))}`;
}

function failures(scope: Scope): CommandDefinition {
  return {
    flags: [...SCOPE_SELECTOR[scope].flags, ...BUCKET_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
    notes: [
      "With --reason alone, the table lists the codes under that reason; --code (or --no-code)",
      `shows that bucket's top exit reasons and messages. Single events: \`${scope} failure-events\`.`,
    ],
    path: [scope, "failures"],
    run: async (values, deps) => {
      const { bucket, reason } = readFailureBucket(values, scope);
      const target = readApiTarget(values, deps);
      const level = bucket === undefined ? "failures" : "failures/distribution";
      const result = await withUnavailableFeatureMessage(
        authenticatedRequest(
          deps,
          target,
          pathWithQuery(`/v1/metrics/${await resolveScopePath(values, deps, target, scope)}/${level}`, {
            code: bucket?.code,
            reason,
          }),
          { method: "GET" },
        ),
        FAILURES_UNAVAILABLE,
      );

      return bucket === undefined ? failureCodesOutput(result) : failureDistributionOutput(result);
    },
    summary: `Break down a ${scope}'s failures by code, or one code by exit reason and message`,
    usage: `${SCOPE_SELECTOR[scope].usage} --reason <reason> [--code <code> | --no-code] [flags]`,
  };
}

function failureCodesOutput(result: unknown): CommandOutput {
  const codes = isRecord(result) && Array.isArray(result.codes) ? result.codes.filter(isRecord) : [];

  return {
    columns: [
      { header: "CODE", path: "code" },
      { header: "COUNT", path: "count" },
      { header: "FIRST SEEN", path: "first_seen_at" },
      { header: "LAST SEEN", path: "last_seen_at" },
    ],
    empty: "No failures with this reason.",
    json: result,
    kind: "list",
    rows: codes.map((row) => ({ ...row, code: row.code ?? "(no code)" })),
  };
}

/** Two small tables (exit reasons are reported on Android only) and the bucket's total. */
function failureDistributionOutput(result: unknown): CommandOutput {
  const read = (key: string) => (isRecord(result) && Array.isArray(result[key]) ? result[key].filter(isRecord) : []);
  const total = isRecord(result) && typeof result.total === "number" ? result.total : 0;
  const block = (header: string, key: string, empty: string) =>
    renderTable(
      [
        { header, path: "value" },
        { header: "COUNT", path: "count" },
      ],
      read(key),
      empty,
    );

  return {
    json: result,
    kind: "report",
    text:
      total === 0
        ? "No events in this bucket.\n"
        : [
            block("EXIT REASON", "exit_reasons", "No exit reasons reported (Android only)."),
            block("MESSAGE", "messages", "No messages reported."),
            `Total: ${total}\n`,
          ].join("\n"),
  };
}

function failureEvents(scope: Scope): CommandDefinition {
  return {
    flags: [...SCOPE_SELECTOR[scope].flags, ...EVENT_FLAGS, ...CONNECTION_FLAGS, FORMAT_FLAG],
    notes: [
      `Newest first, from one bucket of \`${scope} failures\`: --reason and --code or --no-code.`,
      "When more events remain, the table ends with the --cursor for the next page (next_cursor in JSON).",
    ],
    path: [scope, "failure-events"],
    run: async (values, deps) => {
      const { bucket, reason } = readFailureBucket(values, scope);
      if (bucket === undefined) throw new UsageError("Missing required flag --code or --no-code.");
      // Opaque, and passed as it is; readString refuses a blank one, which would restart
      // the feed at the newest event.
      const cursor = readString(values, "cursor");
      const limit = readInteger(values, "limit", { max: 100, min: 1 });
      const target = readApiTarget(values, deps);
      const result = await withUnavailableFeatureMessage(
        authenticatedRequest(
          deps,
          target,
          pathWithQuery(`/v1/metrics/${await resolveScopePath(values, deps, target, scope)}/failures/events`, {
            code: bucket.code,
            cursor,
            limit,
            reason,
          }),
          { method: "GET" },
        ),
        FAILURES_UNAVAILABLE,
      );
      const events = isRecord(result) && Array.isArray(result.events) ? result.events.filter(isRecord) : [];
      const next = isRecord(result) && typeof result.next_cursor === "string" ? result.next_cursor : undefined;

      return {
        columns: [
          { header: "TIME", path: "emitted_at" },
          { header: "DEVICE", path: "device_id" },
          { header: "EXIT", path: "android_previous_process_exit" },
          { header: "MESSAGE", path: "message" },
        ],
        empty: "No events in this bucket.",
        ...(next !== undefined ? { footer: `More events: re-run with --cursor ${next}` } : {}),
        json: result,
        kind: "list",
        rows: events,
      };
    },
    summary: `List a ${scope}'s single failure events, a page at a time`,
    usage: `${SCOPE_SELECTOR[scope].usage} --reason <reason> (--code <code> | --no-code) [--limit <n>] [--cursor <cursor>] [flags]`,
  };
}

export const deploymentMetricsDrillDown: readonly CommandDefinition[] = [
  deploymentTimeseries,
  failures("deployment"),
  failureEvents("deployment"),
];

export const releaseMetricsDrillDown: readonly CommandDefinition[] = [failures("release"), failureEvents("release")];
