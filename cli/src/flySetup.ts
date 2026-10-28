/**
 * The pure half of the Fly commands: names, toml documents and parsers for
 * install, and flyctl's JSON, the backup manifest and the recipes for upgrade,
 * backup and restore. No prompting and no processes here.
 */

import { quoteShellValue } from "./remoteExec";
import { stripAnsi } from "./selfhostPairing";

export const TIGRIS_ENDPOINT = "https://t3.storage.dev";
export const FLY_INSTALL_SCRIPT = "https://fly.io/install.sh";
export const TIGRIS_INSTALL_SCRIPT = "https://get.t3.storage.dev/install.sh";

/** The flyctl the live exercise must run on. It has `fly ssh sftp put` and `fly machine clone --attach-volume`. */
export const FLYCTL_MIN_VERSION = "0.4.121";
/** The Tigris CLI the live exercise must run on. */
export const TIGRIS_MIN_VERSION = "3.17.1";

const TIGRIS_PUBLIC_HOST = "t3.tigrisfiles.io";

const NATIVE_TIGRIS_PROVIDERS: Record<string, string> = {
  apple: "Apple",
  auth0: "email",
  email: "email",
  github: "GitHub",
  "google-oauth2": "Google",
  windowslive: "Microsoft",
};

const SERVER_TAG = /^codemagic-patch-server-v(\d+)\.(\d+)\.(\d+)$/u;
const MAX_NAME_LENGTH = 63;

export type FlyNames = {
  accessKey: string;
  app: string;
  databaseApp: string;
  privateBucket: string;
  publicBucket: string;
};

/**
 * Whether a typed value can be a Fly app name: lowercase letters, digits and
 * inner dashes, at most 63 characters. Looser than `companyStem`, because it
 * checks a name someone else may have chosen rather than one this CLI makes.
 */
export function isFlyAppName(value: string): boolean {
  return value.length <= MAX_NAME_LENGTH && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
}

/**
 * `Acme Corp` becomes `acme-corp-patch`. A name that already ends in `-patch`
 * is the stem, so it is not doubled. The private bucket is that stem plus
 * `-internal`, which has to fit in a Fly and Tigris name.
 */
export function companyStem(company: string): string | null {
  const slug = company
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  if (!slug || !/^[a-z]/u.test(slug)) {
    return null;
  }

  const stem = slug.endsWith("-patch") ? slug : `${slug}-patch`;
  if (!/^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/u.test(stem)) {
    return null;
  }
  if (`${stem}-internal`.length > MAX_NAME_LENGTH) {
    return null;
  }

  return stem;
}

export function flyNames(stem: string): FlyNames {
  return {
    accessKey: `${stem}-key`,
    app: stem,
    databaseApp: `${stem}-db`,
    privateBucket: `${stem}-internal`,
    publicBucket: stem,
  };
}

/**
 * `tigris whoami --json` user ids from Google, GitHub, and email are a separate
 * account. A Fly card does not cover them. A Fly login has `fly` in the id.
 */
export function tigrisLoginKind(userId: string): "native" | "fly" | "unknown" {
  const segments = userId.split("|").map((segment) => segment.toLowerCase());
  const provider = segments[0] ?? "";
  if (provider in NATIVE_TIGRIS_PROVIDERS) {
    return "native";
  }
  if (segments.some((segment) => segment.includes("fly"))) {
    return "fly";
  }
  return "unknown";
}

export function tigrisProviderLabel(userId: string): string {
  const provider = userId.split("|", 1)[0]?.toLowerCase() ?? "";
  return NATIVE_TIGRIS_PROVIDERS[provider] ?? provider;
}

export function isStorageNameTaken(output: string): boolean {
  // `fly storage create` with a name any organization holds fails with "Name has already been taken".
  return /name has already been taken/iu.test(output);
}

/**
 * Whether `fly storage list --org <org>` lists `name`. Any cell may match, so
 * the column order does not matter; a bucket name has no spaces or box glyphs.
 */
export function flyStorageListHas(output: string, name: string): boolean {
  // flyctl 0.4.121+ prints a ` NAME │ ORG ` header, then cells padded with spaces and split by `│`;
  // releases before 2026-04 aligned them with spaces and tabs. Neither has `--json`.
  return output.split("\n").some((line) => stripAnsi(line).split(/[\s│]+/u).includes(name));
}

export function checkFlyRegion(value: string): string | null {
  return /^[a-z]{3}$/u.test(value)
    ? null
    : "Use a Fly region code, such as iad or lhr.";
}

/**
 * A pasted database URL. `.internal` is rejected: that hostname skips Fly's
 * proxy, so a suspended database would never wake.
 */
export function checkDatabaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Paste a postgres URL, for example postgres://user:pass@host:5432/patch";
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return "The database URL must start with postgres:// or postgresql://.";
  }
  if (!url.hostname) {
    return "The database URL needs a host.";
  }
  if (url.hostname === "internal" || url.hostname.endsWith(".internal")) {
    return "Use the .flycast hostname so a suspended database can wake. A .internal host skips Fly's proxy.";
  }

  return null;
}

/**
 * The download origin phones fetch. The bucket is the host, never a path.
 * New public buckets are served from this host, not from the S3 API host.
 */
export function publicBaseUrl(bucket: string): string {
  return `https://${bucket}.${TIGRIS_PUBLIC_HOST}`;
}

function endpointOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}

export function flycastDatabaseUrl(stem: string, password: string): string {
  const names = flyNames(stem);
  return `postgres://postgres:${encodeURIComponent(password)}@${names.databaseApp}.flycast:5432/patch`;
}

/**
 * `fly secrets import` stdin.
 *
 * flyctl strips one surrounding pair of single or double quotes and does not
 * interpret shell escapes. It cuts a value at `#` unless a double quote before
 * that `#` is still open. A value that rule would change is refused.
 */
export function formatSecrets(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${quoteSecret(key, value)}`)
    .join("\n")}\n`;
}

