/**
 * Docker on this machine: is it installed, is it running, may the CLI fix
 * either.
 *
 * The one preflight that turned real evaluations into a wall of errors was a
 * Docker Desktop that had never been started. `up.sh` checks for the `docker`
 * binary only, so both answers are established here, before the script runs,
 * and each has a consent-gated fix — the same offer-and-ask shape as the ssh
 * installer's Docker bootstrap, on the user's own machine instead of a
 * server. Nothing is installed or started without a yes or its flag.
 */

import { PRODUCT_NAME } from "../../branding";
import { compareVersions } from "../../semver";
import type { Progress } from "../../progress";
import { notice } from "../selfhostInstall/ask";
import {
  canAsk,
  readBooleanFlag,
  type ParsedArgs,
} from "../selfhostSession";
import { RemoteScriptFailure } from "../scriptRunner";
import { DeclinedError, UsageError, type CommandDeps } from "../shared";
import { captureLocal } from "./process";

export type DockerState =
  | "denied"
  | "down"
  | "missing"
  | "no-compose"
  | "ready";

export async function probeDocker(deps: CommandDeps): Promise<DockerState> {
  const version = await captureLocal(deps, {
    args: ["--version"],
    command: "docker",
  });
  if (version.spawnError !== null || version.exitCode !== 0) {
    return "missing";
  }

  const info = await captureLocal(deps, { args: ["info"], command: "docker" });
  if (info.exitCode !== 0) {
    return /permission denied/iu.test(info.output) ? "denied" : "down";
  }

  const compose = await captureLocal(deps, {
    args: ["compose", "version"],
    command: "docker",
  });
  return compose.exitCode === 0 ? "ready" : "no-compose";
}

const DOCKER_START_TIMEOUT_MS = 120_000;
const DOCKER_START_POLL_MS = 2_000;

export type DockerRuntime = {
  /** How it is launched. `interactive` lets a sudo ask for its password. */
  args: readonly string[];
  command: string;
  interactive: boolean;
  name: string;
};

const MAC_INSTALL_URL = "https://docs.docker.com/desktop/setup/install/mac-install/";
const LINUX_INSTALL_URL = "https://docs.docker.com/engine/install/";
const WINDOWS_INSTALL_URL = "https://docs.docker.com/desktop/setup/install/windows-install/";

export type EnsureDockerInput = {
  parsed: ParsedArgs;
  platform?: typeof process.platform;
  progress: Progress;
};

/**
 * Leaves with Docker answering, or throws with what the user must do.
 *
 * At most one install and one start: after an install Docker Desktop is
 * present but not running, which the second pass then starts, and the pass
 * after that is the one that vouches for Compose.
 */
