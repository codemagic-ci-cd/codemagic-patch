/**
 * Everything `cmpatch selfhost install` does to the host before install.sh can
 * run: the preflight checks, the Docker and base-package bootstraps, the source
 * checkout, and the start-over edge that removes a previous attempt.
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { PRODUCT_NAME, SOURCE_REPO_URL } from "../../branding";
import {
  assembleScpArgs,
  captureRemoteShell,
  formatScpRemotePath,
  pairedSshInvocation,
} from "../../remoteExec";
import {
  checkHostMemory,
  probePublicPorts,
  renderFirewallHint,
  renderMemoryRejection,
} from "../../selfhostInstall";
import {
  probeRemotePublicAddress,
  type RemoteInstallFacts,
} from "../../selfhostRemote";
import {
  canAsk,
  readBooleanFlag,
  RemoteScriptFailure,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { DeclinedError, UsageError, type CommandDeps } from "../shared";
import { askValue, notice } from "./ask";

/**
 * `get.docker.com` supports these; anything else is sent to the docs rather
 * than handed a script that will fail halfway through as root.
 *
 * Hand-maintained against an unpinned upstream, so it can drift: `sles` and
 * `almalinux` used to be listed here, but the script now hard-rejects both
 * with an unconditional `exit 1` (verified live 2026-09-01), so they get the
 * docs-link rejection like Amazon Linux 2. The env-gated contract test in
 * `test/docker-bootstrap-contract.e2e.test.ts` (the P2-2 drift guard) checks
 * every entry against the live script — run it when touching this list.
 *
 * `linuxmint` and `pop` never appear in the script's own case statement; its
 * `check_forked` step remaps them to their Ubuntu/Debian base at runtime.
 */
export const DOCKER_BOOTSTRAP_DISTROS = new Set([
  "centos",
  "debian",
  "fedora",
  "linuxmint",
  "pop",
  "raspbian",
  "rhel",
  "rocky",
  "ubuntu",
]);

/**
 * Deliberate pins, bumped by hand when a new release is vetted.
 *
 * Amazon Linux 2023 packages Docker Engine itself but neither Compose v2
 * (amazon-linux-2023#186) nor a usable buildx — its RPM bundles buildx 0.12.1,
 * and `docker compose build`, which install.sh runs, needs 0.17 or newer
 * (amazon-linux-2023#1032). So the amzn bootstrap downloads both CLI plugins
 * from their GitHub releases at these exact versions and verifies each against
 * the checksums those releases publish.
 */
const AMAZON_LINUX_COMPOSE_VERSION = "v5.5.0";
const AMAZON_LINUX_BUILDX_VERSION = "v0.36.1";

// ---------------------------------------------------------------------------
// Host preflight
// ---------------------------------------------------------------------------

export async function runHostPreflight(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
): Promise<void> {
  const facts = session.facts.install;
  if (facts === undefined) {
    throw new UsageError(
      `could not survey ${session.sshTarget}; rerun cmpatch selfhost install to try again.`,
    );
  }

  if (!readBooleanFlag(parsed, "--skip-memory-check")) {
    const memory = checkHostMemory(facts.memoryTotalBytes);
    if (memory.kind === "too-small") {
      throw new UsageError(
        renderMemoryRejection(memory.reportedBytes, facts.cloudProvider).join(
          "\n",
        ),
      );
    }
  }

  // curl first, and not only because install.sh requires it: both Docker
  // bootstraps download with curl, so a host missing both would otherwise fail
  // inside the Docker offer the user just consented to.
  if (!facts.hasCurl) {
    await ensurePackage(deps, session, parsed, CURL_PACKAGE);
    await refreshPublicAddress(deps, session, facts);
  }

  await ensureDocker(deps, session, parsed, facts);

  if (!facts.hasGit) {
    await ensurePackage(deps, session, parsed, GIT_PACKAGE);
  }

  if (!readBooleanFlag(parsed, "--skip-port-check")) {
    session.progress.write("checking that the server is reachable on 80 and 443");
    const host = hostOf(session.sshTarget);
    const probe = await probePublicPorts({ connect: deps.connectTcp, host });

    if (probe.closedPorts.length > 0) {
      // A warning, never a stop: this probe cannot tell a closed firewall from
      // a network between the user and the server, and the run that matters
      // most — a corporate laptop on a filtered network — would be blocked by
      // an abort here for no reason.
      session.progress.settle();
      notice(deps, renderFirewallHint(probe.closedPorts, facts.cloudProvider));
    }
  }
}