function quoteSecret(key: string, value: string): string {
  if (/[\n\r]/u.test(value)) {
    throw new Error(`${key} contains a newline. fly secrets import would split it.`);
  }

  const hash = value.indexOf("#");
  const quotesBeforeHash = hash === -1 ? 0 : value.slice(0, hash).split('"').length - 1;
  if (hash !== -1 && quotesBeforeHash % 2 === 1) {
    throw new Error(`${key} contains a # after a double quote. fly secrets import would cut the value there.`);
  }
  if (hash !== -1) {
    return `"${value}"`;
  }
  return `'${value}'`;
}

type AccessKeyExport = {
  accessKeyId: string;
  endpoint?: string;
  region?: string;
  secretAccessKey: string;
};

/**
 * `tigris access-keys create --export` lines. AWS names are what `--for aws`
 * prints. Tigris names are accepted too, in case that flag's labels differ.
 */
export function parseAccessKeyExport(output: string): AccessKeyExport | null {
  const values = new Map<string, string>();

  for (const line of output.split("\n")) {
    const match = /^(?:export\s+)?([A-Za-z0-9_]+)=(.*)$/u.exec(line.trim());
    if (!match) {
      continue;
    }

    let value = match[2]?.trim() ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1] ?? "", value);
  }

  const accessKeyId = values.get("AWS_ACCESS_KEY_ID") ?? values.get("TIGRIS_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = values.get("AWS_SECRET_ACCESS_KEY") ?? values.get("TIGRIS_STORAGE_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    endpoint: values.get("AWS_ENDPOINT_URL_S3") ?? values.get("TIGRIS_STORAGE_ENDPOINT"),
    region: values.get("AWS_REGION") ?? values.get("TIGRIS_STORAGE_REGION"),
    secretAccessKey,
  };
}

/** The highest `codemagic-patch-server-vX.Y.Z` in `git ls-remote --tags` output. */
export function chooseServerTag(output: string): string | null {
  // Newest first; the sort is stable, so the first-listed of two equal versions wins.
  return listServerTags(output).sort((left, right) => compareServerTags(right, left) ?? 0)[0] ?? null;
}

type ToolVersion = [number, number, number];

const FLYCTL_VERSION_LINE = /^\S+ v(\d+)\.(\d+)\.(\d+)\S* .*\bCommit:/mu;
const TIGRIS_VERSION_LINE = /^v?(\d+)\.(\d+)\.(\d+)\s*$/mu;

/**
 * The version `fly version` or `tigris version` printed, or null for another
 * shape. A newer-version notice can share flyctl's output, so only its
 * `fly v0.4.121 … Commit:` line counts; the Tigris CLI prints the bare version.
 */