export async function ensureDocker(
  deps: CommandDeps,
  input: EnsureDockerInput,
): Promise<void> {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    // Refused before any probe: a Windows Docker Desktop answers `docker
    // info` perfectly well, and the run would then clone the source and die
    // on `bash <path>` with nothing to tell the user what went wrong.
    throw new UsageError(
      [
        "This command runs the evaluation stack through a bash script, which a Windows shell cannot do.",
        "",
        `Install Docker Desktop with the WSL 2 backend and run this from a WSL shell: ${WINDOWS_INSTALL_URL}`,
      ].join("\n"),
    );
  }

  let installed = false;

  for (;;) {
    const state = await probeDocker(deps);
    switch (state) {
      case "ready":
        return;
      case "missing": {
        // A Docker Desktop (or OrbStack) copied to /Applications but never
        // opened has no `docker` on PATH yet — the app links the CLI in on
        // its first launch — so it probes as missing. Installing over it is
        // the move every precedent got burned by (Homebrew's cask refuses an
        // existing app; the bundled installer has deleted one,
        // docker/for-mac#6442), so such an app is started, not reinstalled.
        if (await installedDesktopApp(deps, platform)) {
          await startDocker(deps, input, platform, { firstLaunch: true });
          continue;
        }
        if (installed) {
          throw new RemoteScriptFailure(
            "Docker was installed, but `docker` is still not on PATH. Open a new terminal and run this again.",
          );
        }
        await installDocker(deps, input, platform);
        installed = true;
        continue;
      }
      case "down":
        // Back through the probe rather than out: only `docker info` was
        // waited for, and a daemon that was down is no word on Compose.
        await startDocker(deps, input, platform);
        continue;
      case "denied":
        throw new UsageError(
          [
            "Docker is installed, but your account is not allowed to use it.",
            "",
            ...(platform === "linux"
              ? [
                  "Add your account to the docker group, then log out and back in:",
                  "  sudo usermod -aG docker $(whoami)",
                ]
              : ["Check the permissions on the Docker socket, then run this again."]),
          ].join("\n"),
        );
      case "no-compose":
        throw new UsageError(
          [
            "Docker is running, but Docker Compose v2 (the `docker compose` plugin) is missing.",
            "",
            `Install it and run this again: ${LINUX_INSTALL_URL}`,
          ].join("\n"),
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

async function installDocker(
  deps: CommandDeps,
  input: EnsureDockerInput,
  platform: typeof process.platform,
): Promise<void> {
  if (platform === "darwin") {
    const brew = await captureLocal(deps, {
      args: ["--version"],
      command: "brew",
    });
    if (brew.spawnError !== null || brew.exitCode !== 0) {
      await installDesktopFromDmg(deps, input);
      return;
    }

    await confirmChange(deps, input, {
      flag: "--install-docker",
      lead: `Docker is not installed. ${PRODUCT_NAME}'s evaluation stack runs in containers, so it is needed first.`,
      question: "Install Docker Desktop with Homebrew now?",
      refusal: `Install Docker Desktop yourself and run this again: ${MAC_INSTALL_URL}`,
    });

    input.progress.write("installing Docker Desktop with Homebrew");
    input.progress.settle();
    const result = await deps.runProcess({
      // The cask was renamed from `docker` in 2025; the old name is an alias
      // that may not outlive the rename.
      args: ["install", "--cask", "docker-desktop"],
      command: "brew",
      interactive: true,
    });
    if (result.exitCode !== 0) {
      throw new RemoteScriptFailure(
        `Homebrew could not install Docker Desktop (exit status ${String(result.exitCode ?? 1)}). See its output above, or install it yourself: ${MAC_INSTALL_URL}`,
      );
    }
    return;
  }

  if (platform === "linux") {
    await confirmChange(deps, input, {
      flag: "--install-docker",
      lead: `Docker is not installed. ${PRODUCT_NAME}'s evaluation stack runs in containers, so it is needed first.`,
      question: "Install Docker Engine with Docker's install script now? (uses sudo)",
      refusal: `Install Docker Engine and the Compose plugin yourself and run this again: ${LINUX_INSTALL_URL}`,
    });

    input.progress.write("installing Docker Engine");
    input.progress.settle();
    const result = await deps.runProcess({
      args: ["-c", LINUX_INSTALL_SCRIPT],
      command: "bash",
      interactive: true,
    });
    if (result.exitCode !== 0) {
      throw new RemoteScriptFailure(
        `The Docker install did not finish (exit status ${String(result.exitCode ?? 1)}). See its output above, or install it yourself: ${LINUX_INSTALL_URL}`,
      );
    }

    // Group membership is resolved at login, so the account that just ran the
    // install cannot use Docker until its next session — said here, because
    // the probe that follows will otherwise report a bare "permission denied".
    notice(
      deps,
      "Docker is installed. If the next step reports that your account cannot use it, log out and back in (group membership applies at login), then run this again.",
    );
    return;
  }

  throw new UsageError(
    [
      "Docker is not installed, and this command can only set Docker up on macOS and Linux.",
      "",
      "Install Docker with Compose v2 yourself and run this again: https://docs.docker.com/get-docker/",
    ].join("\n"),
  );
}

/**
 * Docker Desktop without Homebrew: Docker's own command-line install — the
 * DMG, `hdiutil`, and the installer the bundle ships — which is also all the
 * cask does. Decided in
 * `wiki/discussions/local-eval-docker-desktop-install.md`; the short form:
 *
 * - `--user` so the CLI symlinks exist right after the install and first
 *   launch needs no admin password; no `--accept-license`, because the
 *   Docker Subscription Service Agreement is paid above a company size and
 *   is the user's to accept, at first launch, as the start step expects.
 * - The always-latest URL over TLS. Docker publishes no checksum for the
 *   Mac DMG (release notes carry none; the `.sha256sum` path is denied), so
 *   pinning would mean carrying our own hash per monthly release, as the
 *   cask does. The Linux path (get.docker.com) has the same trust.
 * - Before the download, the release feed the app itself updates from says
 *   which version, how large, and the macOS it needs — shown in the
 *   question, and refused early when this Mac is too old.
 */
async function installDesktopFromDmg(
  deps: CommandDeps,
  input: EnsureDockerInput,
): Promise<void> {
  const release = await latestDesktopRelease(deps);
  if (release?.minimumMacos !== undefined) {
    const macos = (
      await captureLocal(deps, { args: ["-productVersion"], command: "sw_vers" })
    ).output.trim();
    if (macos !== "" && compareVersions(macos, release.minimumMacos) < 0) {
      throw new UsageError(
        [
          `Docker is not installed, and the current Docker Desktop (${release.version}) needs macOS ${release.minimumMacos} or later; this Mac runs ${macos}.`,
          "",
          `Docker keeps releases for earlier macOS versions: ${MAC_INSTALL_URL}`,
        ].join("\n"),
      );
    }
  }

  const what =
    release === null
      ? "Docker Desktop"
      : `Docker Desktop ${release.version} (${formatMegabytes(release.bytes)})`;
  await confirmChange(deps, input, {
    flag: "--install-docker",
    lead: `Docker is not installed, and Homebrew is not available to install it. ${PRODUCT_NAME}'s evaluation stack runs in containers, so Docker is needed first.`,
    question: `Download and install ${what} from docker.com now? (uses sudo)`,
    refusal: `Install Docker Desktop yourself and run this again: ${MAC_INSTALL_URL}`,
  });

  input.progress.write(`installing ${what}`);
  input.progress.settle();
  const result = await deps.runProcess({
    args: ["-c", MAC_INSTALL_SCRIPT],
    command: "bash",
    interactive: true,
  });
  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `The Docker Desktop install did not finish (exit status ${String(result.exitCode ?? 1)}). See its output above, or install it yourself: ${MAC_INSTALL_URL}`,
    );
  }
}

const MAC_INSTALL_SCRIPT = [
  "set -e",
  'case "$(uname -m)" in',
  "  arm64) arch=arm64 ;;",
  "  x86_64) arch=amd64 ;;",
  '  *) echo "Docker Desktop has no build for this Mac ($(uname -m))" >&2; exit 3 ;;',
  "esac",
  'command -v curl >/dev/null 2>&1 || { echo "curl is required to download Docker Desktop" >&2; exit 3; }',
  'work="$(mktemp -d)"',
  'volume="$work/Docker"',
  'mounted=""',
  "cleanup() {",
  '  if [ -n "$mounted" ]; then hdiutil detach "$volume" -quiet || hdiutil detach "$volume" -force -quiet || return 0; fi',
  '  rm -rf "$work"',
  "}",
  "trap cleanup EXIT",
  'url="https://desktop.docker.com/mac/main/$arch/Docker.dmg"',
  'echo "downloading $url"',
  'curl -fL --progress-bar "$url" -o "$work/Docker.dmg"',
  'mkdir -p "$volume"',
  'hdiutil attach -nobrowse -readonly -quiet -mountpoint "$volume" "$work/Docker.dmg"',
  "mounted=1",
  'echo "installing Docker Desktop to /Applications (sudo may ask for your password)"',
  'sudo "$volume/Docker.app/Contents/MacOS/install" --user="$(id -un)"',
].join("\n");

type DesktopRelease = {
  bytes: number;
  minimumMacos?: string;
  version: string;
};

/**
 * Docker Desktop's update feed (Sparkle appcast) for this Mac's
 * architecture: the one place Docker states the current version, its size,
 * and the macOS it needs. Best-effort — without it the install goes ahead
 * unnamed, since the download URL does not depend on it.
 */
async function latestDesktopRelease(
  deps: CommandDeps,
): Promise<DesktopRelease | null> {
  const machine = (
    await captureLocal(deps, { args: ["-m"], command: "uname" })
  ).output.trim();
  const arch =
    machine === "arm64" ? "arm64" : machine === "x86_64" ? "amd64" : null;
  if (arch === null) {
    return null;
  }

  const feed = await captureLocal(deps, {
    args: [
      "-fsSL",
      "--max-time",
      "10",
      `https://desktop.docker.com/mac/main/${arch}/appcast.xml`,
    ],
    command: "curl",
  });
  if (feed.spawnError !== null || feed.exitCode !== 0) {
    return null;
  }

  // The first enclosure is the full installer; the deltas follow it.
  const enclosure = /<enclosure\s[^>]*>/u.exec(feed.output)?.[0];
  const version = enclosure
    ? /sparkle:shortVersionString="([^"]+)"/u.exec(enclosure)?.[1]
    : undefined;
  const bytes = enclosure
    ? Number(/\slength="(\d+)"/u.exec(enclosure)?.[1])
    : Number.NaN;
  if (version === undefined || !Number.isFinite(bytes)) {
    return null;
  }
  const minimumMacos =
    /<sparkle:minimumSystemVersion>([^<]+)</u.exec(feed.output)?.[1]?.trim();
  return {
    bytes,
    ...(minimumMacos !== undefined && minimumMacos !== ""
      ? { minimumMacos }
      : {}),
    version,
  };
}

