/**
 * What the CLI needs to know about a paired host, and how it learns it.
 *
 * Everything here is **one round trip**. Dropping ssh multiplexing traded a
 * ~0.5–1 s handshake per call for one code path on every platform, and the
 * compensating design is that the chatty sequences are batched into a single
 * generated script instead of being spread over many connections.
 */

import {
  captureRemoteShell,
  pairedSshInvocation,
  type RunProcess,
} from "./remoteExec";

/** The default checkout the documented ssh one-liner produces. */
export const DEFAULT_REMOTE_CHECKOUT = "codemagic-patch";

/** Where the CLI keeps every backup it is responsible for, under the remote home. */
export const REMOTE_BACKUP_DIRECTORY = "codemagic-patch-backups";

/**
 * Which cloud a host is on, as far as the probe can tell.
 *
 * Used for one thing only: translating "open ports 80 and 443" into the words
 * that provider's console actually uses (Security Group, VPC firewall rule,
 * Cloud Firewall). A wrong guess costs a slightly-off hint, never a failure,
 * which is why DMI strings are enough and no metadata round trip is required
 * to reach an answer.
 */
export type CloudProvider =
  | "aws"
  | "azure"
  | "digitalocean"
  | "gcp"
  | "hetzner"
  | "other";

/** How usable Docker is on the host, which is what selects the bootstrap edge. */
export type DockerState =
  /** No `docker` binary. */
  | "absent"
  /** Installed, but this login cannot reach the daemon socket — the group fix. */
  | "denied"
  /** Installed and the daemon answers. */
  | "ok"
  /** Installed, daemon not running or otherwise unreachable. */
  | "down";

/**
 * The extra facts `selfhost install` needs, collected in the *same* round trip
 * as the base facts. Absent for the maintenance commands, whose probe must not
 * pay for a metadata-service timeout or the health curls — up to two 8-second
 * ones on the fallback path — they have no use for.
 */
export type RemoteInstallFacts = {
  arch: string | null;
  cloudProvider: CloudProvider | null;
  /** `docker compose version --short`, or null when Compose v2 is missing. */
  dockerComposeVersion: string | null;
  dockerState: DockerState;
  /** `docker --version`, verbatim. */
  dockerVersion: string | null;
  /**
   * Whether `curl` is on the PATH. Needed by `install.sh` itself, by `smoke.sh`,
   * and — before either — by the Docker bootstraps, which download with it.
   */
  hasCurl: boolean;
  /** Whether `git` is on the PATH — the clone and every later upgrade need it. */
  hasGit: boolean;
  /**
   * Whether the deployment's own `SERVER_URL` answers `/health/ready`, asked
   * from the server itself. Null when there is no env file to read a URL
   * from. Readiness, not liveness — see `HEALTH_PROBE_SCRIPT` for why the
   * distinction decides install-state classification.
   *
   * Asked remotely rather than from here on purpose: the question is "is this
   * deployment up", and a check run from the user's laptop also answers "can
   * this laptop reach it", which is a different question with the same shape —
   * a corporate proxy or a captive network would classify a healthy server as
   * a broken install and offer to discard its volumes.
   */
  healthy: boolean | null;
  /** MemTotal, as reported by the kernel. Null when /proc/meminfo is unreadable. */
  memoryTotalBytes: number | null;
  osId: string | null;
  osPretty: string | null;
  /**
   * os-release `VERSION_ID`. The one distro decision it exists for: Amazon
   * Linux 2023 and Amazon Linux 2 share `ID=amzn`, and only the former has the
   * packages the dedicated Docker bootstrap installs.
   */
  osVersionId: string | null;
  /** The address DNS records must point at. Null when nothing could report one. */
  publicIp: string | null;
};