export function parseToolVersion(tool: "fly" | "tigris", output: string): ToolVersion | null {
  const match = (tool === "fly" ? FLYCTL_VERSION_LINE : TIGRIS_VERSION_LINE).exec(output);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isBelowMinimum(installed: ToolVersion, minimum: string): boolean {
  const parts = minimum.split(".").map(Number);
  return compareVersions(installed, [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]) < 0;
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

type PatchTomlInput = {
  email: string;
  endpoint: string;
  publicBaseUrl: string;
  region: string;
  s3Region: string;
  /**
   * The `codemagic-patch-server-v*` tag being deployed. Written into `[env]`
   * so the release that carries the image also carries what it is, and a later
   * upgrade can read it back from `fly config show`.
   */
  serverTag: string;
  stem: string;
};

export function patchFlyToml(input: PatchTomlInput): string {
  const names = flyNames(input.stem);
  return `app = ${toml(names.app)}
primary_region = ${toml(input.region)}

[build]
  dockerfile = "server/Dockerfile"

[env]
  MODE = "all"
  STORAGE_ADAPTER = "s3"
  S3_BUCKET = ${toml(names.publicBucket)}
  S3_INTERNAL_BUCKET = ${toml(names.privateBucket)}
  S3_ENDPOINT = ${toml(endpointOrigin(input.endpoint))}
  S3_FORCE_PATH_STYLE = "true"
  S3_REGION = ${toml(input.s3Region)}
  PUBLIC_BASE_URL = ${toml(input.publicBaseUrl)}
  INITIAL_ADMIN_EMAILS = ${toml(input.email)}
  PATCH_SERVER_TAG = ${toml(input.serverTag)}

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    method = "GET"
    path = "/health"
    interval = "15s"
    timeout = "5s"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"
`;
}

export function databaseFlyToml(stem: string, region: string): string {
  const names = flyNames(stem);
  return `app = ${toml(names.databaseApp)}
primary_region = ${toml(region)}

[build]
  image = "postgres:16-alpine"

[env]
  POSTGRES_DB = "patch"
  PGDATA = "/var/lib/postgresql/data/pgdata"

[[mounts]]
  source = "pg_data"
  destination = "/var/lib/postgresql/data"

[[services]]
  protocol = "tcp"
  internal_port = 5432
  auto_stop_machines = "suspend"
  auto_start_machines = true
  min_machines_running = 0

  [[services.ports]]
    port = 5432

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"
`;
}

function toml(value: string): string {
  if (/["\n\\]/u.test(value)) {
    throw new Error(`Cannot store this value in fly.toml: ${value}`);
  }

  return `"${value}"`;
}

// ---------------------------------------------------------------------------
// Maintenance: what `fly … --json` and `fly config show` print, ROLLBACK.md
//
// The flyctl output shapes below were checked on flyctl 0.4.122 on 2026-10-26.
// ---------------------------------------------------------------------------

export function isServerTag(name: string): boolean {
  return SERVER_TAG.test(name);
}

/** Every `codemagic-patch-server-vX.Y.Z` in `git ls-remote --tags` output. */
export function listServerTags(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const ref = (line.split("\t")[1] ?? line).trim();
    if (ref.includes("^{}")) {
      continue;
    }
    const name = ref.replace(/^refs\/tags\//u, "");
    if (SERVER_TAG.test(name)) {
      names.add(name);
    }
  }
  return [...names];
}

/** Negative when `left` is the older server tag, null when either is not one. */
export function compareServerTags(left: string, right: string): number | null {
  const a = SERVER_TAG.exec(left);
  const b = SERVER_TAG.exec(right);
  if (!a || !b) {
    return null;
  }
  return compareVersions(
    [Number(a[1]), Number(a[2]), Number(a[3])],
    [Number(b[1]), Number(b[2]), Number(b[3])],
  );
}

/**
 * The JSON value in flyctl output. flyctl can print a warning or a
 * "Connecting…" line on the same merged stream, so the value is taken from the
 * first `[` or `{` to the matching last bracket.
 */
function parseJsonIn(output: string, open: "[" | "{"): unknown {
  const close = open === "[" ? "]" : "}";
  const start = output.indexOf(open);
  const end = output.lastIndexOf(close);
  if (start === -1 || end < start) {
    return undefined;
  }
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type FlyRelease = {
  imageRef: string;
  status: string;
  version: number;
};

/**
 * `fly releases --app <app> --json`: an array of fly-go `Release`, which has
 * no json tags, so the keys are the Go field names.
 */
export function parseFlyReleases(output: string): FlyRelease[] | null {
  const parsed = parseJsonIn(output, "[");
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.flatMap((entry) => {
    const release = record(entry);
    // fly-go's Release has no json tags, so the keys are Go field names.
    const version = count(release.Version);
    if (version === null) {
      return [];
    }
    return [{ imageRef: text(release.ImageRef), status: text(release.Status), version }];
  });
}

export function latestRelease(releases: readonly FlyRelease[]): FlyRelease | null {
  let latest: FlyRelease | null = null;
  for (const release of releases) {
    if (latest === null || release.version > latest.version) {
      latest = release;
    }
  }
  return latest;
}

/** What flyctl's deploy writes on a finished release (it writes running, complete, failed or interrupted). */
export const RELEASE_COMPLETE = "complete";

export type FlyGuest = {
  cpuKind: string;
  cpus: number;
  memoryMb: number;
};

type FlyMount = {
  path: string;
  sizeGb: number | null;
  volume: string;
};

/** `config.services[].autostop` as flyctl 0.4.122 lists it: `"suspend"`, `"stop"`, or `false` for off. */
export type FlyAutostop = "off" | "stop" | "suspend";

export type FlyMachine = {
  /** What the machine does when the proxy sees no traffic; null when no service says. */
  autostop: FlyAutostop | null;
  guest: FlyGuest | null;
  id: string;
  /** The image the machine runs, as `config.image` names it. */
  image: string;
  mounts: FlyMount[];
  state: string;
};

/**
 * `fly machine list --app <app> --json`: an array of fly-go `Machine`.
 */
export function parseFlyMachines(output: string): FlyMachine[] | null {
  const parsed = parseJsonIn(output, "[");
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.flatMap((entry) => {
    const machine = record(entry);
    const id = text(machine.id);
    if (id.length === 0) {
      return [];
    }
    const config = record(machine.config);
    const guest = record(config.guest);
    const cpus = count(guest.cpus);
    const memoryMb = count(guest.memory_mb);
    const mounts = Array.isArray(config.mounts) ? config.mounts : [];
    const services = Array.isArray(config.services) ? config.services : [];
    return [{
      autostop: readAutostop(services),
      guest: cpus === null || memoryMb === null
        ? null
        : { cpuKind: text(guest.cpu_kind), cpus, memoryMb },
      id,
      // The same string as the release's `ImageRef`.
      image: text(config.image),
      // `size_gb` is filled in, so the size need not come from `fly volumes list`.
      mounts: mounts.flatMap((value) => {
        const mount = record(value);
        const volume = text(mount.volume);
        return volume.length === 0
          ? []
          : [{ path: text(mount.path), sizeGb: count(mount.size_gb), volume }];
      }),
      state: text(machine.state),
    }];
  });
}

/** The first service that says: `"suspend"`, `"stop"` or `"off"`; `true` and `false` are the older boolean form (stop, off). */
function readAutostop(services: readonly unknown[]): FlyAutostop | null {
  for (const value of services) {
    const autostop = record(value).autostop;
    if (autostop === "suspend" || autostop === "stop" || autostop === "off") {
      return autostop;
    }
    if (autostop === true) {
      return "stop";
    }
    if (autostop === false) {
      return "off";
    }
  }
  return null;
}

export type FlySnapshot = {
  /** When the snapshot finished; null while it is pending. */
  createdAt: string | null;
  id: string;
  /** Null until the snapshot is created. */
  retentionDays: number | null;
  status: string;
};

/** Go's zero `time.Time`: flyctl lists it as `created_at` until the snapshot finishes. */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/**
 * `fly volumes snapshots list <volume id> --app <db> --json`: an array of
 * fly-go `VolumeSnapshot` (`id`, `status`, `created_at`, `retention_days`).
 * A new snapshot lists with its id at once; its `created_at` is the zero time
 * until it is created, then the time it finished.
 */
export function parseFlySnapshots(output: string): FlySnapshot[] | null {
  const parsed = parseJsonIn(output, "[");
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.map((entry) => {
    const snapshot = record(entry);
    const createdAt = text(snapshot.created_at);
    return {
      createdAt: createdAt.length === 0 || createdAt === GO_ZERO_TIME ? null : createdAt,
      id: text(snapshot.id),
      retentionDays: count(snapshot.retention_days),
      status: text(snapshot.status),
    };
  });
}

/** A finished snapshot's status; a new one lists as `waiting`, then `running`, then this. */
export const SNAPSHOT_CREATED = "created";
export const SNAPSHOT_FAILED = "failed";

/** A snapshot that has not reached a final state: a status other than `created` or `failed`. */
export function isSnapshotInProgress(snapshot: FlySnapshot): boolean {
  return snapshot.status !== SNAPSHOT_CREATED && snapshot.status !== SNAPSHOT_FAILED;
}

/** When a snapshot expires, from its creation time and retention, or null when either is missing. */
export function snapshotExpiry(snapshot: FlySnapshot): string | null {
  const created = snapshot.createdAt === null ? Number.NaN : Date.parse(snapshot.createdAt);
  if (Number.isNaN(created) || snapshot.retentionDays === null) {
    return null;
  }
  return new Date(created + snapshot.retentionDays * 86_400_000).toISOString();
}

/** The live release config `fly config show` prints, as far as the marker and `--register` need it. */
export type FlyReleaseConfig = {
  /** Each value trimmed. */
  env: Record<string, string>;
  region: string | null;
};

/** `fly config show --app <app>`, or null when it printed no JSON object. */
export function parseFlyAppConfig(output: string): FlyReleaseConfig | null {
  const parsed = parseJsonIn(output, "{");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  // A `fly deploy --env PATCH_SERVER_TAG=…` shows up in `env`, over the saved config's `[env]`.
  const config = record(parsed);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(record(config.env))) {
    if (typeof value === "string") {
      env[key] = value.trim();
    }
  }
  const region = text(config.primary_region);
  return { env, region: region.length > 0 ? region : null };
}

/**
 * The count `psql -tAc 'select count(*) from schema_migration'` printed
 * through `fly ssh console`, which can surround it with connection lines: the
 * last line that is only digits.
 */
export function parseMigrationCount(output: string): number | null {
  // `fly ssh console -C` prints a `Connecting to …` line before the command's output.
  const lines = stripAnsi(output).split(/\r?\n/u).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\d+$/u.test(lines[index] ?? "")) {
      return Number(lines[index]);
    }
  }
  return null;
}

type SavedVm = {
  cpuKind?: string;
  cpus?: number;
  memoryMb?: number;
};

type SavedFlyToml = {
  env: Record<string, string>;
  /** The first `[[vm]]` table, or null when the file has none. */
  vm: SavedVm | null;
};

/**
 * The `[env]` table and the first `[[vm]]` of a `fly config save` file: a line
 * reader, not a TOML parser. `key = value` pairs with a basic or literal
 * string, a number or a boolean; anything else in those tables is skipped.
 */
export function parseSavedFlyToml(contents: string): SavedFlyToml {
  const env: Record<string, string> = {};
  let vm: SavedVm | null = null;
  let section: "env" | "other" | "vm" | "vm-done" | null = null;

  // `fly config save` writes `[env]` and `[[vm]]` as plain tables of one-line, single-quoted values.
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      if (line === "[env]") {
        section = "env";
      } else if (line === "[[vm]]") {
        section = vm === null ? "vm" : "vm-done";
        vm ??= {};
      } else {
        section = "other";
      }
      continue;
    }
    if (section !== "env" && section !== "vm") {
      continue;
    }

    const match = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')\s*=\s*(.+)$/u.exec(line);
    if (!match) {
      continue;
    }
    const key = (match[1] ?? "").replace(/^["']|["']$/gu, "");
    const value = tomlScalar(match[2] ?? "");
    if (value === null) {
      continue;
    }
    if (section === "env") {
      env[key] = String(value);
      continue;
    }
    if (vm === null) {
      continue;
    }
    if (key === "cpu_kind" && typeof value === "string") {
      vm.cpuKind = value;
    } else if (key === "cpus" && typeof value === "number") {
      vm.cpus = value;
    } else if (key === "memory_mb" && typeof value === "number") {
      vm.memoryMb = value;
    } else if (key === "memory") {
      const memoryMb = memoryToMb(value);
      if (memoryMb !== null) {
        vm.memoryMb = memoryMb;
      }
    }
  }

  return { env, vm };
}

function tomlScalar(raw: string): boolean | number | string | null {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end === -1) {
      return null;
    }
    const body = value.slice(1, end);
    return quote === '"' ? body.replace(/\\(["\\])/gu, "$1") : body;
  }
  const bare = value.replace(/\s+#.*$/u, "");
  if (bare === "true" || bare === "false") {
    return bare === "true";
  }
  if (/^-?\d+(\.\d+)?$/u.test(bare)) {
    return Number(bare);
  }
  return null;
}

/** `512mb`, `1gb` or a bare number of megabytes. */
function memoryToMb(value: boolean | number | string): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(mb|gb)?$/iu.exec(value.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  return match[2]?.toLowerCase() === "gb" ? amount * 1024 : amount;
}

/** The `[env]` keys a Patch server cannot start without. */
const REQUIRED_FLY_ENV = [
  "MODE",
  "STORAGE_ADAPTER",
  "S3_BUCKET",
  "S3_INTERNAL_BUCKET",
  "S3_ENDPOINT",
  "PUBLIC_BASE_URL",
  "INITIAL_ADMIN_EMAILS",
] as const;

export function missingFlyEnv(env: Readonly<Record<string, string>>): string[] {
  return REQUIRED_FLY_ENV.filter((key) => (env[key] ?? "").trim().length === 0);
}

/** The notice when the saved `[[vm]]` would resize the machine, comparing only the fields both sides state. */
export function describeVmDrift(saved: SavedVm | null, live: FlyGuest | null): string | null {
  if (saved === null || live === null) {
    return null;
  }
  const differs =
    (saved.cpuKind !== undefined && saved.cpuKind !== live.cpuKind) ||
    (saved.cpus !== undefined && saved.cpus !== live.cpus) ||
    (saved.memoryMb !== undefined && saved.memoryMb !== live.memoryMb);
  if (!differs) {
    return null;
  }
  const savedSize = describeSize({
    cpuKind: saved.cpuKind ?? live.cpuKind,
    cpus: saved.cpus ?? live.cpus,
    memoryMb: saved.memoryMb ?? live.memoryMb,
  });
  return `The deploy applies the release config: ${savedSize} over the running ${describeSize(live)}.`;
}

function describeSize(guest: FlyGuest): string {
  return `${guest.cpuKind} ${guest.cpus} CPU, ${guest.memoryMb} MB`;
}

/** The managed database as the preflight found it, which is what a cutover restores onto. */
export type RollbackDatabase =
  | { kind: "external" }
  | {
      app: string;
      kind: "managed";
      machineId: string;
      migrationCount: number;
      sizeGb: number;
      snapshotExpiresAt: string | null;
      snapshotId: string;
      volumeId: string;
    };

type RollbackInput = {
  app: string;
  createdAt: string;
  database: RollbackDatabase;
  /** The baseline directory; its `fly.toml` is the config the release step deploys. */
  directory: string;
  previousImage: string;
  previousTag: string | null;
  region: string;
  targetTag: string;
};

/** The database mount path `databaseFlyToml` sets. */
export const DATABASE_MOUNT = "/var/lib/postgresql/data";

/**
 * How the preflight, the recipes and restore count migrations, run inside the
 * database machine. libpq there defaults to the Unix user, so the role and the
 * database are named.
 */
export const MIGRATION_COUNT_SQL = "psql -U postgres -d patch -tAc 'select count(*) from schema_migration'";

/** One upgrade's `ROLLBACK.md`, full or image-only (wiki/discussions/fly-setup-wizard.md, "`ROLLBACK.md`"). */
export function renderRollbackMd(input: RollbackInput): string {
  const release = releaseStep({
    app: input.app,
    flyToml: `${input.directory}/fly.toml`,
    image: input.previousImage,
    quoteLabel: "The baseline directory",
    tag: input.previousTag,
    title: "Deploy the previous server",
  });

  const lines = [
    `# Roll back the ${input.app} upgrade of ${input.createdAt}`,
    "",
    `This upgrade moved ${input.app} from ${input.previousTag ?? "an unrecorded server tag"} to ${input.targetTag}. cmpatch does not roll back by itself; these are the steps, in order. Run each command, and check what it says to see before going on.`,
    "",
    `- Previous image: ${input.previousImage}`,
    `- Previous tag: ${input.previousTag ?? "not recorded"}`,
  ];

  if (input.database.kind === "external") {
    lines.push(
      "- Database: external, not managed by cmpatch",
      "- Rollback kind: image-only",
      "",
      `The new server may already have migrated the database. Patch tooling cannot undo that on a database it does not manage, and the previous server must not run against a migrated database.`,
      "",
      ...renderSteps([
        holdStep(input.app),
        {
          command: `(your own tooling) restore the database to its state before ${input.createdAt}`,
          see: "your provider confirms the restore finished. Use point-in-time recovery or the backup you took before the upgrade.",
          title: "Put the database back",
        },
        release,
      ]),
    );
    return `${lines.join("\n")}\n`;
  }

  const db = input.database;
  lines.push(
    `- Database app: ${db.app}`,
    `- Database machine: ${db.machineId}`,
    `- Database volume: ${db.volumeId} (${db.sizeGb} GB)`,
    `- schema_migration rows before the upgrade: ${db.migrationCount}`,
    `- Snapshot: ${db.snapshotId}${db.snapshotExpiresAt === null ? "" : `, expires ${db.snapshotExpiresAt}`}`,
    "- Rollback kind: full",
    "",
    CUTOVER_INTERRUPTED,
    "",
    ...renderSteps([
      holdStep(input.app),
      ...cutoverSteps({ ...db, checkTitle: "Check the clone holds the pre-upgrade database", region: input.region }),
      release,
    ]),
  );
  return `${lines.join("\n")}\n`;
}

export type Step = { command: string; see: string; title: string };

const CUTOVER_INTERRUPTED = "If you stop between the clone and the destroy step, destroy whichever machine is not the verified clone before you continue.";

/** `"…"` around a `fly ssh console -C` value, for a recipe pasted into a POSIX shell. */
function shellDouble(command: string): string {
  return `"${command.replace(/["\\$`]/gu, "\\$&")}"`;
}

