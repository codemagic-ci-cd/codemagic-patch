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

export interface CliConfig {
  serverUrl?: string;
  team?: string;
  teamId?: string;
}

export interface ProjectConfig extends CliConfig {
  app?: string;
  apps?: ProjectPlatformConfigMap;
  bundler?: string;
  deployment?: string;
  platform?: string;
}

export interface ProjectPlatformConfig {
  app?: string;
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

export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const codemagicPatchHome = resolveOptionalString(env.CODEMAGIC_PATCH_HOME);
  const home = codemagicPatchHome ?? join(resolveOptionalString(env.HOME) ?? homedir(), ".codemagic-patch");

  return join(home, "config.json");
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
    serverUrl: parsed.serverUrl,
    team: parsed.team,
    teamId: parsed.teamId,
  });
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
    optionalStringField(value, "serverUrl") &&
    optionalStringField(value, "team") &&
    optionalStringField(value, "teamId")
  );
}

function isProjectConfigFile(value: unknown): value is ProjectConfig {
  return (
    isRecord(value) &&
    optionalStringField(value, "app") &&
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
    optionalStringField(config, "deployment")
  );
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