/**
 * Asks again for the address the survey could only have answered with curl.
 *
 * The survey rides along with the pairing round trip, so on a host that turned
 * out to have no curl its metadata calls could not run and `publicIp` fell back
 * to the interface address — which on a cloud host is private and therefore
 * dropped. Left that way, the DNS step has no A-record value to print and skips
 * the check entirely: the beginner is given nothing to type, and finds out at
 * certificate issuance.
 *
 * Best effort, and only ever additive. A re-probe that fails, or that still
 * cannot name an address (curl works now, but this host has no metadata
 * service and sits behind NAT), leaves the surveyed facts exactly as they were,
 * so the run degrades to the same copy it showed before rather than to a worse
 * one.
 */
async function refreshPublicAddress(
  deps: CommandDeps,
  session: SelfhostSession,
  facts: RemoteInstallFacts,
): Promise<void> {
  // Named, because it is a second round trip: billed to the curl bootstrap's
  // line it would read as a package install that inexplicably got slower.
  session.progress.write("reading the server's public address");

  let refreshed;
  try {
    refreshed = await probeRemotePublicAddress({
      identityFile: session.identityFile,
      runProcess: deps.runProcess,
      sshTarget: session.sshTarget,
    });
  } catch {
    return;
  }

  facts.publicIp = refreshed.publicIp ?? facts.publicIp;
}

/** The address part of `user@host`, which is what the port probe connects to. */
export function hostOf(sshTarget: string): string {
  return sshTarget.slice(sshTarget.lastIndexOf("@") + 1);
}

// ---------------------------------------------------------------------------
// Docker bootstrap
// ---------------------------------------------------------------------------

async function ensureDocker(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  facts: RemoteInstallFacts,
): Promise<void> {
  if (facts.dockerState === "ok" && facts.dockerComposeVersion !== null) {
    return;
  }

  if (facts.dockerState === "denied") {
    throw new UsageError(
      [
        `Docker is installed on ${session.sshTarget}, but ${sshUser(session.sshTarget)} is not allowed to use it.`,
        "",
        "Add the account to the docker group on the server, then run this again:",
        `  sudo usermod -aG docker ${sshUser(session.sshTarget)}`,
      ].join("\n"),
    );
  }

  if (facts.dockerState === "down") {
    throw new UsageError(
      `Docker is installed on ${session.sshTarget} but its service is not running. Start it (\`sudo systemctl start docker\`) and run this again.`,
    );
  }

  if (facts.dockerState === "ok") {
    // Docker without Compose v2: get.docker.com installs the plugin, so the
    // same bootstrap is the fix.
    session.progress.warn(
      "Docker is installed but Docker Compose v2 is missing.",
    );
  }

  const bootstrap = dockerBootstrapFor(facts);
  if (bootstrap === null) {
    throw new UsageError(
      [
        `${facts.osPretty ?? facts.osId} is not one of the distributions the Docker install script supports, so this command cannot set Docker up for you.`,
        ...(facts.osId === "amzn"
          ? [
              "(This command can install Docker on Amazon Linux 2023; this server runs an older Amazon Linux.)",
            ]
          : []),
        "",
        "Install Docker Engine and the Compose v2 plugin on the server yourself, then run this again:",
        "  https://docs.docker.com/engine/install/",
      ].join("\n"),
    );
  }

  if (!(await confirmDockerBootstrap(deps, session, parsed, bootstrap.kind))) {
    throw new DeclinedError(
      [
        `${PRODUCT_NAME} runs in Docker, so the server needs it before anything can be installed.`,
        "",
        "Install Docker on the server yourself and run this again:",
        "  https://docs.docker.com/engine/install/",
      ].join("\n"),
    );
  }

  session.progress.write("installing Docker on the server");
  const result = await captureRemoteShell({
    body: bootstrap.script,
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });

  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      renderDockerBootstrapFailure(session, result.output),
    );
  }

  // A separate connection on purpose. A non-root account was just added to the
  // `docker` group, and group membership is resolved at login — this call is
  // the first login that has it, which is exactly why no connection is held
  // open across the bootstrap.
  session.progress.write("checking that Docker works");
  const verify = await captureRemoteShell({
    body: [
      "docker info >/dev/null",
      "docker compose version >/dev/null",
      // The amzn bootstrap installed buildx itself, so it is verified too —
      // install.sh's image build is what needs it.
      ...(bootstrap.kind === "amazon-linux"
        ? ["docker buildx version >/dev/null"]
        : []),
      'printf "docker_ready=1\\n"',
    ].join("\n"),
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });

  if (!verify.output.includes("docker_ready=1")) {
    // The bootstrap output rides along: when the freshly installed Docker does
    // not answer, whatever the install itself printed is the best lead.
    const bootstrapOutput = result.output.trim();
    throw new RemoteScriptFailure(
      [
        `Docker was installed on ${session.sshTarget}, but it still does not answer.`,
        "",
        verify.output.trim(),
        ...(bootstrapOutput === ""
          ? []
          : ["", "The Docker install itself reported:", "", bootstrapOutput]),
      ].join("\n"),
    );
  }
}