function consoleCommand(app: string, machine: string, command: string): string {
  return `fly ssh console --app ${app} --machine ${machine} -C ${shellDouble(command)}`;
}

/** D10's hold: no Patch machines, so nothing writes to the database. */
function holdStep(app: string): Step {
  return {
    command: `fly scale count 0 --app ${app} --yes`,
    see: `fly machine list --app ${app} --json prints [] (no Patch machines, so nothing can write to the database).`,
    title: "Hold Patch",
  };
}

/** D10's release step: a real deploy of a known image, with its marker, which also recreates the machine. */
function releaseStep(input: {
  app: string;
  flyToml: string;
  image: string;
  quoteLabel: string;
  tag: string | null;
  title: string;
}): Step {
  const marker = input.tag === null ? "" : ` --env PATCH_SERVER_TAG=${input.tag}`;
  return {
    command: `fly deploy --ha=false --app ${input.app} --config ${quoteShellValue(input.quoteLabel, input.flyToml)} --image ${input.image}${marker}`,
    see: `curl -s -o /dev/null -w '%{http_code}' https://${input.app}.fly.dev/health/ready prints 200, and the newest entry in fly releases --app ${input.app} is complete with image ${input.image}.`,
    title: input.title,
  };
}

/** The shared recipe "database cutover to a snapshot", after the hold. */
function cutoverSteps(db: {
  app: string;
  checkTitle: string;
  machineId: string;
  migrationCount: number;
  region: string;
  sizeGb: number;
  snapshotId: string;
  volumeId: string;
}): Step[] {
  return [
    {
      command: `fly machine stop ${db.machineId} --app ${db.app} --wait-timeout 60s`,
      see: `fly machine status ${db.machineId} --app ${db.app} shows stopped.`,
      title: "Stop the database machine",
    },
    {
      command: `fly volumes create pg_data --snapshot-id ${db.snapshotId} --size ${db.sizeGb} --region ${db.region} --app ${db.app} --yes`,
      see: "the new volume's id in the output. It is <new volume id> below.",
      title: "Make a volume from the snapshot",
    },
    {
      command: `fly machine clone ${db.machineId} --attach-volume <new volume id>:${DATABASE_MOUNT} --app ${db.app}`,
      see: "the clone's machine id in the output, and the clone started. It is <clone id> below.",
      title: "Clone the database machine onto that volume",
    },
    {
      command: consoleCommand(db.app, "<clone id>", MIGRATION_COUNT_SQL),
      see: `${db.migrationCount}. Anything else: stop, destroy <clone id>, start ${db.machineId} again, and ask for help before going on.`,
      title: db.checkTitle,
    },
    {
      command: `fly machine destroy ${db.machineId} --app ${db.app} --force`,
      see: `fly machine list --app ${db.app} --json lists only <clone id>. The old volume ${db.volumeId} stays until you delete it.`,
      title: "Destroy the old database machine",
    },
  ];
}