function formatMegabytes(bytes: number): string {
  return `${String(Math.round(bytes / 1_000_000))} MB`;
}

/**
 * The same get.docker.com flow the ssh installer runs on a server, with one
 * difference: this runs in the user's own terminal, so sudo may ask for a
 * password instead of being forbidden to.
 */
const LINUX_INSTALL_SCRIPT = [
  "set -e",
  'if [ "$(id -u)" = 0 ]; then sudo_prefix=""; else sudo_prefix="sudo"; fi',
  'command -v curl >/dev/null 2>&1 || { echo "curl is required to download the Docker install script" >&2; exit 3; }',
  'script="$(mktemp)"',
  "trap 'rm -f \"$script\"' EXIT",
  'curl -fsSL https://get.docker.com -o "$script"',
  '$sudo_prefix sh "$script"',
  'if [ "$(id -u)" != 0 ]; then $sudo_prefix usermod -aG docker "$(id -un)"; fi',
  "if command -v systemctl >/dev/null 2>&1; then $sudo_prefix systemctl enable --now docker >/dev/null 2>&1 || true; fi",
].join("\n");

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

async function startDocker(
  deps: CommandDeps,
  input: EnsureDockerInput,
  platform: typeof process.platform,
  options: {
    /** The app is present but has never been opened; `docker` is not on PATH yet. */
    firstLaunch?: boolean;
  } = {},
): Promise<void> {
  const runtime = await detectRuntime(deps, platform);
  if (runtime === null) {
    throw new UsageError(
      [
        "Docker is installed but not running, and this command could not tell how to start it here.",
        "",
        "Start Docker yourself and run this again.",
      ].join("\n"),
    );
  }

  await confirmChange(deps, input, {
    flag: "--start-docker",
    lead:
      options.firstLaunch === true
        ? `${runtime.name} is installed but has never been opened, so the \`docker\` command is not available yet. ${PRODUCT_NAME}'s evaluation stack runs in containers, so it must be running first.`
        : `Docker is installed but not running. ${PRODUCT_NAME}'s evaluation stack runs in containers, so it must be running first.`,
    question: `Start ${runtime.name} now?`,
    refusal: `Start ${runtime.name} yourself and run this again.`,
  });

  input.progress.write(`starting ${runtime.name}`);
  if (runtime.interactive) {
    input.progress.settle();
  }
  const started = await deps.runProcess({
    args: runtime.args,
    command: runtime.command,
    ...(runtime.interactive ? { interactive: true } : {}),
  });
  if (started.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `${runtime.name} could not be started (\`${[runtime.command, ...runtime.args].join(" ")}\` exited with status ${String(started.exitCode ?? 1)}). Start it yourself and run this again.`,
    );
  }

  input.progress.write(`waiting for ${runtime.name} to start`);
  if (runtime.name === "Docker Desktop") {
    input.progress.detail(
      "if Docker Desktop shows a first-run dialog, finish it — this waits up to two minutes",
    );
  }

  const deadline = deps.now() + DOCKER_START_TIMEOUT_MS;
  for (;;) {
    const info = await captureLocal(deps, { args: ["info"], command: "docker" });
    if (info.exitCode === 0) {
      return;
    }
    if (deps.now() >= deadline) {
      // Seen in practice when Docker Desktop is relaunched while its previous
      // instance is still shutting down: the app is up, the engine's VM never
      // comes. Its own window is where that shows.
      throw new RemoteScriptFailure(
        [
          `${runtime.name} did not start answering within two minutes.`,
          "",
          runtime.name === "Docker Desktop"
            ? "Open Docker Desktop to see what it is doing — if it is stuck starting, quit it fully and start it again — then run this again."
            : `Check that ${runtime.name} is running, then run this again.`,
          // A first launch may have put the CLI somewhere only a new shell
          // sees (~/.docker/bin when the privileged helper is declined).
          ...(options.firstLaunch === true
            ? [
                `If ${runtime.name} is up, its \`docker\` command may only be on PATH in a new terminal: open one and run this again.`,
              ]
            : []),
        ].join("\n"),
      );
    }
    await deps.sleep(DOCKER_START_POLL_MS);
  }
}

