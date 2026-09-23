import { spawn, type ChildProcess } from "node:child_process";

import { onInterruptCleanup } from "./progress";

/** Own the installer's process group until it is reaped, including lifecycle-script children. */
export function cleanupChildOnInterrupt(child: ChildProcess, interrupt: () => void): () => void {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return onInterruptCleanup(async () => {
    interrupt();
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.once("error", () => { child.kill("SIGKILL"); resolve(); });
        killer.once("close", () => { child.kill("SIGKILL"); resolve(); });
      });
    } else {
      const killGroup = (signal: "SIGTERM" | "SIGKILL") => {
        try { process.kill(-child.pid!, signal); } catch (error) {
          if ((error as { code?: string }).code !== "ESRCH") throw error;
        }
      };
      killGroup("SIGTERM");
      // A package manager can exit before its lifecycle scripts, so retain ownership
      // for the grace period and kill the group even if the direct child has closed.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      killGroup("SIGKILL");
    }
    await closed;
  });
}
