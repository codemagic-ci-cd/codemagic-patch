import type { CliConfig, ProjectConfig } from "./configStore";

type ConfigSource = "env" | "project" | "user";

type EffectiveValue = {
  source: ConfigSource;
  value: string;
};

type ResolveEffectiveContextOptions = {
  platform?: string;
};

export type EffectiveContext = {
  app?: EffectiveValue;
  bundler?: EffectiveValue;
  deployment?: EffectiveValue;
  platform?: EffectiveValue;
  projectRoot: string;
  serverUrl?: EffectiveValue;
  team?: EffectiveValue;
  teamId?: EffectiveValue;
};

export function resolveEffectiveContext(
  env: Record<string, string | undefined>,
  userConfig: CliConfig,
  projectConfig: ProjectConfig,
  projectRoot: string,
  options: ResolveEffectiveContextOptions = {},
): EffectiveContext {
  const serverUrl = firstEffectiveValue([
    ["env", resolveOptionalString(env.CODEMAGIC_PATCH_SERVER_URL)],
    ["project", projectConfig.serverUrl],
    ["user", userConfig.serverUrl],
  ]);
  const teamSelector = firstEffectiveTeamSelector(env, userConfig, projectConfig);
  const platform = resolveOptionalString(projectConfig.platform);
  const requestedPlatform =
    normalizeNativePlatform(options.platform) ?? normalizeNativePlatform(platform);
  const platformConfig =
    requestedPlatform === undefined
      ? undefined
      : projectConfig.apps?.[requestedPlatform];
  const app = platformConfig?.app ?? projectConfig.app;
  const deployment = platformConfig?.deployment ?? projectConfig.deployment;

  return {
    ...(app !== undefined
      ? { app: { source: "project" as const, value: app } }
      : {}),
    ...(projectConfig.bundler !== undefined
      ? { bundler: { source: "project" as const, value: projectConfig.bundler } }
      : {}),
    ...(deployment !== undefined
      ? {
          deployment: {
            source: "project" as const,
            value: deployment,
          },
        }
      : {}),
    ...(platform !== undefined
      ? { platform: { source: "project" as const, value: platform } }
      : {}),
    projectRoot,
    ...(serverUrl !== undefined ? { serverUrl } : {}),
    ...(teamSelector !== undefined ? teamSelector : {}),
  };
}

export function resolveProjectRoot(argv: string[]): string {
  const projectRoot = optionValue(argv, "--project-root");
  return projectRoot ?? process.cwd();
}

export function isProjectRootOnlyCommand(argv: string[]): boolean {
  if (argv.length === 0) {
    return true;
  }

  if (argv.length === 1) {
    const value = argv[0]?.slice("--project-root=".length);
    return (argv[0]?.startsWith("--project-root=") ?? false) && value !== "";
  }

  return (
    argv.length === 2 &&
    argv[0] === "--project-root" &&
    argv[1] !== "" &&
    !argv[1]?.startsWith("--")
  );
}

function firstEffectiveTeamSelector(
  env: Record<string, string | undefined>,
  userConfig: CliConfig,
  projectConfig: ProjectConfig,
): Pick<EffectiveContext, "team" | "teamId"> | undefined {
  const envTeamId = resolveOptionalString(env.CODEMAGIC_PATCH_TEAM_ID);
  if (envTeamId !== undefined) {
    return { teamId: { source: "env", value: envTeamId } };
  }

  const envTeam = resolveOptionalString(env.CODEMAGIC_PATCH_TEAM);
  if (envTeam !== undefined) {
    return { team: { source: "env", value: envTeam } };
  }

  if (projectConfig.teamId !== undefined) {
    return { teamId: { source: "project", value: projectConfig.teamId } };
  }

  if (projectConfig.team !== undefined) {
    return { team: { source: "project", value: projectConfig.team } };
  }

  if (userConfig.teamId !== undefined) {
    return { teamId: { source: "user", value: userConfig.teamId } };
  }

  if (userConfig.team !== undefined) {
    return { team: { source: "user", value: userConfig.team } };
  }

  return undefined;
}

function firstEffectiveValue(
  candidates: Array<[ConfigSource, string | undefined]>,
): EffectiveValue | undefined {
  for (const [source, value] of candidates) {
    if (value !== undefined) {
      return { source, value };
    }
  }

  return undefined;
}

function optionValue(argv: string[], option: string): string | undefined {
  const equalsPrefix = `${option}=`;
  const equalsMatch = argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsMatch !== undefined) {
    return equalsMatch.slice(equalsPrefix.length);
  }

  const index = argv.indexOf(option);
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNativePlatform(value: string | undefined): "android" | "ios" | undefined {
  if (value === "android" || value === "ios") {
    return value;
  }

  return undefined;
}
