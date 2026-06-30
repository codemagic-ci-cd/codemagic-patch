import { resolveRuntimeConfig } from "./runtime/config";
import { startServer } from "./runtime/startServer";

type ShutdownSignal = "SIGINT" | "SIGTERM";

async function main(): Promise<void> {
  const config = resolveRuntimeConfig();
  const app = await startServer(config);

  registerSignalHandlers(app);
}

function registerSignalHandlers(app: Awaited<ReturnType<typeof startServer>>): void {
  const shutdown = async (signal: ShutdownSignal): Promise<void> => {
    app.log.info({ signal }, "shutting down server");

    try {
      await app.close();
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error, signal }, "failed to shut down cleanly");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
