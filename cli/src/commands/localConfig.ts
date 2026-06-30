import type { ConfigCommand, ContextCommand, InitCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import {
  loadCliConfig,
  loadProjectConfig,
  loadProjectConfigFile,
  saveCliConfig,
  saveProjectConfig,
  type CliConfig,
  type ProjectConfig,
  type ProjectPlatformConfigMap,
} from "../configStore";
import {
  isProjectRootOnlyCommand,
  resolveEffectiveContext,
  resolveProjectRoot,
} from "../localContext";
import { isRecord, writeLine } from "../output";
import {
  detectNativePlatforms,
  detectProjectBundler,
  formatBundlerName,
  type NativePlatform,
} from "../projectAnalysis";
import type { PromptFn } from "../prompt";
import { assertHttpUrl, buildApiUrl, type CommandDeps, UsageError } from "./shared";

export async function executeConfigCommand(
  command: ConfigCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const [subcommand, rawKey, value, ...extra] = command.argv;
  const key = rawKey === undefined ? undefined : normalizeConfigKey(rawKey);
  const config = await loadCliConfig({ env: deps.env });

  if (subcommand === "list" && key === undefined) {
    return config;
  }

  if (subcommand === "get" && key !== undefined && value === undefined) {
    if (!isConfigKey(key)) {
      throw new UsageError(`Unknown config key: ${key}`);
    }

    return config[key] ?? null;
  }

  if (
    subcommand === "set" &&
    key !== undefined &&
    value !== undefined &&
    extra.length === 0
  ) {
    if (!isConfigKey(key)) {
      throw new UsageError(`Unknown config key: ${key}`);
    }

    if (value.trim().length === 0) {
      throw new UsageError(`Config value cannot be empty: ${key}`);
    }

    const next = { ...config };
    next[key] = key === "serverUrl" ? assertHttpUrl(value) : value;
    if (key === "team") {
      delete next.teamId;
    }
    if (key === "teamId") {
      delete next.team;
    }

    await saveCliConfig(next, { env: deps.env });
    return `Set ${rawKey}`;
  }

  if (subcommand === "unset" && key !== undefined && value === undefined) {
    if (!isConfigKey(key)) {
      throw new UsageError(`Unknown config key: ${key}`);
    }

    const next = { ...config };
    delete next[key];
    await saveCliConfig(next, { env: deps.env });
    return `Unset ${rawKey}`;
  }

  throw new UsageError("Usage: cmpatch config (list|get|set|unset) [key] [value]");
}

export async function executeInitCommand(
  command: InitCommand,
  deps: CommandDeps,
): Promise<unknown> {
  // Honor --project-root like doctor/context/release-react do, so the monorepo
  // workflow `cmpatch init --project-root ./apps/mobile` links the right package
  // instead of always linking the cwd.
  const projectRoot = resolveProjectRoot(command.argv);
  if (projectRoot.trim().length === 0) {
    throw new UsageError("Init value cannot be empty: --project-root");
  }
  const config = await loadProjectConfigFile(projectRoot);
  return linkProject(command.argv, deps, projectRoot, config);
}

export async function executeContextCommand(
  command: ContextCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const projectRoot = resolveProjectRoot(command.argv);

  if (!isProjectRootOnlyCommand(command.argv)) {
    throw new UsageError("Usage: cmpatch context [--project-root <path>]");
  }

  const userConfig = await loadCliConfig({ env: deps.env });
  const projectConfig = await loadProjectConfig(projectRoot);

  return resolveEffectiveContext(deps.env, userConfig, projectConfig, projectRoot);
}

function isConfigKey(key: string): key is keyof CliConfig {
  return key === "serverUrl" || key === "team" || key === "teamId";
}

function normalizeConfigKey(key: string): string {
  if (key === "server-url") {
    return "serverUrl";
  }

  if (key === "team-id") {
    return "teamId";
  }

  return key;
}

type NamedResource = {
  id: string;
  name: string;
};

type LinkFlags = {
  androidApp?: string;
  androidAppId?: string;
  androidDeployment?: string;
  androidDeploymentId?: string;
  app?: string;
  appId?: string;
  bundler?: string;
  deployment?: string;
  deploymentId?: string;
  iosApp?: string;
  iosAppId?: string;
  iosDeployment?: string;
  iosDeploymentId?: string;
  nonInteractive: boolean;
  platform?: string;
  projectRoot?: string;
  serverUrl?: string;
  team?: string;
  teamId?: string;
  token?: string;
  yes: boolean;
};

async function linkProject(
  args: string[],
  deps: CommandDeps,
  projectRoot: string,
  existingConfig: ProjectConfig,
): Promise<unknown> {
  const flags = parseLinkFlags(args);
  validatePlatformSpecificFlags(flags);
  const interactive =
    deps.stdin?.isTTY === true &&
    !flags.yes &&
    !flags.nonInteractive &&
    deps.prompt !== undefined;
  const userConfig = await loadCliConfig({ env: deps.env });
  const effectiveContext = resolveEffectiveContext(
    deps.env,
    userConfig,
    existingConfig,
    projectRoot,
  );
  let serverUrl: string | undefined;
  if (flags.serverUrl !== undefined) {
    serverUrl = flags.serverUrl;
  } else if (interactive && deps.prompt) {
    serverUrl = await promptServerUrl(deps.prompt, effectiveContext.serverUrl?.value);
  } else {
    serverUrl = effectiveContext.serverUrl?.value;
  }
  if (serverUrl === undefined) {
    throw new UsageError(
      "Init needs a server URL. Pass --server-url <url> or run `cmpatch config set server-url <url>`.",
    );
  }
  serverUrl = assertHttpUrl(serverUrl);

  const autoSelected: string[] = [];
  const team = await selectTeam(deps, serverUrl, flags, autoSelected, interactive);
  const platforms = await selectLinkPlatforms(
    deps,
    flags,
    projectRoot,
    autoSelected,
    interactive,
  );
  validateMultiPlatformSelectors(flags, platforms, interactive);
  const apps = await listNamedResources(
    deps,
    serverUrl,
    `/v1/teams/${encodeURIComponent(team.id)}/apps`,
    flags.token,
    "apps",
  );
  const platformConfigs: ProjectPlatformConfigMap = {};
  for (const platform of platforms) {
    const app = await selectAppForPlatform(
      deps,
      apps,
      flags,
      platform,
      autoSelected,
      interactive,
    );
    const deployments = await listNamedResources(
      deps,
      serverUrl,
      `/v1/apps/${encodeURIComponent(app.id)}/deployments`,
      flags.token,
      "deployments",
    );
    const deployment = await selectDeploymentForPlatform(
      deps,
      deployments,
      flags,
      platform,
      autoSelected,
      interactive,
    );
    platformConfigs[platform] = {
      app: app.name,
      deployment: deployment.name,
    };
  }
  const bundler = await selectBundler(
    deps,
    flags,
    projectRoot,
    autoSelected,
    interactive,
  );

  if (autoSelected.length > 0 && !flags.yes && !interactive) {
    throw new UsageError(
      `Init found safe defaults: ${autoSelected.join(", ")}. Re-run with --yes to write codemagic-patch.config.json, or pass explicit flags.`,
    );
  }

  const nextConfig: ProjectConfig = {
    ...existingConfig,
    apps: {
      ...(existingConfig.apps ?? {}),
      ...platformConfigs,
    },
    bundler,
    serverUrl,
    teamId: team.id,
  };
  if (platforms.length === 1) {
    nextConfig.platform = platforms[0];
  } else {
    delete nextConfig.platform;
  }
  delete nextConfig.app;
  delete nextConfig.deployment;
  delete nextConfig.team;
  await saveProjectConfig(projectRoot, nextConfig);

  if (interactive && deps.stderr !== undefined) {
    writeLine(deps.stderr, "Wrote codemagic-patch.config.json");
  }

  return {
    config: nextConfig,
    nextActions: [
      "cmpatch context",
      "cmpatch release-react --dry-run",
    ],
    projectRoot,
  };
}

function parseLinkFlags(args: string[]): LinkFlags {
  const flags: LinkFlags = { nonInteractive: false, yes: false };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      throw new UsageError(`Unexpected positional argument: ${token}`);
    }

    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const name = normalizeLinkFlag(rawName ?? "");
    if (name === "yes") {
      flags.yes = inlineValue === undefined || inlineValue === "true";
      continue;
    }
    if (name === "nonInteractive") {
      flags.nonInteractive = inlineValue === undefined || inlineValue === "true";
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`Flag --${rawName} requires a value`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    setLinkFlag(flags, name, value, rawName ?? "");
  }

  return flags;
}

