import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";

import { PRODUCT_NAME } from "./branding";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord } from "./output";

/**
 * How the CLI reaches one self-hosted server over ssh. Written by pairing (the
 * `selfhost` commands' shared first step) and read by every later remote call,
 * so the user's own SSH setup is a bootstrap channel and never a runtime
 * dependency.
 */
export interface SelfhostMapping {
  /** The CLI-owned private key. Absent only for a pairing recorded by hand. */
  identityFile?: string;
  /**
   * The remote checkout, as a canonical absolute path from the host itself
   * (`pwd -P`). Never `~/...`: values are serialized single-quoted into the
   * generated remote script, and a quoted tilde does not expand — it would
   * create a literal `~` directory while the CLI printed a home-relative path
   * that does not exist.
   */
  remotePath?: string;
  sshTarget: string;
}

/**
 * An install that started and has not been recorded as finished.
 *
 * This is what separates install-state (c) — an incomplete install, which may
 * be resumed, repaired, or discarded — from state (d), an unknown deployment
 * that is merely unhealthy right now. `.env.selfhost` present plus a failing
 * health check looks identical in both cases, and every mutating option is
 * wrong for a server that installed fine months ago and is simply down. So the
 * distinction is drawn from evidence the CLI owns rather than from a guess
 * about the server: this record is written immediately before the first
 * `install.sh` run and cleared when the install completes.
 *
 * Keyed by ssh host, not by server URL: at that point no server URL exists.
 * Its honest limitation is that an install that failed on another machine
 * leaves no record here, so that server reads as (d) — the conservative
 * default for a machine that cannot know what happened.
 */
export interface SelfhostPendingInstall {
  /**
   * What the previous run failed on, which selects the default recovery edge.
   * Free-form rather than a closed union so a new classification in the
   * installer cannot invalidate a config file written by an older CLI.
   */
  failure?: string;
  identityFile?: string;
  /** ISO 8601, for the "started N ago" line and for stale-record pruning. */
  startedAt?: string;
}

export interface CliConfig {
  /** Keyed by ssh host — see SelfhostPendingInstall. */
  pendingInstall?: Record<string, SelfhostPendingInstall>;
  /** Keyed by normalized server URL. */
  selfhost?: Record<string, SelfhostMapping>;
  serverUrl?: string;
  team?: string;
  teamId?: string;
}

export interface ProjectConfig extends CliConfig {
  app?: string;
  appId?: string;
  apps?: ProjectPlatformConfigMap;
  bundler?: string;
  deployment?: string;
  platform?: string;
}

export interface ProjectPlatformConfig {
  app?: string;
  appId?: string;
  deployment?: string;
}

export interface ProjectPlatformConfigMap {
  android?: ProjectPlatformConfig;
  ios?: ProjectPlatformConfig;
}

interface CliConfigFile extends CliConfig {
  version: 1;
}

export interface CliConfigOptions {
  env?: Record<string, string | undefined>;
}

/**
 * The CLI's own state directory. Shared by the config file, the credential
 * store, the CLI-owned ssh keys, and the remote-run logs, so a test that
 * redirects CODEMAGIC_PATCH_HOME redirects all of them at once.
 */
export function resolveConfigHome(
  env: Record<string, string | undefined> = process.env,
): string {
  const codemagicPatchHome = resolveOptionalString(env.CODEMAGIC_PATCH_HOME);

  return (
    codemagicPatchHome ??
    join(resolveOptionalString(env.HOME) ?? homedir(), ".codemagic-patch")
  );
}

export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolveConfigHome(env), "config.json");
}

export function resolveProjectConfigPath(projectRoot: string): string {
  return join(projectRoot, "codemagic-patch.config.json");
}

export function resolvePackageConfigPath(projectRoot: string): string {
  return join(projectRoot, "package.json");
}

export async function loadCliConfig(
  options: CliConfigOptions = {},
): Promise<CliConfig> {
  const path = resolveConfigPath(options.env);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isCliConfigFile(parsed)) {
    throw new Error(`Invalid ${PRODUCT_NAME} config file: ${path}`);
  }

  return stripEmptyConfig({
    pendingInstall: normalizePendingInstalls(parsed.pendingInstall),
    selfhost: normalizeSelfhostMappings(parsed.selfhost),
    serverUrl: parsed.serverUrl,
    team: parsed.team,
    teamId: parsed.teamId,
  });
}

/**
 * A malformed entry is dropped, not fatal.
 *
 * Everything else in this file is validated strictly, and a bad `serverUrl`
 * rightly takes the whole config down — but the `selfhost` section is read
 * only by the `selfhost` commands, and refusing to load the file for its sake
 * would break `login`, `release`, and everything else over a section they
 * never touch. A dropped mapping degrades to "no pairing recorded", which the
 * commands already handle by pairing again; a refused config file does not
 * degrade to anything.
 *
 * Fields this version does not know are carried through, not stripped: the
 * loaded view is also what `saveCliConfig` writes back, so dropping them here
 * would mean an older CLI permanently erases what a newer one recorded the
 * first time it saves.
 */