function renderSteps(steps: readonly Step[]): string[] {
  return steps.flatMap((step, index) => [
    `## ${index + 1}. ${step.title}`,
    "",
    "```sh",
    step.command,
    "```",
    "",
    `Before the next step: ${step.see}`,
    "",
  ]);
}

/** The same steps for a terminal: numbered, the command indented on its own line. */
export function renderStepsPlain(steps: readonly Step[]): string[] {
  return steps.flatMap((step, index) => [
    `  ${index + 1}. ${step.title}`,
    `       ${step.command}`,
    `     Before the next step: ${step.see}`,
  ]);
}

// ---------------------------------------------------------------------------
// Fly backups
// ---------------------------------------------------------------------------

/** The manifest's `format` value; restore reads no other (plan D4). */
export const FLY_BACKUP_FORMAT = "fly/1";
/** Names inside a Fly backup directory. The ssh backups' `env.selfhost` is never one of them. */
export const FLY_BACKUP_MANIFEST = "fly-backup-manifest";
export const FLY_BACKUP_DUMP = "postgres.dump";

export type FlyBackupManifest = {
  app: string;
  /** `config-only` for an external database: the manifest and `fly.toml`, no dump. */
  coverage: "config-only" | "database";
  /** When the dump started (or, config-only, when the backup was taken). */
  createdAt: string;
  databaseApp: string | null;
  flyctlVersion: string;
  org: string;
  postgresVersion: string | null;
  region: string;
  schemaMigrations: number | null;
  serverImage: string;
  /** The live `PATCH_SERVER_TAG` when the backup was taken, or null for an install that predates it. */
  serverTag: string | null;
  /** sha256 of `postgres.dump`, lowercase hex. */
  sha256: string | null;
};

