import { randomUUID } from "node:crypto";

import { createTerminalConfirm, type ConfirmFn } from "./confirm";
import type { StartLoopbackLoginServer } from "./loopbackLoginServer";
import type { WritableStream } from "./output";

/**
 * Everything the CLI takes from the process, in one injectable value, so a test
 * drives the whole command — argv to exit code — without a network, a terminal,
 * or real waiting between retries. The file system is deliberately not in here:
 * tests point the command at a temp directory instead.
 */
export interface CliDeps {
  /** See confirm.ts: override together with `stdin`/`stderr` in tests. */
  confirm: ConfirmFn;
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  /** The clock `release inspect --wait` measures its timeout against. */
  now: () => number;
  /**
   * Best-effort default-browser launch for `login`; resolves false (never
   * throws) when nothing could be opened. Injected so tests stay spawn-free.
   */
  openBrowser?: (url: string) => Promise<boolean>;
  randomUUID: () => string;
  sleep: (milliseconds: number) => Promise<void>;
  /** Loopback redirect listener for the browser login; injected for tests. */
  startLoopbackLoginServer?: StartLoopbackLoginServer;
  stderr: WritableStream;
  stdin: { isTTY?: boolean };
  stdout: WritableStream;
}

export function createDefaultDeps(): CliDeps {
  return {
    confirm: createTerminalConfirm(),
    env: process.env,
    fetch: globalThis.fetch,
    now: Date.now,
    randomUUID,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stderr: process.stderr,
    stdin: process.stdin,
    stdout: process.stdout,
  };
}