function normalizeSelfhostMappings(
  value: unknown,
): Record<string, SelfhostMapping> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const mappings: Record<string, SelfhostMapping> = {};
  for (const [serverUrl, mapping] of Object.entries(value)) {
    if (
      !isRecord(mapping) ||
      typeof mapping.sshTarget !== "string" ||
      !optionalStringField(mapping, "identityFile") ||
      !optionalStringField(mapping, "remotePath")
    ) {
      continue;
    }

    const sshTarget = resolveOptionalString(mapping.sshTarget);
    if (sshTarget === undefined) {
      continue;
    }

    const identityFile = readOptionalString(mapping, "identityFile");
    const remotePath = readOptionalString(mapping, "remotePath");
    mappings[serverUrl] = {
      ...withoutKeys(mapping, ["identityFile", "remotePath", "sshTarget"]),
      ...(identityFile !== undefined ? { identityFile } : {}),
      ...(remotePath !== undefined ? { remotePath } : {}),
      sshTarget,
    };
  }

  return Object.keys(mappings).length > 0 ? mappings : undefined;
}

function normalizePendingInstalls(
  value: unknown,
): Record<string, SelfhostPendingInstall> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const records: Record<string, SelfhostPendingInstall> = {};
  for (const [sshHost, record] of Object.entries(value)) {
    if (
      !isRecord(record) ||
      !optionalStringField(record, "failure") ||
      !optionalStringField(record, "identityFile") ||
      !optionalStringField(record, "startedAt")
    ) {
      continue;
    }

    const failure = readOptionalString(record, "failure");
    const identityFile = readOptionalString(record, "identityFile");
    const startedAt = readOptionalString(record, "startedAt");
    records[sshHost] = {
      ...withoutKeys(record, ["failure", "identityFile", "startedAt"]),
      ...(failure !== undefined ? { failure } : {}),
      ...(identityFile !== undefined ? { identityFile } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
  }

  return Object.keys(records).length > 0 ? records : undefined;
}

/** The entry minus its known fields — what a newer CLI may have added. */
function withoutKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const rest = { ...record };
  for (const key of keys) {
    delete rest[key];
  }

  return rest;
}

export async function loadProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const packageConfig = await loadPackageProjectConfig(projectRoot);
  const fileConfig = await loadProjectConfigFile(projectRoot);

  return mergeProjectConfigs(packageConfig, fileConfig);
}

export async function loadProjectConfigFile(
  projectRoot: string,
): Promise<ProjectConfig> {
  const path = resolveProjectConfigPath(projectRoot);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isProjectConfigFile(parsed)) {
    throw new Error(`Invalid ${PRODUCT_NAME} project config file: ${path}`);
  }

  return stripEmptyProjectConfig({
    app: parsed.app,
    appId: parsed.appId,
    apps: parsed.apps,
    bundler: parsed.bundler,
    deployment: parsed.deployment,
    platform: parsed.platform,
    serverUrl: parsed.serverUrl,
    team: parsed.team,
    teamId: parsed.teamId,
  });
}

async function loadPackageProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const path = resolvePackageConfigPath(projectRoot);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || !("codemagicPatch" in parsed)) {
    return {};
  }

  const cmpatch = parsed.codemagicPatch;
  if (!isProjectConfigFile(cmpatch)) {
    throw new Error(`Invalid ${PRODUCT_NAME} package config file: ${path}`);
  }

  return stripEmptyProjectConfig({
    app: cmpatch.app,
    appId: cmpatch.appId,
    apps: cmpatch.apps,
    bundler: cmpatch.bundler,
    deployment: cmpatch.deployment,
    platform: cmpatch.platform,
    serverUrl: cmpatch.serverUrl,
    team: cmpatch.team,
    teamId: cmpatch.teamId,
  });
}

export async function saveCliConfig(
  config: CliConfig,
  options: CliConfigOptions = {},
): Promise<void> {
  const path = resolveConfigPath(options.env);
  await mkdir(dirname(path), {
    mode: 0o700,
    recursive: true,
  });

  const next: CliConfigFile = {
    ...stripEmptyConfig(config),
    version: 1,
  };
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(tempPath, path);
}

export async function saveProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const path = resolveProjectConfigPath(projectRoot);
  await mkdir(dirname(path), {
    recursive: true,
  });

  const next = stripEmptyProjectConfig(config);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tempPath, path);
}

function stripEmptyConfig(config: CliConfig): CliConfig {
  return {
    // Sections survive `config set`/`unset` because those callers spread the
    // loaded config; stripping them here would silently unpair every server
    // the moment someone stored a team default.
    ...(config.pendingInstall !== undefined &&
    Object.keys(config.pendingInstall).length > 0
      ? { pendingInstall: config.pendingInstall }
      : {}),
    ...(config.selfhost !== undefined && Object.keys(config.selfhost).length > 0
      ? { selfhost: config.selfhost }
      : {}),
    ...(resolveOptionalString(config.serverUrl) !== undefined
      ? { serverUrl: resolveOptionalString(config.serverUrl) }
      : {}),
    ...(resolveOptionalString(config.team) !== undefined
      ? { team: resolveOptionalString(config.team) }
      : {}),
    ...(resolveOptionalString(config.teamId) !== undefined
      ? { teamId: resolveOptionalString(config.teamId) }
      : {}),
  };
}

