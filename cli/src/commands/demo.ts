/**
 * `cmpatch demo` — watch an OTA update apply on a simulator against the
 * local evaluation stack.
 *
 * Same shape as `selfhost local-eval`: one progress tree from the header to
 * the closing line, a welcome before the first step, long work as steps,
 * questions over a settled step, and a confirm after the app is running
 * whose Ctrl+C means "not now" rather than a failed run.
 */

import { writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { PATCH_DOCS_SITE_URL, PRODUCT_NAME } from "../branding";
import type { DemoCommand, ReleaseReactCommand } from "../commandTypes";
import { loadStoredCredential } from "../credentialStore";
import { createProgress, type Progress } from "../progress";
import { getCliVersion } from "../version";
import { executeLogin } from "./auth";
import { isRecord } from "../output";
import { DASHBOARD_URL, isSshSession, SERVER_URL } from "./localEval";
import { captureLocal } from "./localEval/process";
import { managedCheckoutPath } from "./localEval/source";
import {
  DEMO_APP_ID,
  selectDemoDevice,
  resumeDemoDevice,
  type DemoDevice,
} from "./demoDevice";
import { executeReleaseInspect } from "./releaseInspect";
import { executeReleaseReact } from "./releaseReact";
import {
  confirmFinishStep,
  noteBlock,
  notice,
  offerBrowserOpen,
  paletteFor,
} from "./selfhostInstall/ask";
import {
  canAsk,
  parseArgs,
  readStringFlag,
  type FlagShape,
  type ParsedArgs,
} from "./selfhostSession";
import { UsageError, type CommandDeps } from "./shared";

export const DEMO_USAGE = "Usage: cmpatch demo [flags]";
export const DEMO_REL = "examples/on-device-demo";
export const CATALOG_LOOKUP_BROKEN = "const products = response;";
export const CATALOG_LOOKUP_FIXED = "const products = response.products;";

const LABEL = "cmpatch demo";
const SEEDED_DEPLOYMENT = "staging";
const TARGET_BINARY_VERSION = "1.0.0";
const PUBLISH_WAIT_SECONDS = 60;

const DEMO_FLAGS = {
  "--checkout": "value",
  "--non-interactive": "boolean",
  "--platform": "value",
} as const satisfies FlagShape;

type Platform = "android" | "ios";

export async function executeDemoCommand(
  command: DemoCommand,
  deps: CommandDeps,
): Promise<string | null> {
  const parsed = parseArgs(command.argv, DEMO_FLAGS);
  if (parsed.positionals.length > 0) {
    throw new UsageError(DEMO_USAGE);
  }

  const progress = createProgress({
    intro: "at-start",
    label: LABEL,
    stderr: deps.stderr,
    title: `${PRODUCT_NAME} · ${LABEL} ${paletteFor(deps).dim(getCliVersion())}`,
  });

  let booted = false;
  try {
    if (canAsk(deps, parsed)) {
      notice(deps, renderWelcome());
    }

    progress.write("checking the evaluation stack");
    if (!(await evaluationStackReady(deps))) {
      throw new UsageError(
        `The local evaluation stack is not running. Start it with \`cmpatch selfhost local-eval\`, then run \`${LABEL}\` again.`,
      );
    }

    const os = deps.platform ?? process.platform;
    const flagged = readPlatformFlag(parsed, os);

    const demoRoot = await resolveDemoRoot(deps, parsed);
    // Platform and sign-in can ask; they belong over a settled step, before
    // the Release build that takes minutes.
    progress.settle();
    const platform = await resolvePlatform(deps, parsed, os, flagged);
    const device = await ensureToolchain(deps, progress, platform, demoRoot);
    progress.settle();
    await ensureSignedIn(deps, parsed);
    progress.write(`using ${platform} device ${device.id}`);

    await writeCatalogLookup(deps, demoRoot, true);
    await runYarn(
      deps,
      progress,
      demoRoot,
      ["install"],
      "installing demo dependencies",
    );
    if (platform === "ios") {
      await runYarn(
        deps,
        progress,
        demoRoot,
        ["demo:setup:ios"],
        "installing iOS pods",
      );
    }
    await removePreviousInstall(deps, progress, device);
    // Avoid Gradle installRelease installing onto every connected Android device.
    // The RN launcher installs the assembled APK using the explicit serial.
    await runYarn(
      deps,
      progress,
      demoRoot,
      platform === "ios"
        ? ["demo:ios", "--udid", device.id]
        : ["demo:android", "--device", device.id, "--tasks", "assembleRelease"],
      `building and launching the ${platform} app`,
      platform === "android" ? { ANDROID_SERIAL: device.id } : undefined,
    );
    booted = true;

    progress.settle();
    notice(deps, [
      "In the app, the product cards should show an error instead of products.",
    ]);

    const palette = paletteFor(deps);
    noteBlock(deps, "The fix in App.tsx", [
      palette.err(`- ${CATALOG_LOOKUP_BROKEN}`),
      palette.ok(`+ ${CATALOG_LOOKUP_FIXED}`),
    ]);
    notice(deps, [
      "The catalog response wraps the product array in products; the app reads the wrong level.",
      "The CLI will make this change and publish it as an OTA update.",
      "The installed app receives the JavaScript change without rebuilding or reinstalling the native app.",
    ]);

    const publish = canAsk(deps, parsed)
      ? await confirmFinishStep(deps, {
          initial: true,
          message: "Publish the fix as an OTA update?",
        })
      : true;

    if (!publish) {
      progress.stop(
        "The demo app is running. Publish the fix later with the same command, or follow the README in that directory.",
      );
      return renderDeclined(demoRoot, platform);
    }

    await writeCatalogLookup(deps, demoRoot, false);
    let published: unknown;
    try {
      progress.write("publishing the fix");
      published = await executeReleaseReact(
        releaseCommand(demoRoot, platform),
        deps,
        progress,
      );
    } finally {
      await writeCatalogLookup(deps, demoRoot, true);
    }

    await waitUntilReleasePublished(deps, progress, published);
    progress.write("bringing the demo app back to check for the update");
    const resumed = await resumeDemoDevice(deps, device);
    progress.settle();
    const dashboardUrl = releaseDashboardUrl(published);
    noteBlock(deps, "The demo update is published", [
      ...(resumed
        ? []
        : [
            "Could not switch the app automatically. Background the app and bring it back.",
          ]),
      "The app will download and apply the update automatically.",
      "After the app reloads, the product cards should load.",
    ]);
    await offerReleaseDashboard(deps, parsed, dashboardUrl);
    notice(deps, [
      "Next: try Patch with your own app while the local stack is running.",
      `${PATCH_DOCS_SITE_URL}/#5-try-it-with-your-own-app`,
    ]);
    progress.stop();
    return null;
  } catch (error) {
    progress.fail(
      booted
        ? "The demo app is running, but the steps after it did not finish."
        : "The demo walkthrough could not be completed.",
    );
    throw error;
  }
}

/**
 * The release page, offered the same way local-eval offers the dashboard:
 * Ctrl+C is "not now". The URL is not printed next to the question (it wraps
 * and is not needed once the browser opens). Over SSH, and when there is
 * nobody to ask, the URL is the whole answer, because a browser opened from
 * here would hit the wrong localhost or there is no prompt to accept.
 */
async function offerReleaseDashboard(
  deps: CommandDeps,
  parsed: ParsedArgs,
  url: string | undefined,
): Promise<void> {
  if (url === undefined) {
    return;
  }

  if (!canAsk(deps, parsed)) {
    notice(deps, ["The release is at:", `  ${url}`]);
    return;
  }

  if (isSshSession(deps.env)) {
    notice(deps, [
      `This is an SSH session, so ${DASHBOARD_URL} is on the machine you are logged in to, not on the one your browser runs on.`,
      "To open the release from there, forward the port first: ssh -L 8080:localhost:8080 <this machine>, then open:",
      `  ${url}`,
    ]);
    return;
  }

  await offerBrowserOpen(deps, {
    abort: "decline",
    message: "Open this release in the dashboard?",
    url,
  });
}

async function waitUntilReleasePublished(
  deps: CommandDeps,
  progress: Progress,
  result: unknown,
): Promise<void> {
  const releaseId = publishedReleaseId(result);
  if (releaseId === undefined) {
    return;
  }

  progress.write("waiting for the release to be published");
  await executeReleaseInspect(
    {
      kind: "release-inspect",
      logs: false,
      release: { releaseId },
      serverUrl: SERVER_URL,
      timeoutSeconds: PUBLISH_WAIT_SECONDS,
      wait: true,
    },
    deps,
    progress,
  );
}

function publishedRelease(
  result: unknown,
): Record<string, unknown> | undefined {
  return isRecord(result) && isRecord(result.release)
    ? result.release
    : undefined;
}

function publishedReleaseId(result: unknown): string | undefined {
  const id = publishedRelease(result)?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

function releaseDashboardUrl(result: unknown): string | undefined {
  const release = publishedRelease(result);
  const teamId = typeof release?.team_id === "string" ? release.team_id : "";
  const appId = typeof release?.app_id === "string" ? release.app_id : "";
  const deploymentId =
    typeof release?.deployment_id === "string" ? release.deployment_id : "";
  const releaseId = typeof release?.id === "string" ? release.id : "";
  if (
    teamId === "" ||
    appId === "" ||
    deploymentId === "" ||
    releaseId === ""
  ) {
    return undefined;
  }
  return `${DASHBOARD_URL}/teams/${teamId}/apps/${appId}/deployments/${deploymentId}/releases/${releaseId}`;
}

function renderWelcome(): string[] {
  return [
    `Welcome! This command builds the on-device demo against the local evaluation stack and walks an OTA update onto a simulator: the product catalog starts broken on purpose, then the fix is published and you watch it apply.`,
    "The first run installs pods and a Release build, which takes a few minutes; later runs are shorter. It needs the evaluation stack up, and Xcode or an Android emulator.",
  ];
}

async function evaluationStackReady(deps: CommandDeps): Promise<boolean> {
  try {
    const response = await deps.fetch(`${DASHBOARD_URL}/health/ready`);
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function resolveDemoRoot(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<string> {
  const explicit = readStringFlag(parsed, "--checkout");
  if (explicit !== undefined) {
    const path = isAbsolute(explicit) ? explicit : resolve(explicit);
    // Walk up: `yarn workspace @codemagic/patch-cli dev` runs with cwd in
    // `cli/`, so `--checkout .` is that package, not the monorepo root.
    const resolved = await findDemoWalkingUp(deps, path);
    if (resolved === null) {
      throw new UsageError(
        `${path} is not a ${PRODUCT_NAME} checkout (missing ${DEMO_REL}) and is not the demo app itself.`,
      );
    }
    return resolved;
  }

  const fromCwd = await findDemoWalkingUp(deps, process.cwd());
  if (fromCwd !== null) {
    return fromCwd;
  }

  const managed = await demoRootAt(deps, managedCheckoutPath(deps.env));
  if (managed !== null) {
    return managed;
  }

  throw new UsageError(
    `Could not find ${DEMO_REL}. Run \`cmpatch selfhost local-eval\` first, pass \`--checkout\` at a clone of this repository, or run this command from inside one.`,
  );
}

async function demoRootAt(
  deps: CommandDeps,
  path: string,
): Promise<string | null> {
  if (await isDemoApp(deps, path)) {
    return path;
  }
  const nested = join(path, DEMO_REL);
  if (await isDemoApp(deps, nested)) {
    return nested;
  }
  return null;
}

async function findDemoWalkingUp(
  deps: CommandDeps,
  start: string,
): Promise<string | null> {
  let current = start;
  for (;;) {
    const found = await demoRootAt(deps, current);
    if (found !== null) {
      return found;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function isDemoApp(deps: CommandDeps, path: string): Promise<boolean> {
  try {
    return (await deps.stat(join(path, "App.tsx"))).isFile();
  } catch {
    return false;
  }
}

function readPlatformFlag(
  parsed: ParsedArgs,
  os: typeof process.platform,
): Platform | undefined {
  const flagged = readStringFlag(parsed, "--platform");
  if (flagged === undefined) {
    return undefined;
  }
  if (flagged !== "ios" && flagged !== "android") {
    throw new UsageError("--platform must be ios or android");
  }
  if (flagged === "ios" && os !== "darwin") {
    throw new UsageError("iOS builds need macOS with Xcode.");
  }
  return flagged;
}

async function resolvePlatform(
  deps: CommandDeps,
  parsed: ParsedArgs,
  os: typeof process.platform,
  flagged: Platform | undefined,
): Promise<Platform> {
  if (flagged !== undefined) {
    return flagged;
  }

  if (os !== "darwin") {
    return "android";
  }

  if (!canAsk(deps, parsed) || deps.prompt === undefined) {
    throw new UsageError("Pass --platform ios or --platform android.");
  }

  const answer = await deps.prompt({
    choices: [
      { title: "iOS Simulator", value: "ios" },
      { title: "Android emulator", value: "android" },
    ],
    initial: 0,
    message: "Which platform?",
    type: "select",
  });
  const value = typeof answer === "string" ? answer : (answer[0] ?? "ios");
  return value === "android" ? "android" : "ios";
}

async function ensureToolchain(
  deps: CommandDeps,
  progress: Progress,
  platform: Platform,
  demoRoot: string,
): Promise<DemoDevice> {
  progress.write("checking the demo prerequisites");
  const problems: string[] = [];
  const probe = (command: string, args: string[]) =>
    captureLocal(deps, { command, args, cwd: demoRoot, timeoutMs: 15_000 });

  const node = await probe("node", ["--version"]);
  const version = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(node.output.trim());
  if (
    node.exitCode !== 0 ||
    version === null ||
    Number(version[1]) < 22 ||
    (Number(version[1]) === 22 && Number(version[2]) < 20)
  ) {
    problems.push(
      "Node.js >= 22.20.0 is required for the demo. Install a supported Node.js version and make sure node on PATH uses it (node --version).",
    );
  }

  const yarn = await probe("yarn", ["--version"]);
  if (yarn.exitCode !== 0 || yarn.spawnError !== null) {
    problems.push(
      "Yarn is unavailable or could not start. Install or enable Yarn with Corepack (corepack enable), then check yarn --version.",
    );
  }

  let deviceToolsReady: boolean;
  if (platform === "ios") {
    const xcode = await probe("xcodebuild", ["-version"]);
    deviceToolsReady = xcode.exitCode === 0;
    if (!deviceToolsReady) {
      problems.push(
        "Xcode is required for the iOS demo. Install it, open it once to finish setup, and check the active developer directory with xcode-select -p.",
      );
    }
    const pod = await probe("pod", ["--version"]);
    if (pod.exitCode !== 0) {
      // Bundler resolves the version pinned in Gemfile.lock from this cwd.
      const bundle = await probe("bundle", ["--version"]);
      if (bundle.exitCode !== 0) {
        problems.push(
          "iOS dependency setup needs working CocoaPods or the Bundler version required by the demo Gemfile.lock. Install CocoaPods (brew install cocoapods), or configure Ruby and the pinned Bundler version, then run bundle --version from the demo directory.",
        );
      }
    }
  } else {
    const adb = await probe("adb", ["version"]);
    deviceToolsReady = adb.exitCode === 0;
    if (!deviceToolsReady) {
      problems.push(
        "Android SDK platform-tools (adb) are required. Install them through Android Studio's SDK Manager and add platform-tools to PATH, then check adb version.",
      );
    }
    const java = await probe(
      deps.env.JAVA_HOME ? join(deps.env.JAVA_HOME, "bin", "java") : "java",
      ["-version"],
    );
    if (java.exitCode !== 0) {
      problems.push(
        "Java could not start. Configure a JDK for the Android build using JAVA_HOME, and verify that its bin/java executable runs.",
      );
    }
  }

  let device: DemoDevice | undefined;
  if (deviceToolsReady) {
    try {
      device = await selectDemoDevice(deps, platform);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      problems.push(error.message);
    }
  }
  if (problems.length > 0) {
    throw new UsageError(
      [
        "The demo needs a few things before it can build:",
        ...problems.map((problem) => `  - ${problem}`),
        "Fix these items, then run the same command again.",
      ].join("\n"),
    );
  }
  if (device === undefined)
    throw new UsageError("No demo device is available.");
  return device;
}

/** Remove the prior OTA only from the device this walkthrough will use. */
async function removePreviousInstall(
  deps: CommandDeps,
  progress: Progress,
  device: DemoDevice,
): Promise<void> {
  progress.write("removing any previous install");
  await ignoreProcess(
    deps,
    device.platform === "ios"
      ? {
          args: ["simctl", "uninstall", device.id, DEMO_APP_ID],
          command: "xcrun",
        }
      : { args: ["-s", device.id, "uninstall", DEMO_APP_ID], command: "adb" },
  );
}

async function ignoreProcess(
  deps: CommandDeps,
  run: { args: string[]; command: string },
): Promise<void> {
  try {
    await deps.runProcess(run);
  } catch {
    // Missing tool or nothing to uninstall: launch still proceeds.
  }
}

async function ensureSignedIn(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<void> {
  const stored = await loadStoredCredential(SERVER_URL, { env: deps.env });
  if (stored !== null) {
    return;
  }

  if (!canAsk(deps, parsed)) {
    throw new UsageError(
      `Sign in first: cmpatch login --server-url ${SERVER_URL}`,
    );
  }

  notice(
    deps,
    `Sign in to the evaluation stack (${SERVER_URL}). The local dashboard approves it automatically.`,
  );
  await executeLogin({ kind: "login", serverUrl: SERVER_URL }, deps);
}

async function runYarn(
  deps: CommandDeps,
  progress: Progress,
  demoRoot: string,
  args: readonly string[],
  step: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  progress.write(step);
  const chunks: string[] = [];
  let result;
  try {
    result = await deps.runProcess({
      args,
      command: "yarn",
      cwd: demoRoot,
      env,
      onOutput: (chunk) => {
        chunks.push(chunk);
        progress.detail(chunk.trim());
      },
    });
  } catch (error) {
    throw new UsageError(
      `yarn is required to build the demo app, and it is not on PATH. Enable it with Corepack (corepack enable) and run this again.${
        error instanceof Error ? ` (${error.message})` : ""
      }`,
    );
  }

  if (result.exitCode !== 0) {
    const tail = chunks.join("").trim().split("\n").slice(-20).join("\n");
    throw new UsageError(
      [`${step} failed (yarn ${args.join(" ")}).`, "", tail].join("\n"),
    );
  }
}

export function withCatalogLookup(
  source: string,
  broken: boolean,
): string | null {
  const from = broken ? CATALOG_LOOKUP_FIXED : CATALOG_LOOKUP_BROKEN;
  const to = broken ? CATALOG_LOOKUP_BROKEN : CATALOG_LOOKUP_FIXED;
  if (source.includes(to) && !source.includes(from)) {
    return source;
  }
  if (!source.includes(from)) {
    return null;
  }
  return source.replace(from, to);
}

async function writeCatalogLookup(
  deps: CommandDeps,
  demoRoot: string,
  broken: boolean,
): Promise<void> {
  const path = join(demoRoot, "App.tsx");
  const source = (await deps.readFile(path)).toString("utf8");
  const next = withCatalogLookup(source, broken);
  if (next === null) {
    throw new UsageError(
      `${path} does not contain the catalog response lookup (${CATALOG_LOOKUP_BROKEN}).`,
    );
  }
  if (next !== source) {
    await writeFile(path, next);
  }
}

function releaseCommand(
  demoRoot: string,
  platform: Platform,
): ReleaseReactCommand {
  return {
    baseBytecode: "auto",
    bundler: "metro",
    deployment: {
      appName: platform === "ios" ? "demo-app-ios" : "demo-app-android",
      deploymentName: SEEDED_DEPLOYMENT,
    },
    disabled: false,
    dryRun: false,
    extraHermesFlags: [],
    hermes: "auto",
    isMandatory: false,
    kind: "release-react",
    noDuplicateReleaseError: true,
    platform,
    projectRoot: demoRoot,
    rolloutPercentage: 100,
    serverUrl: SERVER_URL,
    targetBinaryVersion: TARGET_BINARY_VERSION,
    yes: true,
  };
}

function renderDeclined(demoRoot: string, platform: Platform): string {
  return [
    `The ${platform} demo is running from:`,
    `  ${demoRoot}`,
    "",
    "When you are ready, run `cmpatch demo` again to publish the fix.",
  ].join("\n");
}