export type RemoteHostFacts = {
  /**
   * The CLI-managed backup root, as a canonical absolute path.
   *
   * Never `~/…`: env assignments are serialized single-quoted into the
   * generated script, and a quoted tilde does not expand — `backup.sh` would
   * create a literal `~` directory relative to the checkout while the CLI
   * displayed a home-relative path that does not exist. `~` survives only as
   * presentation shorthand, and only after the absolute path is known.
   */
  backupRoot: string;
  /**
   * Whether the checkout's own `backup.sh` understands `--directory`.
   *
   * The CLI names the exact output directory rather than letting the script
   * pick one, which is a flag every deployment installed before that flag
   * existed does not have: such a script reads `--directory` as the positional
   * backup root and dies inside `mkdir` with an unrecognised-option error.
   * Reading it here — from the round trip that already opens the checkout —
   * is what lets `backup` say "upgrade the server first" instead.
   *
   * Null when the question could not be asked at all (no checkout, or no
   * `backup.sh` in it). That is a broken-checkout case, not a skew case, and
   * it deliberately does not block: the script run reports it far better than
   * a skew message would.
   */
  backupScriptSupportsDirectory: boolean | null;
  /** Absolute path of the repo checkout, or null when there is none. */
  checkoutPath: string | null;
  /** `bundled` / `external`, read from the deployment's own env file. */
  databaseMode: string | null;
  /**
   * `base-url` / `cloudflare` / `cloudfront`. The delivery choice is
   * first-install-only, so this is what tells a resume it must not re-offer it.
   */
  deliveryAdapter: string | null;
  /** Whether `.env.selfhost` exists — the first half of install-state detection. */
  envFilePresent: boolean;
  home: string;
  /** Present only for a probe run with `scope: "install"`. */
  install?: RemoteInstallFacts;
  /**
   * `SERVER_URL` from the deployment's own env file. This is what lets a
   * command invoked with a bare `user@vps` still record its pairing under the
   * right URL — the re-pairing-from-a-second-machine path.
   */
  serverUrl: string | null;
  /**
   * `CODEMAGIC_PATCH_STORAGE_DOMAIN` from the deployment's own env file. The
   * resume and repair edges collect no answers, so this is the only way to
   * name the download domain in a CDN reminder afterwards.
   */
  storageDomain: string | null;
  /** `bundled` / `s3` / `gcs`. */
  storageMode: string | null;
};

export type RemoteProbeInput = {
  identityFile?: string;
  /** The checkout to look for; defaults to `<home>/codemagic-patch`. */
  remotePath?: string;
  runProcess: RunProcess;
  /**
   * `"install"` adds the host survey (OS, RAM, Docker, cloud, public IP, and
   * the deployment's health) to the same script. Defaults to `"maintenance"`,
   * which asks none of it.
   */
  scope?: "install" | "maintenance";
  sshTarget: string;
};

export class RemoteHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteHostError";
  }
}

/**
 * `key=value` lines, so an ssh banner or a warning the merged stream carried
 * along is ignored rather than corrupting the result.
 */
const PROBE_SCRIPT = [
  'home="$(cd "$HOME" && pwd -P)"',
  'printf "home=%s\\n" "$home"',
  'printf "backup_root=%s\\n" "${home}/__BACKUP_DIR__"',
  'server_url=""',
  'checkout="${CMPATCH_REMOTE_PATH:-${home}/__CHECKOUT__}"',
  'if [ -d "$checkout" ]; then',
  '  checkout="$(cd "$checkout" && pwd -P)"',
  '  printf "checkout=%s\\n" "$checkout"',
  // The capability question, asked of the script's own option parser: the
  // `--directory)` case arm is the only thing that proves the flag is handled
  // rather than merely mentioned in a comment or a usage line.
  '  backup_script="${checkout}/scripts/selfhost/backup.sh"',
  // `-r`, not `-f`: a `backup.sh` this login cannot read makes grep answer "no
  // match" for a reason that has nothing to do with the flag, and reporting
  // that as flag=0 would advise an upgrade for a permissions problem. Unreadable
  // reports nothing instead, which is the honest "not asked" answer.
  '  if [ -r "$backup_script" ]; then',
  '    if grep -q -- "--directory)" "$backup_script" 2>/dev/null; then',
  '      printf "backup_directory_flag=1\\n"',
  "    else",
  '      printf "backup_directory_flag=0\\n"',
  "    fi",
  "  fi",
  '  env_file="${checkout}/.env.selfhost"',
  '  if [ -f "$env_file" ]; then',
  '    printf "env_present=1\\n"',
  '    printf "database_mode=%s\\n" "$(read_env_value SELFHOST_DATABASE_MODE)"',
  '    printf "storage_mode=%s\\n" "$(read_env_value SELFHOST_STORAGE_MODE)"',
  '    printf "delivery_adapter=%s\\n" "$(read_env_value DELIVERY_ADAPTER)"',
  '    printf "storage_domain=%s\\n" "$(read_env_value CODEMAGIC_PATCH_STORAGE_DOMAIN)"',
  '    server_url="$(read_env_value SERVER_URL)"',
  '    printf "server_url=%s\\n" "$server_url"',
  "  fi",
  "fi",
].join("\n");