/**
 * Which Docker runtime to start. The active context is the sharpest signal —
 * a user with both Docker Desktop and Colima installed has chosen one — and
 * whichever app is installed is the fallback.
 */
export async function detectRuntime(
  deps: CommandDeps,
  platform: typeof process.platform,
): Promise<DockerRuntime | null> {
  if (platform === "linux") {
    const systemctl = await captureLocal(deps, {
      args: ["--version"],
      command: "systemctl",
    });
    if (systemctl.spawnError !== null) {
      return null;
    }
    return {
      args: ["systemctl", "start", "docker"],
      command: "sudo",
      interactive: true,
      name: "the Docker service",
    };
  }

  if (platform !== "darwin") {
    return null;
  }

  const context = (
    await captureLocal(deps, { args: ["context", "show"], command: "docker" })
  ).output.trim();
  const desktop = await appInstalled(deps, "Docker");
  const orbstack = await appInstalled(deps, "OrbStack");
  const colima = await captureLocal(deps, {
    args: ["version"],
    command: "colima",
  });
  const hasColima = colima.spawnError === null && colima.exitCode === 0;

  const candidates: DockerRuntime[] = [];
  if (desktop) {
    candidates.push(DOCKER_DESKTOP);
  }
  if (orbstack) {
    candidates.push(ORBSTACK);
  }
  if (hasColima) {
    candidates.push(COLIMA);
  }

  if (context === "orbstack" && orbstack) {
    return ORBSTACK;
  }
  if (context === "colima" && hasColima) {
    return COLIMA;
  }
  if (context === "desktop-linux" && desktop) {
    return DOCKER_DESKTOP;
  }

  return candidates[0] ?? null;
}