const DOCKER_BOOTSTRAP_SCRIPT = [
  'if [ "$(id -u)" = 0 ]; then',
  '  sudo_prefix=""',
  "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then",
  // -n throughout: this runs over a non-interactive `bash -s` with no TTY, so
  // a sudo that wants a password would hang rather than ask.
  '  sudo_prefix="sudo -n"',
  "else",
  '  printf "bootstrap_error=no-sudo\\n"',
  "  exit 3",
  "fi",
  "command -v curl >/dev/null 2>&1 || { printf \"bootstrap_error=no-curl\\n\"; exit 3; }",
  'script="$(mktemp)"',
  'trap \'rm -f "$script"\' EXIT',
  // Guarded like the Amazon Linux steps below: without the guards a failed
  // download or an upstream rejection would fall through to the trailing
  // `|| true` and exit 0, and the follow-up verification would then blame
  // Docker for "not answering" instead of showing the real error.
  'curl -fsSL https://get.docker.com -o "$script" || { printf "bootstrap_error=script-download\\n"; exit 3; }',
  '$sudo_prefix sh "$script" || { printf "bootstrap_error=script-run\\n"; exit 3; }',
  'if [ "$(id -u)" != 0 ]; then',
  // The account keeps using docker without sudo from the next login onwards.
  '  $sudo_prefix usermod -aG docker "$(id -un)"',
  "fi",
  "if command -v systemctl >/dev/null 2>&1; then",
  "  $sudo_prefix systemctl enable --now docker >/dev/null 2>&1 || true",
  "fi",
].join("\n");

type DockerBootstrap = {
  kind: "amazon-linux" | "get-docker";
  script: string;
};

/**
 * Which generated bootstrap fits this host, or null when none does.
 *
 * Amazon Linux 2023 gets its own branch: `get.docker.com` hard-rejects
 * `ID=amzn`, so the engine comes from Amazon's own package and the two CLI
 * plugins from their pinned GitHub releases. Amazon Linux 2 shares the same
 * `ID` (with `VERSION_ID=2`) but not the packages, so it keeps the docs-link
 * rejection — as does an `amzn` host whose version the probe could not read.
 */
function dockerBootstrapFor(facts: RemoteInstallFacts): DockerBootstrap | null {
  if (facts.osId === "amzn") {
    return facts.osVersionId === "2023"
      ? { kind: "amazon-linux", script: AMAZON_LINUX_BOOTSTRAP_SCRIPT }
      : null;
  }

  // An unreadable os-release keeps today's behavior: try get.docker.com, which
  // names its own supported list if the host turns out unsupported.
  if (facts.osId === null || DOCKER_BOOTSTRAP_DISTROS.has(facts.osId)) {
    return { kind: "get-docker", script: DOCKER_BOOTSTRAP_SCRIPT };
  }

  return null;
}

/**
 * The Amazon Linux 2023 bootstrap. Engine from `dnf` (the AWS-sanctioned
 * path); Compose v2 and buildx as pinned plugin binaries, because AL2023
 * packages neither usably — see the version constants above.
 *
 * Rerunning it is safe: `dnf install` of an installed package is a no-op and
 * the plugin installs overwrite, which is what lets a host that has Docker but
 * no Compose take this same branch.
 */