/**
 * The deployment-health question, asked the way the deployment's own compose
 * healthcheck asks it: on the readiness path. `/health` is process liveness
 * and answers ok while the database is down — which is exactly what an
 * install interrupted after the API container came up leaves behind, and it
 * must not classify as a completed install (that classification clears the
 * pending-install record, the one piece of evidence that keeps the recovery
 * edges on offer). `/health/ready` is the DB-backed answer, so it is the one
 * asked first.
 *
 * Only a 2xx claims readiness directly. The liveness fallback covers the
 * answers that say "the ready endpoint did not really answer" without saying
 * the server is broken: 404 and 501 from a checkout that predates the
 * endpoint, and a 3xx — a redirect proves nothing about readiness (a proxy
 * 301 to a login page must not classify as installed), so it gets the same
 * pre-readiness behavior older checkouts get. Any other answer — the ready
 * check's own 503, a proxy error, a refused connection — reads as not
 * healthy, never as "ask the weaker question instead".
 *
 * Exported for its tests: the ok / fallback / fail split lives in shell, and
 * only running it under a real shell (against a scripted `curl`) proves it.
 */
export const HEALTH_PROBE_SCRIPT = [
  'if [ -n "$server_url" ]; then',
  '  ready_status="$(curl -sS -m 8 -o /dev/null -w "%{http_code}" "${server_url}/health/ready" 2>/dev/null || true)"',
  '  case "$ready_status" in',
  '    2*) printf "health=ok\\n" ;;',
  "    3*|404|501)",
  '      if curl -fsS -m 8 -o /dev/null "${server_url}/health" 2>/dev/null; then',
  '        printf "health=ok\\n"',
  "      else",
  '        printf "health=fail\\n"',
  "      fi",
  "      ;;",
  '    *) printf "health=fail\\n" ;;',
  "  esac",
  "fi",
].join("\n");

/**
 * The two facts the metadata services answer: which cloud the host is on, and
 * the address DNS records must point at.
 *
 * Split out of the survey because it is the one part of it that *needs* curl:
 * every other install fact is read from files or from `command -v`, so a host
 * that turned out to be missing curl loses only these two — and only until the
 * bootstrap installs it, after which asking again is a single round trip
 * instead of a repeat of the whole survey (whose health question already
 * decided the install state and must not be re-answered afterwards).
 *
 * The metadata calls are ordered by the DMI answer rather than tried in
 * sequence, so a host on no cloud at all pays one 1-second local timeout, not
 * five.
 *
 * Self-contained under `set -eu`: it declares the variables it uses and every
 * command in it tolerates failure, so it runs standalone or spliced into the
 * survey with the same result.
 *
 * Exported for its tests: the survey must carry this exact body, since the
 * whole point of the second ask is to answer what the first one could not.
 */