const DOCKER_DESKTOP: DockerRuntime = {
  args: ["-a", "Docker"],
  command: "open",
  interactive: false,
  name: "Docker Desktop",
};

const ORBSTACK: DockerRuntime = {
  args: ["-a", "OrbStack"],
  command: "open",
  interactive: false,
  name: "OrbStack",
};

const COLIMA: DockerRuntime = {
  args: ["start"],
  command: "colima",
  interactive: true,
  name: "Colima",
};

/**
 * A Docker app bundle on this Mac, whether or not the `docker` CLI it links
 * in on first launch exists yet. Only the apps that bring their own CLI count:
 * Colima needs a separately installed `docker`, so its presence says nothing
 * about a missing one.
 */
async function installedDesktopApp(
  deps: CommandDeps,
  platform: typeof process.platform,
): Promise<boolean> {
  if (platform !== "darwin") {
    return false;
  }
  return (
    (await appInstalled(deps, "Docker")) || (await appInstalled(deps, "OrbStack"))
  );
}

/** `/Applications/<name>.app`, or the user's own Applications folder. */
async function appInstalled(deps: CommandDeps, name: string): Promise<boolean> {
  const home = deps.env.HOME;
  const candidates = [
    `/Applications/${name}.app`,
    ...(home !== undefined && home !== "" ? [`${home}/Applications/${name}.app`] : []),
  ];
  for (const path of candidates) {
    try {
      if ((await deps.stat(path)).isDirectory()) {
        return true;
      }
    } catch {
      // not there
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * A change to this machine needs a yes or its flag. A scripted run without
 * the flag is told which flag, rather than having the CLI decide on its own.
 */
async function confirmChange(
  deps: CommandDeps,
  input: EnsureDockerInput,
  change: { flag: string; lead: string; question: string; refusal: string },
): Promise<void> {
  if (readBooleanFlag(input.parsed, change.flag)) {
    return;
  }

  if (!canAsk(deps, input.parsed)) {
    throw new UsageError(
      `${change.lead} Pass ${change.flag} to let this command do it, or do it yourself first.`,
    );
  }

  input.progress.settle();
  notice(deps, change.lead);
  const agreed =
    (await deps.confirm?.({ initial: true, message: change.question })) ?? false;
  if (!agreed) {
    throw new DeclinedError(change.refusal);
  }
}