const AMAZON_LINUX_BOOTSTRAP_SCRIPT = [
  'if [ "$(id -u)" = 0 ]; then',
  '  sudo_prefix=""',
  "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then",
  // -n throughout, as in the get.docker.com script: no TTY, so a sudo that
  // wants a password would hang rather than ask.
  '  sudo_prefix="sudo -n"',
  "else",
  '  printf "bootstrap_error=no-sudo\\n"',
  "  exit 3",
  "fi",
  "command -v curl >/dev/null 2>&1 || { printf \"bootstrap_error=no-curl\\n\"; exit 3; }",
  // Compose names its Linux binaries by `uname -m`; buildx by the Go arch.
  'case "$(uname -m)" in',
  "  x86_64) buildx_arch=amd64 ;;",
  "  aarch64) buildx_arch=arm64 ;;",
  '  *) printf "bootstrap_error=unsupported-arch\\n"; exit 3 ;;',
  "esac",
  // Retried: on a freshly booted instance the SSM agent's auto-update can
  // hold the dnf lock for a while (amazon-linux-2023#397).
  "tries=0",
  'until dnf_output="$($sudo_prefix dnf install -y docker 2>&1)"; do',
  "  tries=$((tries + 1))",
  '  if [ "$tries" -ge 3 ]; then',
  '    printf "%s\\n" "$dnf_output"',
  '    printf "bootstrap_error=dnf-install\\n"',
  "    exit 3",
  "  fi",
  "  sleep 10",
  "done",
  '$sudo_prefix systemctl enable --now docker || { printf "bootstrap_error=docker-service\\n"; exit 3; }',
  'if [ "$(id -u)" != 0 ]; then',
  // The account keeps using docker without sudo from the next login onwards.
  '  $sudo_prefix usermod -aG docker "$(id -un)"',
  "fi",
  'workdir="$(mktemp -d)"',
  "trap 'rm -rf \"$workdir\"' EXIT",
  'compose_file="docker-compose-linux-$(uname -m)"',
  'compose_url="https://github.com/docker/compose/releases/download/__COMPOSE_VERSION__/${compose_file}"',
  'curl -fsSL "$compose_url" -o "$workdir/$compose_file" || { printf "bootstrap_error=compose-download\\n"; exit 3; }',
  // Each compose release publishes a per-binary checksum beside the binary.
  'curl -fsSL "${compose_url}.sha256" -o "$workdir/compose.sha256" || { printf "bootstrap_error=compose-download\\n"; exit 3; }',
  '(cd "$workdir" && sha256sum -c compose.sha256 >/dev/null 2>&1) || { printf "bootstrap_error=compose-checksum\\n"; exit 3; }',
  'buildx_file="buildx-__BUILDX_VERSION__.linux-${buildx_arch}"',
  'buildx_url="https://github.com/docker/buildx/releases/download/__BUILDX_VERSION__/${buildx_file}"',
  'curl -fsSL "$buildx_url" -o "$workdir/$buildx_file" || { printf "bootstrap_error=buildx-download\\n"; exit 3; }',
  // buildx publishes one checksums.txt per release; take our binary's line.
  'curl -fsSL "https://github.com/docker/buildx/releases/download/__BUILDX_VERSION__/checksums.txt" -o "$workdir/buildx-checksums.txt" || { printf "bootstrap_error=buildx-download\\n"; exit 3; }',
  '(cd "$workdir" && grep " [*]${buildx_file}$" buildx-checksums.txt | sha256sum -c - >/dev/null 2>&1) || { printf "bootstrap_error=buildx-checksum\\n"; exit 3; }',
  '$sudo_prefix install -D -m 0755 "$workdir/$compose_file" /usr/local/lib/docker/cli-plugins/docker-compose || { printf "bootstrap_error=plugin-install\\n"; exit 3; }',
  '$sudo_prefix install -D -m 0755 "$workdir/$buildx_file" /usr/local/lib/docker/cli-plugins/docker-buildx || { printf "bootstrap_error=plugin-install\\n"; exit 3; }',
]
  .join("\n")
  .replaceAll("__COMPOSE_VERSION__", AMAZON_LINUX_COMPOSE_VERSION)
  .replaceAll("__BUILDX_VERSION__", AMAZON_LINUX_BUILDX_VERSION);