export const PUBLIC_ADDRESS_PROBE_SCRIPT = [
  'dmi="$(cat /sys/class/dmi/id/sys_vendor /sys/class/dmi/id/product_name 2>/dev/null | tr "\\n" " " || true)"',
  'metadata_ip=""',
  'case "$dmi" in',
  '  *Amazon*|*amazon*)',
  '    printf "cloud=aws\\n"',
  '    token="$(curl -s -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null || true)"',
  '    metadata_ip="$(curl -s -m 2 -H "X-aws-ec2-metadata-token: ${token}" "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || true)"',
  "    ;;",
  '  *Google*|*google*)',
  '    printf "cloud=gcp\\n"',
  '    metadata_ip="$(curl -s -m 2 -H "Metadata-Flavor: Google" "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" 2>/dev/null || true)"',
  "    ;;",
  '  *DigitalOcean*|*Droplet*)',
  '    printf "cloud=digitalocean\\n"',
  '    metadata_ip="$(curl -s -m 2 "http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address" 2>/dev/null || true)"',
  "    ;;",
  '  *Hetzner*)',
  '    printf "cloud=hetzner\\n"',
  '    metadata_ip="$(curl -s -m 2 "http://169.254.169.254/hetzner/v1/metadata/public-ipv4" 2>/dev/null || true)"',
  "    ;;",
  '  *Microsoft*)',
  '    printf "cloud=azure\\n"',
  '    metadata_ip="$(curl -s -m 2 -H "Metadata:true" "http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text" 2>/dev/null || true)"',
  "    ;;",
  '  *) printf "cloud=other\\n" ;;',
  "esac",
  // The fallback answers for every plain VPS, where the public address sits on
  // the interface itself and there is no metadata service to ask.
  'if [ -z "$metadata_ip" ]; then',
  '  metadata_ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n "s/.*src \\([0-9.]*\\).*/\\1/p" | head -n 1 || true)"',
  "fi",
  // A metadata service that answers with an HTML error page must not be
  // reported as an address.
  'case "$metadata_ip" in',
  '  *[!0-9.]*|"") ;;',
  '  *) printf "public_ip=%s\\n" "$metadata_ip" ;;',
  "esac",
].join("\n");

/**
 * The `scope: "install"` half of the same script.
 *
 * Every command here is failure-tolerant on purpose: the script runs under
 * `set -eu`, and a host without `/sys/class/dmi`, without `curl`, or with a
 * metadata service that black-holes the request must still report the facts it
 * *does* have. A missing field becomes null, which the caller renders as "not
 * detected" — an aborted probe would instead take down an install that had no
 * reason to fail.
 */
const INSTALL_PROBE_SCRIPT = [
  'printf "arch=%s\\n" "$(uname -m 2>/dev/null || true)"',
  "if [ -r /etc/os-release ]; then",
  // Subshelled: os-release assigns NAME/ID/VERSION, and this script has its own
  // `home`/`checkout` variables that must survive it.
  "  (",
  "    . /etc/os-release",
  '    printf "os_id=%s\\n" "${ID:-}"',
  '    printf "os_version=%s\\n" "${VERSION_ID:-}"',
  '    printf "os_pretty=%s\\n" "${PRETTY_NAME:-}"',
  "  )",
  "fi",
  'mem_kb="$(awk "/^MemTotal:/ {print \\$2}" /proc/meminfo 2>/dev/null || true)"',
  'printf "memory_kb=%s\\n" "${mem_kb:-}"',
  'docker_state=absent',
  "if command -v docker >/dev/null 2>&1; then",
  "  docker_state=down",
  '  printf "docker_version=%s\\n" "$(docker --version 2>/dev/null || true)"',
  '  printf "docker_compose_version=%s\\n" "$(docker compose version --short 2>/dev/null || true)"',
  "  if docker info >/dev/null 2>&1; then",
  "    docker_state=ok",
  // The group fix is a distinct edge from "the daemon is down", and only the
  // socket's own error tells them apart.
  '  elif docker info 2>&1 | grep -qi "permission denied"; then',
  "    docker_state=denied",
  "  fi",
  "fi",
  'printf "docker_state=%s\\n" "$docker_state"',
  'if command -v git >/dev/null 2>&1; then printf "git_present=1\\n"; else printf "git_present=0\\n"; fi',
  'if command -v curl >/dev/null 2>&1; then printf "curl_present=1\\n"; else printf "curl_present=0\\n"; fi',
  PUBLIC_ADDRESS_PROBE_SCRIPT,
  HEALTH_PROBE_SCRIPT,
].join("\n");