const MANIFEST_KEYS = [
  ["format", () => FLY_BACKUP_FORMAT],
  ["app", (m: FlyBackupManifest) => m.app],
  ["database_app", (m: FlyBackupManifest) => m.databaseApp ?? ""],
  ["org", (m: FlyBackupManifest) => m.org],
  ["region", (m: FlyBackupManifest) => m.region],
  ["postgres_version", (m: FlyBackupManifest) => m.postgresVersion ?? ""],
  ["server_tag", (m: FlyBackupManifest) => m.serverTag ?? ""],
  ["server_image", (m: FlyBackupManifest) => m.serverImage],
  ["schema_migrations", (m: FlyBackupManifest) => m.schemaMigrations === null ? "" : String(m.schemaMigrations)],
  ["flyctl_version", (m: FlyBackupManifest) => m.flyctlVersion],
  ["created_at", (m: FlyBackupManifest) => m.createdAt],
  ["coverage", (m: FlyBackupManifest) => m.coverage],
  ["sha256", (m: FlyBackupManifest) => m.sha256 ?? ""],
] as const;

/** `fly-backup-manifest`: one `key=value` per line, an empty value for "none". */
export function renderBackupManifest(manifest: FlyBackupManifest): string {
  return `${MANIFEST_KEYS.map(([key, value]) => `${key}=${value(manifest).replace(/[\r\n]+/gu, " ")}`).join("\n")}\n`;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** A Fly backup's manifest, or why restore cannot use it. */
export function parseBackupManifest(contents: string): { manifest: FlyBackupManifest } | { problem: string } {
  const values = new Map<string, string>();
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    const equals = line.indexOf("=");
    if (line.length === 0 || line.startsWith("#") || equals === -1) {
      continue;
    }
    values.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }

  const format = values.get("format") ?? "";
  if (format !== FLY_BACKUP_FORMAT) {
    return { problem: format.length === 0 ? "it has no format line" : `its format is ${format}, not ${FLY_BACKUP_FORMAT}` };
  }
  const value = (key: string) => {
    const found = values.get(key) ?? "";
    return found.length === 0 ? null : found;
  };
  const coverage = value("coverage");
  if (coverage !== "database" && coverage !== "config-only") {
    return { problem: `its coverage is ${coverage ?? "missing"}, not database or config-only` };
  }
  for (const key of ["app", "server_image", "created_at"]) {
    if (value(key) === null) {
      return { problem: `it has no ${key}` };
    }
  }

  const migrations = value("schema_migrations");
  const schemaMigrations = migrations !== null && /^\d+$/u.test(migrations) ? Number(migrations) : null;
  const sha256 = value("sha256")?.toLowerCase() ?? null;
  if (coverage === "database") {
    if (value("database_app") === null) {
      return { problem: "it has no database_app" };
    }
    if (schemaMigrations === null) {
      return { problem: "it has no schema_migrations count" };
    }
    if (sha256 === null || !SHA256.test(sha256)) {
      return { problem: "it has no sha256 of the dump" };
    }
  }

  return {
    manifest: {
      app: value("app") ?? "",
      coverage,
      createdAt: value("created_at") ?? "",
      databaseApp: value("database_app"),
      flyctlVersion: value("flyctl_version") ?? "",
      org: value("org") ?? "",
      postgresVersion: value("postgres_version"),
      region: value("region") ?? "",
      schemaMigrations,
      serverImage: value("server_image") ?? "",
      serverTag: value("server_tag"),
      sha256,
    },
  };
}

/**
 * The checksum `sha256sum <path>` printed for that path through
 * `fly ssh console`, or null when no line names it.
 */
export function parseRemoteSha256(output: string, path: string): string | null {
  // `sha256sum` prints `<hex>  <path>`, after flyctl's `Connecting to …` line.
  for (const raw of stripAnsi(output).split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/u.exec(raw.trim());
    if (match !== null && match[2] === path) {
      return (match[1] ?? "").toLowerCase();
    }
  }
  return null;
}

/** `psql -tAc 'show server_version'` through `fly ssh console`: the last line that starts with a version number. */
export function parsePostgresVersion(output: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/u).map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^(\d+(?:\.\d+)*)(?:\s|$)/u.exec(lines[index] ?? "");
    if (match !== null) {
      return lines[index] ?? null;
    }
  }
  return null;
}

/** How a backup reads the server version, inside the database machine. */
export const POSTGRES_VERSION_SQL = "psql -U postgres -d patch -tAc 'show server_version'";