function renderDockerBootstrapFailure(
  session: SelfhostSession,
  output: string,
): string {
  if (output.includes("bootstrap_error=no-sudo")) {
    return [
      `${sshUser(session.sshTarget)} on ${session.sshTarget} cannot run administrator commands without typing a password, so Docker cannot be installed from here.`,
      "",
      "Install Docker on the server yourself and run this again:",
      "  https://docs.docker.com/engine/install/",
    ].join("\n");
  }

  if (output.includes("bootstrap_error=no-curl")) {
    // A backstop only: the curl bootstrap runs before this. Neutral on the
    // package manager, because `apt` advice on the dnf distros sent users
    // astray.
    return `${session.sshTarget} has no curl, which the Docker install script needs. Install curl on the server (for example \`sudo apt install curl\` or \`sudo dnf install curl\`) and run this again.`;
  }

  if (output.includes("bootstrap_error=script-download")) {
    return `Downloading the Docker install script from get.docker.com failed on ${session.sshTarget}. Check that the server can reach get.docker.com and run this again.`;
  }

  if (output.includes("bootstrap_error=script-run")) {
    return [
      `The Docker install script from get.docker.com failed on ${session.sshTarget}.`,
      "",
      output.replace(/^bootstrap_error=.*$/mu, "").trim(),
    ].join("\n");
  }

  if (output.includes("bootstrap_error=unsupported-arch")) {
    return [
      `${session.sshTarget} has a processor type this command cannot download Docker plugins for (only x86_64 and aarch64 are covered).`,
      "",
      "Install Docker Engine with the Compose and buildx plugins on the server yourself, then run this again:",
      "  https://docs.docker.com/engine/install/",
    ].join("\n");
  }

  if (output.includes("bootstrap_error=dnf-install")) {
    return [
      `Installing the Docker package on ${session.sshTarget} failed, even after retrying. Another update may have been holding the package system busy — wait a minute and run this again.`,
      "",
      output.replace(/^bootstrap_error=.*$/mu, "").trim(),
    ].join("\n");
  }

  if (output.includes("bootstrap_error=docker-service")) {
    return `Docker was installed on ${session.sshTarget}, but its service could not be started. Check \`sudo systemctl status docker\` on the server and run this again.`;
  }

  const plugin = output.includes("bootstrap_error=compose-")
    ? "Compose"
    : output.includes("bootstrap_error=buildx-")
      ? "buildx"
      : null;
  if (plugin !== null && output.includes("-download")) {
    return `Downloading the Docker ${plugin} plugin from GitHub failed on ${session.sshTarget}. Check that the server can reach github.com and run this again.`;
  }
  if (plugin !== null && output.includes("-checksum")) {
    return `The downloaded Docker ${plugin} plugin did not match its published checksum, so it was not installed. Run this again; if it keeps happening, something between the server and GitHub is corrupting downloads.`;
  }

  if (output.includes("bootstrap_error=plugin-install")) {
    return [
      `Could not place the Docker plugins on ${session.sshTarget}.`,
      "",
      output.replace(/^bootstrap_error=.*$/mu, "").trim(),
    ].join("\n");
  }

  return [
    `Installing Docker on ${session.sshTarget} failed.`,
    "",
    output.trim(),
  ].join("\n");
}

async function confirmDockerBootstrap(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  kind: DockerBootstrap["kind"],
): Promise<boolean> {
  if (readBooleanFlag(parsed, "--install-docker")) {
    return true;
  }

  if (!canAsk(deps, parsed)) {
    // Consent-gated, so a scripted run must say so rather than have the CLI
    // decide to modify a host on its own.
    throw new UsageError(
      `${session.sshTarget} has no Docker installed. Pass --install-docker to let this command install it, or install Docker on the server first.`,
    );
  }

  session.progress.settle();
  notice(
    deps,
    `${session.sshTarget} does not have Docker yet. ${PRODUCT_NAME} runs in containers, so it is needed before anything else.`,
  );
  if (kind === "amazon-linux") {
    // Named because it differs from what "install Docker" usually means:
    // Amazon's package covers the engine only, and the two plugins come from
    // their own releases.
    notice(
      deps,
      "Docker will come from Amazon Linux's own Docker package, plus two Docker command plugins (compose and buildx) that Amazon Linux does not include.",
    );
  }

  return (
    (await deps.confirm?.({
      initial: true,
      message: "Install Docker on the server now?",
    })) ?? false
  );
}

function sshUser(sshTarget: string): string {
  return sshTarget.includes("@")
    ? sshTarget.slice(0, sshTarget.lastIndexOf("@"))
    : "this account";
}

// ---------------------------------------------------------------------------
// Base-package bootstrap (curl, git)
// ---------------------------------------------------------------------------

/**
 * A tool the install cannot run without, and that a minimal cloud image may
 * not ship. Both are base packages on every distribution — unlike Docker,
 * which needs a vendor repository and so needs a distro allowlist — so the
 * bootstrap asks the host which package manager it has rather than this side
 * guessing from os-release.
 */
type HostPackage = {
  /** The binary the probe looks for and the bootstrap verifies. */
  command: string;
  /** The consent flag that stands in for an interactive yes. */
  flag: "--install-curl" | "--install-git";
  /** Why the install needs it, as a clause the copy completes in three places. */
  need: string;
};

/**
 * Wanted well before `install.sh`'s own `require_command_selfhost curl`: both
 * Docker bootstraps download with curl, and a Debian netinst image ships
 * without it.
 */
const CURL_PACKAGE: HostPackage = {
  command: "curl",
  flag: "--install-curl",
  need: "The installer downloads with curl, Docker's own install scripts included",
};

/**
 * The checkout is a `git clone` — from GitHub, or from a bundled snapshot —
 * and `selfhost upgrade` fast-forwards that same checkout, so unpacking a
 * tarball is not a substitute.
 */
const GIT_PACKAGE: HostPackage = {
  command: "git",
  flag: "--install-git",
  need: "The server source is downloaded and kept up to date with git",
};