/**
 * The same dotenv reading rule `common.sh`'s own reader uses (optional
 * `export`, whitespace around `=`, single or double quotes). A value this
 * missed would silently read as the default mode, and the CLI would then
 * describe a backup as containing a component it does not.
 */
const READ_ENV_VALUE_FUNCTION = [
  "read_env_value() {",
  '  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$env_file" | tail -n 1 || true)"',
  '  value="${line#*=}"',
  '  value="${value#"${value%%[![:space:]]*}"}"',
  '  value="${value%"${value##*[![:space:]]}"}"',
  '  value="${value%\\"}"',
  '  value="${value#\\"}"',
  "  value=\"${value%\\'}\"",
  "  value=\"${value#\\'}\"",
  '  printf "%s" "$value"',
  "}",
].join("\n");

export async function probeRemoteHost(
  input: RemoteProbeInput,
): Promise<RemoteHostFacts> {
  const body = [
    READ_ENV_VALUE_FUNCTION,
    PROBE_SCRIPT.replaceAll("__BACKUP_DIR__", REMOTE_BACKUP_DIRECTORY).replaceAll(
      "__CHECKOUT__",
      DEFAULT_REMOTE_CHECKOUT,
    ),
    ...(input.scope === "install" ? [INSTALL_PROBE_SCRIPT] : []),
  ].join("\n");

  const result = await captureRemoteShell({
    body,
    connection: connectionFor(input),
    ...(input.remotePath !== undefined
      ? { env: { CMPATCH_REMOTE_PATH: input.remotePath } }
      : {}),
    runProcess: input.runProcess,
  });

  if (result.exitCode !== 0) {
    throw new RemoteHostError(
      `could not read the server at ${input.sshTarget} (ssh exited with status ${String(
        result.exitCode ?? 1,
      )}).`,
    );
  }

  const values = parseKeyValueOutput(result.output);
  const home = values.home;
  if (home === undefined) {
    throw new RemoteHostError(
      `${input.sshTarget} did not report its home directory; the connection may have been closed before the check finished.`,
    );
  }

  return {
    backupRoot: values.backup_root ?? `${home}/${REMOTE_BACKUP_DIRECTORY}`,
    backupScriptSupportsDirectory:
      values.backup_directory_flag === undefined
        ? null
        : values.backup_directory_flag === "1",
    checkoutPath: values.checkout ?? null,
    databaseMode: emptyToNull(values.database_mode),
    deliveryAdapter: emptyToNull(values.delivery_adapter),
    envFilePresent: values.env_present === "1",
    home,
    ...(input.scope === "install"
      ? { install: readInstallFacts(values) }
      : {}),
    serverUrl: emptyToNull(values.server_url),
    storageDomain: emptyToNull(values.storage_domain),
    storageMode: emptyToNull(values.storage_mode),
  };
}

/** The curl-dependent half of the survey, on its own. */
export type RemotePublicAddressFacts = Pick<
  RemoteInstallFacts,
  "cloudProvider" | "publicIp"
>;

/**
 * Re-asks what the metadata services answer, and nothing else.
 *
 * The survey is batched into the pairing round trip, which is before the
 * bootstraps that fix what it found missing — so a host without curl reports no
 * public address, and the DNS step would have no A-record value to print. This
 * is the second ask, after curl exists; the address is what is at stake, the
 * cloud coming free from the DMI strings either way.
 *
 * Deliberately not the whole survey a second time: the survey also asks the
 * deployment's health, and that answer already chose the install edge this run
 * is on. Re-answering it here would let a late reading contradict a decision
 * the user has already been walked through.
 */
