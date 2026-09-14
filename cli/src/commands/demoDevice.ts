import { isRecord } from "../output";
import { captureLocal } from "./localEval/process";
import { UsageError, type CommandDeps } from "./shared";

export const DEMO_APP_ID = "io.codemagic.patch.demo";
export type DemoDevice = { platform: "ios" | "android"; id: string };
const DEVICE_TIMEOUT_MS = 15_000;

export async function selectDemoDevice(
  deps: Pick<CommandDeps, "env" | "runProcess">,
  platform: DemoDevice["platform"],
): Promise<DemoDevice> {
  if (platform === "android") {
    const result = await captureLocal(deps, {
      command: "adb",
      args: ["devices"],
      timeoutMs: DEVICE_TIMEOUT_MS,
    });
    const devices = result.output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[1] === "device")
      .map((parts) => parts[0]!);
    const requested = deps.env.ANDROID_SERIAL;
    const id =
      requested ||
      devices.find((serial) => serial.startsWith("emulator-")) ||
      devices[0];
    if (result.exitCode !== 0 || !id || !devices.includes(id)) {
      throw new UsageError(
        requested
          ? `Android device ${requested} is not available. Check adb devices and ANDROID_SERIAL.`
          : "No Android device is ready. Start an emulator, check adb devices, and run this again.",
      );
    }
    return { platform, id };
  }

  const result = await captureLocal(deps, {
    command: "xcrun",
    args: ["simctl", "list", "devices", "available", "-j"],
    timeoutMs: DEVICE_TIMEOUT_MS,
  });
  if (result.exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(
        result.output.slice(result.output.indexOf("{")),
      );
      if (isRecord(parsed) && isRecord(parsed.devices)) {
        const devices = Object.entries(parsed.devices)
          .filter(([runtime]) => runtime.includes("iOS"))
          .flatMap(([, entries]) => (Array.isArray(entries) ? entries : []))
          .filter(
            (device): device is Record<string, unknown> =>
              isRecord(device) &&
              typeof device.udid === "string" &&
              device.udid !== "" &&
              device.isAvailable !== false &&
              typeof device.name === "string" &&
              device.name.startsWith("iPhone"),
          );
        const chosen =
          devices.find((device) => device.state === "Booted") ?? devices[0];
        if (chosen) return { platform, id: chosen.udid as string };
      }
    } catch {
      /* Invalid device output is handled by the actionable error below. */
    }
  }
  throw new UsageError(
    "No available iPhone simulator. Install one in Xcode and run this again.",
  );
}

/** False preserves the published release and lets the CLI offer manual instructions. */
export async function resumeDemoDevice(
  deps: Pick<CommandDeps, "runProcess" | "sleep">,
  device: DemoDevice,
): Promise<boolean> {
  const command = device.platform === "ios" ? "xcrun" : "adb";
  const background =
    device.platform === "ios"
      ? ["simctl", "launch", device.id, "com.apple.Preferences"]
      : ["-s", device.id, "shell", "input", "keyevent", "KEYCODE_HOME"];
  const foreground =
    device.platform === "ios"
      ? ["simctl", "launch", device.id, DEMO_APP_ID]
      : [
          "-s",
          device.id,
          "shell",
          "am",
          "start",
          "-W",
          "-a",
          "android.intent.action.MAIN",
          "-c",
          "android.intent.category.LAUNCHER",
          "-n",
          `${DEMO_APP_ID}/.MainActivity`,
        ];
  const run = async (args: string[]) => {
    try {
      const chunks: string[] = [];
      const result = await deps.runProcess({
        command,
        args,
        timeoutMs: DEVICE_TIMEOUT_MS,
        onOutput: (chunk) => {
          chunks.push(chunk);
        },
      });
      if (result.signal === "SIGINT" || result.signal === "SIGTERM") {
        throw new DemoInterrupted();
      }
      return (
        result.exitCode === 0 &&
        !/^(?:Error:|Error type \d|Exception|Status: timeout)/m.test(
          chunks.join(""),
        )
      );
    } catch (error) {
      if (error instanceof DemoInterrupted) throw error;
      return false;
    }
  };
  const backgrounded = await run(background);
  if (backgrounded) await deps.sleep(1000);
  // Also recover focus after a failed/partially completed background command.
  const returned = await run(foreground);
  if (!returned) await run(foreground);
  return backgrounded && returned;
}

class DemoInterrupted extends Error {
  constructor() {
    super("Demo app switching was interrupted.");
  }
}