/** The same offer-and-consent shape as `ensureDocker`, for a base package. */
async function ensurePackage(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  pkg: HostPackage,
): Promise<void> {
  if (!(await confirmPackageBootstrap(deps, session, parsed, pkg))) {
    throw new DeclinedError(
      [
        `${pkg.need}, so ${session.sshTarget} needs ${pkg.command} before anything can be installed.`,
        "",
        `Install ${pkg.command} on the server yourself and run this again.`,
      ].join("\n"),
    );
  }

  session.progress.write(`installing ${pkg.command} on the server`);
  const result = await captureRemoteShell({
    body: packageBootstrapScript(pkg.command),
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });

  if (
    result.exitCode !== 0 ||
    !result.output.includes(`${pkg.command}_ready=1`)
  ) {
    throw new RemoteScriptFailure(
      renderPackageBootstrapFailure(session, pkg, result.output),
    );
  }
}

function packageBootstrapScript(pkg: string): string {
  return [
    'if [ "$(id -u)" = 0 ]; then',
    '  sudo_prefix=""',
    "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then",
    // -n throughout, as in the Docker bootstraps: no TTY, so a sudo that wants
    // a password would hang rather than ask.
    '  sudo_prefix="sudo -n"',
    "else",
    '  printf "bootstrap_error=no-sudo\\n"',
    "  exit 3",
    "fi",
    "if command -v dnf >/dev/null 2>&1; then",
    // Retried like the Docker package: on a freshly booted instance the SSM
    // agent's auto-update can hold the dnf lock for a while
    // (amazon-linux-2023#397).
    //
    // A plain install, deliberately not `--allowerasing`: on Amazon Linux 2023
    // `curl` conflicts with the preinstalled `curl-minimal`, but that package
    // already provides /usr/bin/curl, so this branch is only ever reached on a
    // host where neither is present and nothing needs erasing.
    "  tries=0",
    `  until dnf_output="$($sudo_prefix dnf install -y ${pkg} 2>&1)"; do`,
    "    tries=$((tries + 1))",
    '    if [ "$tries" -ge 3 ]; then',
    '      printf "%s\\n" "$dnf_output"',
    '      printf "bootstrap_error=package-install\\n"',
    "      exit 3",
    "    fi",
    "    sleep 10",
    "  done",
    "elif command -v apt-get >/dev/null 2>&1; then",
    // Refreshing is best-effort. apt exits non-zero when *any* index fails to
    // download — one dead third-party source on a long-lived host is enough —
    // while the install from the cached lists still succeeds. Only the install
    // itself decides, so a stale unrelated repo cannot block the wizard.
    '  $sudo_prefix env DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null 2>&1 || true',
    `  $sudo_prefix env DEBIAN_FRONTEND=noninteractive apt-get install -y -q ${pkg} || { printf "bootstrap_error=package-install\\n"; exit 3; }`,
    "elif command -v yum >/dev/null 2>&1; then",
    `  $sudo_prefix yum install -y ${pkg} || { printf "bootstrap_error=package-install\\n"; exit 3; }`,
    "elif command -v zypper >/dev/null 2>&1; then",
    // Never `|| exit`: zypper documents informational *successes* above zero —
    // 102 (reboot needed) and 103 (zypper itself was updated, restart needed) —
    // and treating those as failures would abort over a package that installed
    // fine. The verification below is what decides on this branch.
    `  $sudo_prefix zypper --non-interactive install ${pkg} || true`,
    "else",
    '  printf "bootstrap_error=no-package-manager\\n"',
    "  exit 3",
    "fi",
    // Verified in the same connection: unlike Docker there is no group
    // membership to pick up at the next login. This is also the only arbiter
    // for the branches above that deliberately swallow an exit code.
    `command -v ${pkg} >/dev/null 2>&1 || { printf "bootstrap_error=package-install\\n"; exit 3; }`,
    `printf "${pkg}_ready=1\\n"`,
  ].join("\n");
}

function renderPackageBootstrapFailure(
  session: SelfhostSession,
  pkg: HostPackage,
  output: string,
): string {
  const doItYourself = `Install ${pkg.command} on the server yourself and run this again.`;

  if (output.includes("bootstrap_error=no-sudo")) {
    return [
      `${sshUser(session.sshTarget)} on ${session.sshTarget} cannot run administrator commands without typing a password, so ${pkg.command} cannot be installed from here.`,
      "",
      doItYourself,
    ].join("\n");
  }

  if (output.includes("bootstrap_error=no-package-manager")) {
    return [
      `${session.sshTarget} has none of the package managers this command knows (dnf, apt-get, yum, zypper), so it cannot install ${pkg.command} for you.`,
      "",
      doItYourself,
    ].join("\n");
  }

  return [
    `Installing ${pkg.command} on ${session.sshTarget} failed.`,
    "",
    output.replace(/^bootstrap_error=.*$/mu, "").trim(),
  ].join("\n");
}

