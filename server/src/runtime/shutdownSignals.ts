import type { FastifyInstance } from "fastify";

type ShutdownSignal = "SIGINT" | "SIGTERM";

export function registerShutdownSignalHandlers(app: FastifyInstance): void {
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