function setLinkFlag(
  flags: LinkFlags,
  name: string,
  value: string,
  rawName: string,
): void {
  if (value.trim().length === 0) {
    throw new UsageError(`Init value cannot be empty: --${rawName}`);
  }

  switch (name) {
    case "app":
    case "appId":
    case "androidApp":
    case "androidAppId":
    case "androidDeployment":
    case "androidDeploymentId":
    case "bundler":
    case "deployment":
    case "deploymentId":
    case "iosApp":
    case "iosAppId":
    case "iosDeployment":
    case "iosDeploymentId":
    case "platform":
    case "projectRoot":
    case "serverUrl":
    case "team":
    case "teamId":
    case "token":
      flags[name] = value;
      return;
    default:
      // Echo the flag exactly as the user typed it (hyphenated), not the
      // camelCased internal name.
      throw new UsageError(`Unknown init flag: --${rawName}`);
  }
}

function normalizeLinkFlag(name: string): string {
  if (name === "server-url" || name === "team-id") {
    return normalizeConfigKey(name);
  }

  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function validatePlatformSpecificFlags(flags: LinkFlags): void {
  if (flags.platform === "ios" && hasAndroidSpecificFlags(flags)) {
    throw new UsageError(
      "Android-specific link flags cannot be combined with --platform ios. Use --platform android or remove the android-specific flags.",
    );
  }

  if (flags.platform === "android" && hasIosSpecificFlags(flags)) {
    throw new UsageError(
      "iOS-specific link flags cannot be combined with --platform android. Use --platform ios or remove the ios-specific flags.",
    );
  }
}

function validateMultiPlatformSelectors(
  flags: LinkFlags,
  platforms: NativePlatform[],
  interactive: boolean,
): void {
  if (platforms.length <= 1) {
    return;
  }

  if (flags.app !== undefined || flags.appId !== undefined) {
    throw new UsageError(
      "Multi-platform init needs platform-specific app selectors. Pass --ios-app and --android-app, or pass --platform ios|android to link one platform.",
    );
  }

  if (flags.deploymentId !== undefined) {
    throw new UsageError(
      "Multi-platform init cannot reuse one --deployment-id across multiple apps. Pass --ios-deployment-id and --android-deployment-id, or use a shared deployment name with --deployment.",
    );
  }

  if (interactive) {
    // Apps and deployments are chosen interactively per platform, so the
    // platform-specific selector flags are not required.
    return;
  }

  const missingAppSelectors = platforms.filter(
    (platform) =>
      platform === "ios"
        ? flags.iosApp === undefined && flags.iosAppId === undefined
        : flags.androidApp === undefined && flags.androidAppId === undefined,
  );
  if (missingAppSelectors.length > 0) {
    throw new UsageError(
      `Multi-platform init needs app selectors for ${missingAppSelectors.join(", ")}. Pass --ios-app and --android-app, or pass --platform ios|android to link one platform.`,
    );
  }
}

function hasIosSpecificFlags(flags: LinkFlags): boolean {
  return (
    flags.iosApp !== undefined ||
    flags.iosAppId !== undefined ||
    flags.iosDeployment !== undefined ||
    flags.iosDeploymentId !== undefined
  );
}

function hasAndroidSpecificFlags(flags: LinkFlags): boolean {
  return (
    flags.androidApp !== undefined ||
    flags.androidAppId !== undefined ||
    flags.androidDeployment !== undefined ||
    flags.androidDeploymentId !== undefined
  );
}

async function selectTeam(
  deps: CommandDeps,
  serverUrl: string,
  flags: LinkFlags,
  autoSelected: string[],
  interactive: boolean,
): Promise<NamedResource> {
  const teams = await listNamedResources(deps, serverUrl, "/v1/teams", flags.token, "teams");
  if (flags.teamId !== undefined) {
    return findByIdOrName(teams, flags.teamId, "team id");
  }

  if (flags.team !== undefined) {
    return findByIdOrName(teams, flags.team, "team");
  }

  if (interactive && deps.prompt !== undefined) {
    return promptResource(deps.prompt, "Select team", teams, "team");
  }

  return selectSingle(teams, "team", autoSelected);
}

async function selectLinkPlatforms(
  deps: CommandDeps,
  flags: LinkFlags,
  projectRoot: string,
  autoSelected: string[],
  interactive: boolean,
): Promise<NativePlatform[]> {
  if (flags.platform === "android" || flags.platform === "ios") {
    return [flags.platform];
  }

  if (flags.platform !== undefined) {
    throw new UsageError("--platform must be either ios or android");
  }

  const explicitPlatforms = platformsFromSpecificFlags(flags);
  if (explicitPlatforms.length > 0) {
    return explicitPlatforms;
  }

  const platforms = await detectNativePlatforms(deps, projectRoot);

  if (interactive && deps.prompt !== undefined) {
    return promptPlatforms(deps.prompt, platforms);
  }

  if (platforms.length === 0) {
    throw new UsageError(
      "Could not detect native platforms. Pass --platform ios or --platform android.",
    );
  }

  autoSelected.push(
    platforms.length === 1
      ? `platform ${platforms[0]}`
      : `platforms ${platforms.join(", ")}`,
  );
  return platforms;
}

function platformsFromSpecificFlags(flags: LinkFlags): NativePlatform[] {
  const platforms: NativePlatform[] = [];
  if (
    flags.iosApp !== undefined ||
    flags.iosAppId !== undefined ||
    flags.iosDeployment !== undefined ||
    flags.iosDeploymentId !== undefined
  ) {
    platforms.push("ios");
  }
  if (
    flags.androidApp !== undefined ||
    flags.androidAppId !== undefined ||
    flags.androidDeployment !== undefined ||
    flags.androidDeploymentId !== undefined
  ) {
    platforms.push("android");
  }

  return platforms;
}

async function selectAppForPlatform(
  deps: CommandDeps,
  apps: NamedResource[],
  flags: LinkFlags,
  platform: NativePlatform,
  autoSelected: string[],
  interactive: boolean,
): Promise<NamedResource> {
  const appId = platform === "ios" ? flags.iosAppId : flags.androidAppId;
  const app = platform === "ios" ? flags.iosApp : flags.androidApp;

  if (appId !== undefined) {
    return findByIdOrName(apps, appId, `${platform} app id`);
  }

  if (flags.appId !== undefined) {
    return findByIdOrName(apps, flags.appId, "app id");
  }

  if (app !== undefined) {
    return findByIdOrName(apps, app, `${platform} app`);
  }

  if (flags.app !== undefined) {
    return findByIdOrName(apps, flags.app, "app");
  }

  if (interactive && deps.prompt !== undefined) {
    return promptResource(deps.prompt, `Select app for ${platform}`, apps, "app");
  }

  return selectSingleForPlatform(
    apps,
    `${platform} app`,
    `--${platform}-app or --${platform}-app-id`,
    autoSelected,
  );
}

async function selectDeploymentForPlatform(
  deps: CommandDeps,
  deployments: NamedResource[],
  flags: LinkFlags,
  platform: NativePlatform,
  autoSelected: string[],
  interactive: boolean,
): Promise<NamedResource> {
  const deploymentId =
    platform === "ios" ? flags.iosDeploymentId : flags.androidDeploymentId;
  const deployment =
    platform === "ios" ? flags.iosDeployment : flags.androidDeployment;

  if (deploymentId !== undefined) {
    return findByIdOrName(deployments, deploymentId, `${platform} deployment id`);
  }

  if (flags.deploymentId !== undefined) {
    return findByIdOrName(deployments, flags.deploymentId, "deployment id");
  }

  if (deployment !== undefined) {
    return findByIdOrName(deployments, deployment, `${platform} deployment`);
  }

  if (flags.deployment !== undefined) {
    return findByIdOrName(deployments, flags.deployment, "deployment");
  }

  if (interactive && deps.prompt !== undefined) {
    return promptResource(
      deps.prompt,
      `Select deployment for ${platform}`,
      deployments,
      "deployment",
    );
  }

  return selectSingleForPlatform(
    deployments,
    `${platform} deployment`,
    `--${platform}-deployment or --${platform}-deployment-id`,
    autoSelected,
  );
}

async function selectBundler(
  deps: CommandDeps,
  flags: LinkFlags,
  projectRoot: string,
  autoSelected: string[],
  interactive: boolean,
): Promise<"expo" | "metro"> {
  if (flags.bundler === "metro" || flags.bundler === "expo") {
    return flags.bundler;
  }

  if (flags.bundler !== undefined && flags.bundler !== "auto") {
    throw new UsageError("--bundler must be one of auto, metro, or expo");
  }

  const detected = await detectProjectBundler(deps, projectRoot);

  if (detected.kind === "repack" || detected.kind === "rock") {
    throw new UsageError(
      `Detected ${formatBundlerName(detected.kind)} project, but init can only persist Metro or Expo bundlers until release-react supports that publish path.`,
    );
  }

  if (interactive && deps.prompt !== undefined) {
    return promptBundler(deps.prompt, detected.kind);
  }

  autoSelected.push(`bundler ${detected.kind}`);
  return detected.kind;
}

async function promptServerUrl(
  prompt: PromptFn,
  initial: string | undefined,
): Promise<string> {
  const value = await prompt({ initial, message: "Server URL", type: "text" });
  return String(value).trim();
}

async function promptResource(
  prompt: PromptFn,
  message: string,
  resources: NamedResource[],
  label: "app" | "deployment" | "team",
): Promise<NamedResource> {
  if (resources.length === 0) {
    throw new UsageError(`No ${label}s are available. Create one first.`);
  }

  const value = await prompt({
    choices: resources.map((resource) => ({
      title: resource.name,
      value: resource.id,
    })),
    message,
    type: "select",
  });
  const selectedId = Array.isArray(value) ? value[0] : value;
  const chosen = resources.find((resource) => resource.id === selectedId);
  if (chosen === undefined) {
    throw new UsageError(`Invalid ${label} selection.`);
  }

  return chosen;
}

async function promptPlatforms(
  prompt: PromptFn,
  detected: NativePlatform[],
): Promise<NativePlatform[]> {
  const value = await prompt({
    choices: (["ios", "android"] as const).map((platform) => ({
      selected: detected.includes(platform),
      title: platform,
      value: platform,
    })),
    message: "Select platforms",
    min: 1,
    type: "multiselect",
  });
  const selected = Array.isArray(value) ? value : [value];
  const platforms = selected.filter(
    (platform): platform is NativePlatform =>
      platform === "ios" || platform === "android",
  );
  if (platforms.length === 0) {
    throw new UsageError("Select at least one platform.");
  }

  return platforms;
}

async function promptBundler(
  prompt: PromptFn,
  detected: "expo" | "metro",
): Promise<"expo" | "metro"> {
  const value = await prompt({
    choices: [
      { title: "metro", value: "metro" },
      { title: "expo", value: "expo" },
    ],
    initial: detected === "expo" ? 1 : 0,
    message: "Select bundler",
    type: "select",
  });

  return value === "expo" ? "expo" : "metro";
}

async function listNamedResources(
  deps: CommandDeps,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
  wrapperKey: "apps" | "deployments" | "teams",
): Promise<NamedResource[]> {
  const response = await authenticatedRequest(deps, {
    init: { method: "GET" },
    serverUrl,
    token,
    url: buildApiUrl(serverUrl, pathname),
  });

  if (!isRecord(response) || !Array.isArray(response[wrapperKey])) {
    throw new UsageError(`Malformed ${wrapperKey} response`);
  }

  return response[wrapperKey].map((resource) => {
    if (
      !isRecord(resource) ||
      typeof resource.id !== "string" ||
      typeof resource.name !== "string"
    ) {
      throw new UsageError(`Malformed ${wrapperKey} response`);
    }

    return { id: resource.id, name: resource.name };
  });
}

function selectSingle(
  resources: NamedResource[],
  label: "app" | "deployment" | "team",
  autoSelected: string[],
): NamedResource {
  if (resources.length === 0) {
    throw new UsageError(`No ${label}s are available. Create one first.`);
  }

  if (resources.length > 1) {
    throw new UsageError(
      `Multiple ${label}s are available. Pass --${label} or --${label}-id. Available ${label}s: ${formatNamedResources(resources)}`,
    );
  }

  autoSelected.push(`${label} ${resources[0]!.name}`);
  return resources[0]!;
}

function selectSingleForPlatform(
  resources: NamedResource[],
  label: string,
  selectorHint: string,
  autoSelected: string[],
): NamedResource {
  if (resources.length === 0) {
    throw new UsageError(`No ${label}s are available. Create one first.`);
  }

  if (resources.length > 1) {
    throw new UsageError(
      `Multiple ${label}s are available. Pass ${selectorHint}. Available values: ${formatNamedResources(resources)}`,
    );
  }

  autoSelected.push(`${label} ${resources[0]!.name}`);
  return resources[0]!;
}

function findByIdOrName(
  resources: NamedResource[],
  value: string,
  label: string,
): NamedResource {
  const matches = resources.filter(
    (resource) => resource.id === value || resource.name === value,
  );

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new UsageError(`${label} "${value}" is ambiguous: ${formatNamedResources(matches)}`);
  }

  throw new UsageError(`${label} "${value}" was not found.`);
}

function formatNamedResources(resources: NamedResource[]): string {
  return resources.map((resource) => `${resource.name} (${resource.id})`).join(", ");
}