async function confirmPackageBootstrap(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  pkg: HostPackage,
): Promise<boolean> {
  if (readBooleanFlag(parsed, pkg.flag)) {
    return true;
  }

  if (!canAsk(deps, parsed)) {
    // Consent-gated, so a scripted run must say so rather than have the CLI
    // decide to modify a host on its own.
    throw new UsageError(
      `${session.sshTarget} has no ${pkg.command} installed. Pass ${pkg.flag} to let this command install it, or install ${pkg.command} on the server first.`,
    );
  }

  session.progress.settle();
  notice(
    deps,
    `${session.sshTarget} does not have ${pkg.command} yet. ${pkg.need}, so it is needed before the install. It will come from the server's own package manager.`,
  );

  return (
    (await deps.confirm?.({
      initial: true,
      message: `Install ${pkg.command} on the server now?`,
    })) ?? false
  );
}

// ---------------------------------------------------------------------------
// The checkout
// ---------------------------------------------------------------------------

/**
 * The internal-testing escape hatch: when a git bundle rides along with the
 * build (`dist/source.bundle`, placed there only by
 * `scripts/dev/pack-internal-test-cli.sh`) or is named by
 * `CMPATCH_SOURCE_BUNDLE`, the checkout is cloned from that bundle instead of
 * from GitHub — so a build of source that has not been exported to the public
 * repo yet can still be installed, without the server needing any GitHub
 * credentials. Published builds can never carry the file: `npm publish`
 * regenerates dist/ from scratch (scripts/build.mjs deletes it first), and
 * prepublishOnly refuses a tree where one survived anyway.
 */
export function sourceBundlePath(deps: Pick<CommandDeps, "env">): string | null {
  const named = deps.env.CMPATCH_SOURCE_BUNDLE;
  if (named !== undefined && named !== "") {
    return named;
  }

  const packaged = join(__dirname, "source.bundle");
  return existsSync(packaged) ? packaged : null;
}

async function uploadSourceBundle(
  deps: CommandDeps,
  session: SelfhostSession,
  localPath: string,
): Promise<string> {
  try {
    await stat(localPath);
  } catch {
    throw new UsageError(`the source bundle ${localPath} does not exist.`);
  }

  session.progress.write("uploading the bundled server source");
  const staging = await captureRemoteShell({
    body: 'mktemp -d "${TMPDIR:-/tmp}/cmpatch-source.XXXXXX"',
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });

  const stagingRoot = staging.output.trim().split("\n").pop()?.trim() ?? "";
  if (staging.exitCode !== 0 || !isAbsolute(stagingRoot)) {
    throw new RemoteScriptFailure(
      `could not create a staging directory on ${session.sshTarget}.`,
    );
  }

  const remoteBundle = `${stagingRoot}/source.bundle`;
  const copied = await deps.runProcess({
    args: assembleScpArgs(
      pairedSshInvocation(session.sshTarget, session.identityFile),
      [localPath, formatScpRemotePath(session.sshTarget, remoteBundle)],
    ),
    command: "scp",
    onOutput: (chunk) => session.progress.detail(chunk.trim()),
  });

  if (copied.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `could not upload ${localPath} to ${session.sshTarget} (scp exited with status ${String(
        copied.exitCode ?? 1,
      )}).`,
    );
  }

  return remoteBundle;
}