export async function probeRemotePublicAddress(
  input: Pick<RemoteProbeInput, "identityFile" | "runProcess" | "sshTarget">,
): Promise<RemotePublicAddressFacts> {
  const result = await captureRemoteShell({
    body: PUBLIC_ADDRESS_PROBE_SCRIPT,
    connection: connectionFor(input),
    runProcess: input.runProcess,
  });

  if (result.exitCode !== 0) {
    throw new RemoteHostError(
      `could not read the public address of ${input.sshTarget} (ssh exited with status ${String(
        result.exitCode ?? 1,
      )}).`,
    );
  }

  return readPublicAddressFacts(parseKeyValueOutput(result.output));
}

const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  "aws",
  "azure",
  "digitalocean",
  "gcp",
  "hetzner",
  "other",
];

const DOCKER_STATES: readonly DockerState[] = ["absent", "denied", "down", "ok"];

/**
 * The half of the survey's parse that belongs to
 * `PUBLIC_ADDRESS_PROBE_SCRIPT`, shared with the second ask so the two cannot
 * read the same two keys differently.
 */
function readPublicAddressFacts(
  values: Record<string, string>,
): RemotePublicAddressFacts {
  const cloud = values.cloud as CloudProvider | undefined;

  return {
    cloudProvider:
      cloud !== undefined && CLOUD_PROVIDERS.includes(cloud) ? cloud : null,
    publicIp: publicOrNull(emptyToNull(values.public_ip)),
  };
}

function readInstallFacts(values: Record<string, string>): RemoteInstallFacts {
  const memoryKilobytes = Number.parseInt(values.memory_kb ?? "", 10);
  const dockerState = values.docker_state as DockerState | undefined;

  return {
    ...readPublicAddressFacts(values),
    arch: emptyToNull(values.arch),
    dockerComposeVersion: emptyToNull(values.docker_compose_version),
    // An unrecognised value is treated as "no Docker" rather than trusted:
    // every other branch would proceed to a build that cannot run.
    dockerState:
      dockerState !== undefined && DOCKER_STATES.includes(dockerState)
        ? dockerState
        : "absent",
    dockerVersion: emptyToNull(values.docker_version),
    // Like dockerState, a missing or garbled value reads as "absent": every
    // other branch would proceed to a download or a clone that cannot run.
    hasCurl: values.curl_present === "1",
    hasGit: values.git_present === "1",
    healthy: values.health === undefined ? null : values.health === "ok",
    memoryTotalBytes: Number.isNaN(memoryKilobytes)
      ? null
      : memoryKilobytes * 1024,
    osId: emptyToNull(values.os_id),
    osPretty: emptyToNull(values.os_pretty),
    osVersionId: emptyToNull(values.os_version),
  };
}

/**
 * The probe's fallback reads the outbound interface's own source address,
 * which on a NATted host (an unrecognised cloud with 1:1 NAT, a VM behind a
 * router) is a private one — an address no public DNS record can usefully
 * carry, and the DNS step would otherwise both print it as the value to add
 * and wait for it. Dropping it here lets the caller fall back to the address
 * the user actually reached the host by.
 */
function publicOrNull(address: string | null): string | null {
  if (address === null) {
    return null;
  }

  const octets = address.split(".").map((octet) => Number.parseInt(octet, 10));
  const [a, b] = octets;
  if (
    octets.length !== 4 ||
    a === undefined ||
    b === undefined ||
    octets.some((octet) => Number.isNaN(octet) || octet > 255)
  ) {
    return null;
  }

  const unroutable =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;

  return unroutable ? null : address;
}