/** The one `fly ssh console -C` value that dumps the database and prints the dump's checksum. */
export function pgDumpCommand(remotePath: string): string {
  // `-C` is split into words without a shell, so `&&` only works inside `sh -c '…'`.
  return `sh -c 'pg_dump -U postgres -d patch -Fc -f ${remotePath} && sha256sum ${remotePath}'`;
}

// ---------------------------------------------------------------------------
// Fly restore
// ---------------------------------------------------------------------------

/**
 * How a restore replaces the database: sessions on `patch` ended, then the
 * database dropped and created again, each `-c` on its own so DROP DATABASE
 * runs outside a transaction. Run on `-d postgres`, the one database that is
 * not being replaced. `if exists`, so the finish recipe can send it again
 * after a run that dropped `patch` and stopped before creating it.
 */
export const DROP_CREATE_SQL = `psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'patch' and pid <> pg_backend_pid()" -c 'drop database if exists patch' -c 'create database patch'`;

/** All or nothing: one transaction, stopped at the first error. */
export function pgRestoreCommand(remotePath: string): string {
  return `pg_restore --single-transaction --exit-on-error -U postgres -d patch ${remotePath}`;
}

/** A `pg_restore` still running shows up as its own session. */
const RUNNING_RESTORE_SQL = `psql -U postgres -d postgres -tAc "select count(*) from pg_stat_activity where application_name = 'pg_restore'"`;

/**
 * How far a restore got, in order. Everything before `drop-sent` left the
 * database untouched; from `drop-sent` on, both recipes apply.
 */
const RESTORE_PHASES = [
  "staged",
  "hold-sent",
  "held",
  "snapshotted",
  "drop-sent",
  "restore-sent",
  "restored",
  "validated",
  "release-sent",
  "released",
  "completed",
] as const;

export type RestorePhase = (typeof RESTORE_PHASES)[number];

function reached(phase: RestorePhase, step: RestorePhase): boolean {
  return RESTORE_PHASES.indexOf(phase) >= RESTORE_PHASES.indexOf(step);
}

export type RestoreRecordInput = {
  app: string;
  backup: {
    createdAt: string;
    directory: string;
    /** The dump on this machine, which the finish recipe uploads again if the machine lost its copy. */
    dump: string;
    migrationCount: number;
    serverTag: string;
    sha256: string;
  };
  database: {
    app: string;
    machineId: string;
    /** `schema_migration` rows before the restore: what the undo recipe checks for. */
    migrationCount: number;
    sizeGb: number;
    volumeId: string;
  };
  /** The live release config `fly config save` wrote; the release step deploys it. */
  flyToml: string;
  /**
   * The database machine's autostop (`stop` or `suspend`) turned off for the
   * restore, and whether it is back on. Null when the machine had none to turn off.
   */
  keepAwake: { previous: "stop" | "suspend"; restored: boolean } | null;
  liveImage: string;
  liveTag: string;
  /** Set when validation found another count than the backup's: finishing is then wrong, undoing is right. */
  mismatch: { expected: number; found: number | null } | null;
  phase: RestorePhase;
  region: string;
  remoteDump: string;
  snapshot: { expiresAt: string | null; id: string } | null;
  startedAt: string;
  steps: ReadonlyArray<{ at: string; text: string }>;
};

type RestoreRecipes = {
  /** Null when there is nothing to finish, or finishing would be wrong. */
  finish: Step[] | null;
  /** The last step of either recipe while the database machine is kept awake; null once its autostop is back on. */
  sleep: Step | null;
  /** Null while the database is untouched, or before a safety snapshot exists. */
  undo: Step[] | null;
};

/** `fly machine update --autostop=off` and back: the command restore runs, and the recipes' last step. */
export function autostopArgs(machineId: string, databaseApp: string, value: FlyAutostop): string[] {
  return ["machine", "update", machineId, "--app", databaseApp, `--autostop=${value}`, "--yes"];
}

/** The database machine's autostop back on, once nothing more needs it awake (D10). */
function sleepStep(databaseApp: string, machineId: string, previous: "stop" | "suspend"): Step {
  return {
    command: `fly ${autostopArgs(machineId, databaseApp, previous).join(" ")}`,
    see: `Machine ${machineId} updated successfully. It ${previous === "suspend" ? "suspends" : "stops"} again when idle, as before the restore.`,
    title: "Let the database machine sleep again",
  };
}