function stripEmptyProjectConfig(config: ProjectConfig): ProjectConfig {
  const apps = stripEmptyProjectPlatformConfigMap(config.apps);

  return {
    ...stripEmptyConfig(config),
    ...(resolveOptionalString(config.app) !== undefined
      ? { app: resolveOptionalString(config.app) }
      : {}),
    ...(resolveOptionalString(config.appId) !== undefined
      ? { appId: resolveOptionalString(config.appId) }
      : {}),
    ...(apps !== undefined ? { apps } : {}),
    ...(resolveOptionalString(config.bundler) !== undefined
      ? { bundler: resolveOptionalString(config.bundler) }
      : {}),
    ...(resolveOptionalString(config.deployment) !== undefined
      ? { deployment: resolveOptionalString(config.deployment) }
      : {}),
    ...(resolveOptionalString(config.platform) !== undefined
      ? { platform: resolveOptionalString(config.platform) }
      : {}),
  };
}

function isCliConfigFile(value: unknown): value is CliConfigFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    // Only the section's SHAPE is validated here; individual malformed entries
    // are dropped during normalization rather than failing the whole file.
    optionalRecordField(value, "pendingInstall") &&
    optionalRecordField(value, "selfhost") &&
    optionalStringField(value, "serverUrl") &&
    optionalStringField(value, "team") &&
    optionalStringField(value, "teamId")
  );
}

function isProjectConfigFile(value: unknown): value is ProjectConfig {
  return (
    isRecord(value) &&
    optionalStringField(value, "app") &&
    optionalStringField(value, "appId") &&
    optionalProjectPlatformConfigMapField(value, "apps") &&
    optionalStringField(value, "bundler") &&
    optionalStringField(value, "deployment") &&
    optionalStringField(value, "platform") &&
    optionalStringField(value, "serverUrl") &&
    optionalStringField(value, "team") &&
    optionalStringField(value, "teamId")
  );
}

function mergeProjectConfigs(
  packageConfig: ProjectConfig,
  fileConfig: ProjectConfig,
): ProjectConfig {
  return stripEmptyProjectConfig({
    ...packageConfig,
    ...fileConfig,
    apps: {
      ...(packageConfig.apps ?? {}),
      ...(fileConfig.apps ?? {}),
    },
  });
}

function stripEmptyProjectPlatformConfigMap(
  value: ProjectPlatformConfigMap | undefined,
): ProjectPlatformConfigMap | undefined {
  if (value === undefined) {
    return undefined;
  }

  const android = stripEmptyProjectPlatformConfig(value.android);
  const ios = stripEmptyProjectPlatformConfig(value.ios);
  const next: ProjectPlatformConfigMap = {
    ...(android !== undefined ? { android } : {}),
    ...(ios !== undefined ? { ios } : {}),
  };

  return Object.keys(next).length > 0 ? next : undefined;
}

function stripEmptyProjectPlatformConfig(
  value: ProjectPlatformConfig | undefined,
): ProjectPlatformConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const next: ProjectPlatformConfig = {
    ...(resolveOptionalString(value.app) !== undefined
      ? { app: resolveOptionalString(value.app) }
      : {}),
    ...(resolveOptionalString(value.appId) !== undefined
      ? { appId: resolveOptionalString(value.appId) }
      : {}),
    ...(resolveOptionalString(value.deployment) !== undefined
      ? { deployment: resolveOptionalString(value.deployment) }
      : {}),
  };

  return Object.keys(next).length > 0 ? next : undefined;
}

function optionalProjectPlatformConfigMapField(
  value: object,
  key: string,
): boolean {
  const record = value as Record<string, unknown>;
  if (!(key in record)) {
    return true;
  }

  const apps = record[key];
  return (
    isRecord(apps) &&
    optionalProjectPlatformConfigField(apps, "android") &&
    optionalProjectPlatformConfigField(apps, "ios")
  );
}

function optionalProjectPlatformConfigField(
  value: object,
  key: string,
): boolean {
  const record = value as Record<string, unknown>;
  if (!(key in record)) {
    return true;
  }

  const config = record[key];
  return (
    isRecord(config) &&
    optionalStringField(config, "app") &&
    optionalStringField(config, "appId") &&
    optionalStringField(config, "deployment")
  );
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? resolveOptionalString(value) : undefined;
}

function optionalRecordField(value: object, key: string): boolean {
  const record = value as Record<string, unknown>;
  return !(key in record) || isRecord(record[key]);
}

function optionalStringField(value: object, key: string): boolean {
  const record = value as Record<string, unknown>;
  return !(key in record) || typeof record[key] === "string";
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}
