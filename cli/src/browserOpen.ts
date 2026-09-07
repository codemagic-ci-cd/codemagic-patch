import { spawn } from "node:child_process";

/** How long an opener may stay attached to the browser before it counts as launched. */
const HANDOFF_TIMEOUT_MS = 3_000;

/**
 * Best-effort default browser launch, hand-rolled instead of a dependency:
 * `open` (darwin) / `rundll32` (win32, a real executable so the query string's
 * `&` needs no cmd.exe quoting) / `xdg-open` (everything else). Resolves false
 * — never throws — when the platform has no opener or the spawn fails; the
 * caller always prints the URL as a fallback.
 */
export function openBrowser(
  url: string,
  platform: typeof process.platform = process.platform,
): Promise<boolean> {
  const command = openerCommand(url, platform);
  if (command === null) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });

    // The child is released only once it has answered. It used to be unref'd
    // on spawn, and that emptied the event loop: the prompt that asked "open
    // it?" leaves stdin paused when it resolves, so nothing else was pending
    // and Node exited 0 — the wizard vanished the moment the browser appeared,
    // before this promise could settle and the next question could be asked.
    let settled = false;
    const settle = (opened: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(handoff);
      child.unref();
      resolve(opened);
    };

    // `open`/`xdg-open`/`start` exit as soon as they hand off to the browser,
    // so the exit code is a reliable success signal without waiting on the
    // browser itself. An opener that instead stays attached to the browser it
    // launched is treated as having handed off once it has run this long.
    const handoff = setTimeout(() => settle(true), HANDOFF_TIMEOUT_MS);
    child.on("error", () => {
      settle(false);
    });
    child.on("exit", (code) => {
      settle(code === 0);
    });
  });
}

function openerCommand(
  url: string,
  platform: typeof process.platform,
): { args: string[]; executable: string } | null {
  switch (platform) {
    case "darwin":
      return { args: [url], executable: "open" };
    case "win32":
      return {
        args: ["url.dll,FileProtocolHandler", url],
        executable: "rundll32",
      };
    case "linux":
    case "freebsd":
    case "openbsd":
      return { args: [url], executable: "xdg-open" };
    default:
      return null;
  }
}
