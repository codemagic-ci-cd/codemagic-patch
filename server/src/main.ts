import { pino } from "pino";

import { resolveRuntimeConfig, resolveTelemetryConfig } from "./runtime/config";
import { registerShutdownSignalHandlers } from "./runtime/shutdownSignals";
import { startServer } from "./runtime/startServer";
import { logTelemetryStartup } from "./runtime/telemetryStartup";

async function main(): Promise<void> {
  const config = resolveRuntimeConfig();
  const telemetry = resolveTelemetryConfig();
  // The same logger startServer would create, made here so the usage-report
  // state is on record before the server starts.
  const loggerInstance = pino({ level: config.logger ? "info" : "silent" });
  logTelemetryStartup(loggerInstance, telemetry, "env");

  const app = await startServer(config, { loggerInstance, telemetry });

  registerShutdownSignalHandlers(app);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