export type RemoteBackup = {
  /**
   * The subdirectory of the backup root this backup sits in (`pre-upgrade`,
   * `pre-restore`), or null for a backup taken directly under the root. The
   * safety backups the scripts take land in these subdirectories with names a
   * user cannot tell apart, so the listing must say which family each entry
   * belongs to.
   */
  category: string | null;
  /** From the backup's own `versions.txt` — the point-in-time anchor. */
  createdAt: string | null;
  /** Absolute path on the server. */
  path: string;
  /** Directory name, which is what the user recognises in the listing. */
  name: string;
  sizeBytes: number | null;
};

/**
 * Lists the backups under the CLI-managed root, newest first.
 *
 * An explicit selection, never newest-directory guessing: the pre-upgrade and
 * safety backups land under the same root by design, so "the newest one" is
 * routinely not the one the user means.
 */
export async function listRemoteBackups(
  input: RemoteProbeInput & { backupRoot: string },
): Promise<RemoteBackup[]> {
  const result = await captureRemoteShell({
    body: [
      'if [ ! -d "$CMPATCH_BACKUP_ROOT" ]; then exit 0; fi',
      'for dir in "$CMPATCH_BACKUP_ROOT"/*/ "$CMPATCH_BACKUP_ROOT"/*/*/; do',
      '  [ -d "$dir" ] || continue',
      '  [ -f "${dir}env.selfhost" ] || continue',
      '  path="$(cd "$dir" && pwd -P)"',
      '  size="$(du -sk "$path" 2>/dev/null | cut -f1)"',
      '  created="$(grep -E "^created_at=" "${dir}versions.txt" 2>/dev/null | tail -n 1 || true)"',
      '  printf "backup\\t%s\\t%s\\t%s\\n" "$path" "${size:-}" "${created#created_at=}"',
      "done",
    ].join("\n"),
    connection: connectionFor(input),
    env: { CMPATCH_BACKUP_ROOT: input.backupRoot },
    runProcess: input.runProcess,
  });

  if (result.exitCode !== 0) {
    throw new RemoteHostError(
      `could not list backups on ${input.sshTarget} (ssh exited with status ${String(
        result.exitCode ?? 1,
      )}).`,
    );
  }

  const root = input.backupRoot.replace(/\/+$/u, "");
  const backups: RemoteBackup[] = [];
  for (const line of result.output.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] !== "backup" || fields[1] === undefined) {
      continue;
    }

    const path = fields[1];
    const relative = path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : null;
    const category =
      relative !== null && relative.includes("/")
        ? relative.slice(0, relative.lastIndexOf("/"))
        : null;
    const sizeKilobytes = Number.parseInt(fields[2] ?? "", 10);
    backups.push({
      category,
      createdAt: emptyToNull(fields[3]?.trim()),
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      sizeBytes: Number.isNaN(sizeKilobytes) ? null : sizeKilobytes * 1024,
    });
  }

  // Newest first, by when the backup was taken. A lexical path sort would NOT
  // be chronological here: the root deliberately mixes CLI backups
  // (`<root>/2026-…`) with the scripts' safety backups
  // (`<root>/pre-*/codemagic-patch-selfhost-…Z`), and comparing those paths
  // groups by directory family, putting every stale safety backup above every
  // CLI backup. The timestamps live in `created_at` (or, failing that, in the
  // directory name); reduced to digits the two naming schemes compare cleanly.
  return backups.sort(
    (left, right) =>
      chronologyKey(right).localeCompare(chronologyKey(left)) ||
      right.path.localeCompare(left.path),
  );
}

function chronologyKey(backup: RemoteBackup): string {
  return (backup.createdAt ?? backup.name).replaceAll(/\D/gu, "");
}

function connectionFor(
  input: Pick<RemoteProbeInput, "identityFile" | "sshTarget">,
) {
  return input.identityFile === undefined
    ? { batchMode: true, target: input.sshTarget }
    : pairedSshInvocation(input.sshTarget, input.identityFile);
}

function parseKeyValueOutput(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return values;
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}
