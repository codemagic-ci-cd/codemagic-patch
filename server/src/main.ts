import { resolveRuntimeConfig } from "./runtime/config";
import { registerShutdownSignalHandlers } from "./runtime/shutdownSignals";
import { startServer } from "./runtime/startServer";

async function main(): Promise<void> {
  const config = resolveRuntimeConfig();
  const app = await startServer(config);

  registerShutdownSignalHandlers(app);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
