import { spawn } from "node:child_process";

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
    child.on("error", () => {
      resolve(false);
    });
    // `open`/`xdg-open`/`start` exit as soon as they hand off to the browser,
    // so the exit code is a reliable success signal without waiting on the
    // browser itself.
    child.on("exit", (code) => {
      resolve(code === 0);
    });
    child.unref();
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