export async function ensureCheckout(
  deps: CommandDeps,
  session: SelfhostSession,
): Promise<void> {
  if (session.facts.checkoutPath !== null) {
    return;
  }

  const bundle = sourceBundlePath(deps);
  let remoteBundle: string | null = null;
  if (bundle !== null) {
    session.progress.settle();
    notice(
      deps,
      "This is an internal test build that carries its own source snapshot, so the server source comes from it instead of GitHub.",
    );
    remoteBundle = await uploadSourceBundle(deps, session, bundle);
  }

  session.progress.write("downloading the server source");
  const result = await captureRemoteShell({
    body: [
      "command -v git >/dev/null 2>&1 || { printf \"clone_error=no-git\\n\"; exit 3; }",
      'if [ -e "$CMPATCH_REMOTE_PATH" ]; then printf "clone_error=exists\\n"; exit 3; fi',
      // A full clone, not --depth 1: `selfhost upgrade` fast-forwards this
      // same checkout, and a shallow one turns that into a special case.
      ...(remoteBundle === null
        ? ['git clone --quiet "$CMPATCH_REPO_URL" "$CMPATCH_REMOTE_PATH"']
        : [
            'git clone --quiet "$CMPATCH_SOURCE_BUNDLE" "$CMPATCH_REMOTE_PATH"',
            // Aimed back at the public repo so the checkout is
            // indistinguishable from a normal clone: `selfhost upgrade`'s
            // remote check and fast-forward behave exactly as they will once
            // the snapshot's commits are exported for real.
            'git -C "$CMPATCH_REMOTE_PATH" remote set-url origin "$CMPATCH_REPO_URL"',
            'rm -rf -- "$(dirname "$CMPATCH_SOURCE_BUNDLE")"',
          ]),
      'printf "checkout=%s\\n" "$(cd "$CMPATCH_REMOTE_PATH" && pwd -P)"',
    ].join("\n"),
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    env: {
      CMPATCH_REMOTE_PATH: session.remotePath,
      CMPATCH_REPO_URL: SOURCE_REPO_URL,
      ...(remoteBundle === null
        ? {}
        : { CMPATCH_SOURCE_BUNDLE: remoteBundle }),
    },
    runProcess: deps.runProcess,
  });

  const cloned = /^checkout=(.+)$/mu.exec(result.output)?.[1]?.trim();
  if (result.exitCode !== 0 || cloned === undefined) {
    throw new RemoteScriptFailure(
      result.output.includes("clone_error=no-git")
        // A backstop only: ensureGit ran before this. Neutral on the package
        // manager, because `apt` advice on the dnf distros sent users astray.
        ? `${session.sshTarget} has no git, which is needed to download the server source. Install it on the server (for example \`sudo apt install git\` or \`sudo dnf install git\`) and run this again.`
        : [
            `Could not download the server source to ${session.remotePath} on ${session.sshTarget}.`,
            "",
            result.output.trim(),
          ].join("\n"),
    );
  }

  // The canonical path from the host itself: everything downstream — the
  // script path, the pairing record — must be absolute and real.
  session.facts.checkoutPath = cloned;
  session.remotePath = cloned;
}

// ---------------------------------------------------------------------------
// Start over
// ---------------------------------------------------------------------------

export async function startOver(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  interactive: boolean,
): Promise<void> {
  // Only `--discard-data` stands in for the typed word, never `--yes`. `--yes`
  // is the generic "skip the confirmations" flag a user adds to any command
  // without a thought about what the confirmations guard; on install it skips
  // the non-destructive ones (the Cloudflare rule check). `--discard-data` is
  // the flag that says out loud what is lost, and it is what the flags-only
  // path already demands next to `--start-over` (readRequestedEdge).
  if (interactive && !readBooleanFlag(parsed, "--discard-data")) {
    session.progress.settle();
    notice(
      deps,
      "Starting over deletes this server's database and every release file it holds. This cannot be undone.",
    );

    // A typed word rather than [y/N] — the same gate `restore` uses, and for
    // the same reason: this is the only edge in the wizard that destroys data.
    const typed = await askValue(deps, {
      message: 'Type "delete" to continue',
      type: "text",
    });
    if (typed.toLowerCase() !== "delete") {
      throw new DeclinedError("Install cancelled.");
    }
  }

  session.progress.write("removing the previous attempt");
  const result = await captureRemoteShell({
    body: [
      'cd "$CMPATCH_REMOTE_PATH"',
      // Asserted before anything is removed. Without it a Docker this login
      // cannot reach would leave every container and volume in place while the
      // env file went away — and the next install would then write fresh
      // credentials against the old database volume.
      "docker info >/dev/null",
      // Sourced only for the two names below; the file defines functions and
      // sets variables, and runs nothing.
      '. "$CMPATCH_REMOTE_PATH/scripts/selfhost/common.sh"',
      // Removed by compose project label rather than through `compose down`:
      // the env file of a half-finished install can fail the stack-shape
      // validation compose_selfhost runs first, and then nothing would be
      // cleaned up at all.
      'containers="$(docker ps -aq --filter "label=com.docker.compose.project=${SELFHOST_PROJECT_NAME}" 2>/dev/null || true)"',
      'if [ -n "$containers" ]; then docker rm -f $containers >/dev/null; fi',
      'volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=${SELFHOST_PROJECT_NAME}" 2>/dev/null || true)"',
      'if [ -n "$volumes" ]; then docker volume rm -f $volumes >/dev/null; fi',
      'rm -f "$SELFHOST_ENV_FILE"',
      'printf "started_over=1\\n"',
    ].join("\n"),
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    env: { CMPATCH_REMOTE_PATH: session.remotePath },
    runProcess: deps.runProcess,
  });

  if (!result.output.includes("started_over=1")) {
    throw new RemoteScriptFailure(
      [
        `Could not remove the previous attempt on ${session.sshTarget}.`,
        "",
        result.output.trim(),
      ].join("\n"),
    );
  }

  session.facts.envFilePresent = false;
}