/** The finish and undo recipes for where a restore stands (wiki/discussions/fly-setup-wizard.md, "Restore recipes"). */
export function restoreRecipes(input: RestoreRecordInput): RestoreRecipes {
  const db = input.database;
  const release = releaseStep({
    app: input.app,
    flyToml: input.flyToml,
    image: input.liveImage,
    quoteLabel: "The restore's release config",
    tag: input.liveTag,
    title: "Deploy the server it ran before (release Patch)",
  });
  const start: Step = {
    command: `fly machine start ${db.machineId} --app ${db.app}`,
    see: `fly machine status ${db.machineId} --app ${db.app} shows started (a machine that is already started says so).`,
    title: "Start the database machine",
  };
  const validate: Step = {
    command: consoleCommand(db.app, db.machineId, MIGRATION_COUNT_SQL),
    see: `${input.backup.migrationCount}, the backup's count. Anything else: do not release; undo the restore instead.`,
    title: "Check the restored database",
  };

  const awake = input.keepAwake !== null && !input.keepAwake.restored ? input.keepAwake.previous : null;
  const sleep = awake === null ? null : sleepStep(db.app, db.machineId, awake);

  let finish: Step[] | null;
  if (input.mismatch !== null || input.phase === "staged" || input.phase === "completed") {
    finish = null;
  } else if (!reached(input.phase, "drop-sent")) {
    finish = [release];
  } else if (!reached(input.phase, "restored")) {
    finish = [
      start,
      {
        command: consoleCommand(db.app, db.machineId, RUNNING_RESTORE_SQL),
        see: "0. More than 0 means the earlier pg_restore is still running: wait, and run this again until it prints 0. Never drop the database under it.",
        title: "Make sure no pg_restore is still running",
      },
      {
        command: consoleCommand(db.app, db.machineId, DROP_CREATE_SQL),
        see: "DROP DATABASE and CREATE DATABASE, and no ERROR (a NOTICE that patch does not exist is fine: an earlier run dropped it).",
        title: "Drop and create the database again",
      },
      {
        command: consoleCommand(db.app, db.machineId, pgRestoreCommand(input.remoteDump)),
        see: `it exits without an error. If it says ${input.remoteDump} does not exist, upload it again with fly ssh sftp put ${quoteShellValue("The backup's dump", input.backup.dump)} ${input.remoteDump} --app ${db.app} --machine ${db.machineId}, check that ${consoleCommand(db.app, db.machineId, `sha256sum ${input.remoteDump}`)} prints ${input.backup.sha256}, then run this step again.`,
        title: "Restore the backup",
      },
      validate,
      release,
    ];
  } else if (!reached(input.phase, "validated")) {
    finish = [start, validate, release];
  } else if (!reached(input.phase, "released")) {
    finish = [release];
  } else {
    finish = [{
      command: `curl -s -o /dev/null -w '%{http_code}' https://${input.app}.fly.dev/health/ready`,
      see: `200. Anything else: fly logs --app ${input.app} shows why; if the restored database is the cause, undo the restore.`,
      title: "Check the server is ready",
    }];
  }

  let undo = reached(input.phase, "drop-sent") && input.snapshot !== null
    ? [
        holdStep(input.app),
        ...cutoverSteps({
          ...db,
          checkTitle: "Check the clone holds the database from before the restore",
          region: input.region,
          snapshotId: input.snapshot.id,
        }),
        release,
      ]
    : null;

  // Kept awake until the last step, since the manual pg_restore would hang
  // inside a suspended machine just as the command's did.
  if (awake !== null && sleep !== null) {
    finish = finish === null ? null : [...finish, sleep];
    // The cutover leaves the clone, with the old machine's config, as the database machine.
    undo = undo === null ? null : [...undo, sleepStep(db.app, "<clone id>", awake)];
  }

  return { finish, sleep, undo };
}

/** One line on where the restore stands, for the record and the terminal. */
export function describeRestorePhase(input: RestoreRecordInput): string {
  if (input.mismatch !== null) {
    return `The restored database has ${input.mismatch.found ?? "no readable"} schema_migration rows, not the backup's ${input.mismatch.expected}. Do not release it: undo the restore.`;
  }
  switch (input.phase) {
    case "staged":
      return `Nothing on ${input.app} has changed yet; the dump is being uploaded to the database machine, or is there.`;
    case "hold-sent":
    case "held":
    case "snapshotted":
      return `Patch is held (or being held) with no machines, and the database is untouched. Finishing is the release step alone.`;
    case "drop-sent":
      return "The drop was sent; the database may be empty. Finish (from the top of its steps) or undo.";
    case "restore-sent":
      return "pg_restore was sent and did not provably complete. Finish (from the top of its steps) or undo.";
    case "restored":
      return "pg_restore exited 0; the count has not been checked. Finish or undo.";
    case "validated":
    case "release-sent":
      return "The restored database matches the backup; Patch has not been released yet. Finish with the release step, or undo.";
    case "released":
      return "The server was deployed on the restored database but did not answer /health/ready. Check it, or undo.";
    case "completed":
      return "The restore completed. The undo below stays valid until the safety snapshot expires.";
  }
}

/** The restore record, D11 (wiki/discussions/fly-setup-wizard.md, "The restore record"). */
export function renderRestoreRecordMd(input: RestoreRecordInput): string {
  const db = input.database;
  const recipes = restoreRecipes(input);
  const lines = [
    `# Restore of ${input.app}, started ${input.startedAt}`,
    "",
    "cmpatch writes this record before its first change to Fly and adds each step as it is reached. It does not continue or undo an interrupted restore by itself: the recipes below are the continuation. Run each command, and check what it says to see before going on.",
    "",
    `- Backup: ${input.backup.directory} (taken ${input.backup.createdAt} on ${input.backup.serverTag}, ${input.backup.migrationCount} schema_migration rows, sha256 ${input.backup.sha256})`,
    `- Live image: ${input.liveImage}`,
    `- Live tag: ${input.liveTag}`,
    `- Release config: ${input.flyToml}`,
    `- Database app: ${db.app}`,
    `- Database machine (pinned): ${db.machineId}`,
    `- Database volume: ${db.volumeId} (${db.sizeGb} GB)`,
    `- schema_migration rows before the restore: ${db.migrationCount}`,
    `- Dump on the machine: ${input.remoteDump}`,
    `- Safety snapshot: ${input.snapshot === null ? "not taken yet" : `${input.snapshot.id}${input.snapshot.expiresAt === null ? "" : `, expires ${input.snapshot.expiresAt}`}`}`,
    `- Database machine autostop: ${describeKeepAwake(input.keepAwake)}`,
    "",
    "## Steps reached",
    "",
    ...input.steps.map((step) => `- ${step.at} ${step.text}`),
    "",
    "## Where it stands",
    "",
    describeRestorePhase(input),
    "",
  ];

  if (recipes.finish !== null) {
    lines.push("# Finish the restore", "", ...renderSteps(recipes.finish));
  }
  if (recipes.undo !== null) {
    lines.push("# Undo the restore", "", CUTOVER_INTERRUPTED, "", ...renderSteps(recipes.undo));
  }
  if (input.phase === "completed" && recipes.sleep !== null) {
    lines.push("# Let the database machine sleep again", "", KEPT_AWAKE_AFTER_COMPLETION, "", ...renderSteps([recipes.sleep]));
  }
  return `${lines.join("\n")}\n`;
}

/** One phrase for the record's autostop line. */
export function describeKeepAwake(keepAwake: RestoreRecordInput["keepAwake"]): string {
  if (keepAwake === null) {
    return "none to turn off; left as it is";
  }
  return `${keepAwake.previous}, turned off for the restore${keepAwake.restored ? ", back on" : " and still off"}`;
}

export const KEPT_AWAKE_AFTER_COMPLETION = "The restore completed, but the database machine's autostop could not be turned back on, so it never sleeps when idle until you run this.";
