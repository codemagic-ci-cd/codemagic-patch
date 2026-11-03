import type { TelemetryRuntimeConfig } from "./config";
import type { RuntimeLogger } from "./logger";

/**
 * Why an entrypoint is not reporting usage: `env` is the operator's opt-out
 * (`SERVER_TELEMETRY=false` or `DO_NOT_TRACK=1`); `no_token` is the managed
 * entrypoint booted without `TELEMETRY_MANAGED_TOKEN`.
 */
export type TelemetryDisabledReason = "env" | "no_token";

/**
 * One boot-time log line that says whether this process reports usage, so an
 * operator reading the log at startup sees the answer without waiting for the
 * first report. Resolution itself happens in `resolveTelemetryConfig`.
 */
export function logTelemetryStartup(
  logger: RuntimeLogger,
  telemetry: TelemetryRuntimeConfig | undefined,
  disabledReason: TelemetryDisabledReason,
): void {
  if (telemetry === undefined) {
    logger.info(
      { event: "telemetry.disabled", reason: disabledReason },
      "usage report disabled; nothing is sent to the collector",
    );
    return;
  }
  if (telemetry.endpointOverridden) {
    logger.warn(
      { endpoint: telemetry.endpoint, event: "telemetry.endpoint_override" },
      "usage report endpoint overridden by SERVER_TELEMETRY_ENDPOINT; reports go to a non-default collector",
    );
  }
}
