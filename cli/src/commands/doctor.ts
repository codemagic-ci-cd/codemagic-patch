import { resolve } from "node:path";

import { PRODUCT_NAME } from "../branding";
import type { DoctorCommand } from "../commandTypes";
import {
  loadCliConfig,
  loadProjectConfig,
  resolveConfigPath,
  type CliConfig,
  type ProjectConfig,
} from "../configStore";
import {
  loadStoredCredential,
  resolveCredentialStorePath,
} from "../credentialStore";
import {
  buildDownloadUrl,
  fetchDeliveryJson,
  type DeliveryJsonResponse,
} from "../delivery";
import { request } from "../http";
import { resolveEffectiveContext, type EffectiveContext } from "../localContext";
import { isRecord } from "../output";
import { HttpProblemError } from "../problem-details";
import {
  detectNativePlatforms,
  detectProjectBundler,
  formatBundlerName,
  hasNativeProjectDirectoryForPlatform,
  type NativePlatform,
} from "../projectAnalysis";
import {
  isPathSafeBinaryVersion,
  resolveTargetBinaryVersion,
} from "../targetBinaryVersion";
import {
  buildApiUrl,
  normalizeBearerToken,
  UsageError,
  type CommandDeps,
} from "./shared";

export type DoctorCheckStatus = "fail" | "pass" | "skip" | "warn";

export type DoctorCheckResult = {
  advice?: string[];
  detail?: string;
  evidence?: Record<string, unknown>;
  id: string;
  issues?: string[];
  nextCommands?: string[];
  status: DoctorCheckStatus;
  title: string;
};

export type DoctorCheckGroup = {
  checks: DoctorCheckResult[];
  id: string;
  title: string;
};

export type DoctorResult = {
  command: "doctor";
  exitCode: 0 | 1;
  groups: DoctorCheckGroup[];
  summary: {
    fail: number;
    pass: number;
    skip: number;
    total: number;
    warn: number;
  };
};

type AuthProbeSource =
  | {
      kind: "flag" | "env" | "stored";
      token: string;
    }
  | {
      kind: "none";
    }
  | {
      detail: string;
      kind: "stored-invalid";
    };

type NamedResource = {
  id: string;
  name: string;
};

type DeploymentResource = NamedResource & {
  deploymentKey?: string;
};

type DoctorExecutionState = {
  appId?: string;
  downloadBaseUrl?: string;
  deployment?: DeploymentResource;
  deploymentId?: string;
  platform?: NativePlatform;
  serverUrl?: string;
  targetBinaryVersion?: string;
  teamId?: string;
  teams?: NamedResource[];
  token?: string;
};

type DoctorPlatformPlan = {
  command: DoctorCommand;
  platform: NativePlatform;
};

export async function executeDoctor(
  command: DoctorCommand,
  deps: CommandDeps,
): Promise<DoctorResult> {
  const projectRoot = resolve(command.projectRoot);
  const projectRootCheck = await checkProjectRoot(deps, command.projectRoot);
  const userConfig = await loadUserConfigForDoctor(deps);
  const projectConfig = await loadProjectConfigForDoctor(projectRoot);
  const credentialStoreCheck = await checkCredentialStore(deps);
  const effectiveContext = resolveEffectiveContext(
    deps.env,
    userConfig.config,
    projectConfig.config,
    projectRoot,
    { platform: command.platform },
  );
  const conflictCheck = checkDefaultConflicts(
    userConfig.config,
    projectConfig.config,
  );
  const contextCheck = checkEffectiveContext(effectiveContext, command);
  const contextGroup: DoctorCheckGroup = {
    checks: [
      commandShapeCheck(command),
      projectRootCheck,
      userConfig.check,
      projectConfig.check,
      credentialStoreCheck,
      conflictCheck,
      contextCheck,
    ],
    id: "context",
    title: "Context",
  };
  const platformPlans = resolveDoctorPlatformPlans(command, projectConfig.config);
  if (platformPlans.length > 0) {
    const commonState: DoctorExecutionState = {};
    const controlPlaneChecks = await runControlPlaneBaseChecks(
      deps,
      command,
      commonState,
    );
    const bundlerCheck = await checkBundler(deps, command, {
      projectRoot,
      projectRootExists: projectRootCheck.status === "pass",
    });
    const commonGroups: DoctorCheckGroup[] = [
      contextGroup,
      {
        checks: controlPlaneChecks,
        id: "control-plane",
        title: "Control Plane",
      },
      {
        checks: [bundlerCheck],
        id: "bundler",
        title: "Bundler",
      },
    ];
    const groups: DoctorCheckGroup[] = [...commonGroups];

    for (const plan of platformPlans) {
      const state = cloneDoctorExecutionState(commonState);
      const targetChecks = await runControlPlaneTargetChecks(
        deps,
        plan.command,
        state,
      );
      const nativeChecks = await runNativeChecks(deps, plan.command, {
        projectRoot,
        projectRootExists: projectRootCheck.status === "pass",
        state,
      });
      const downloadChecks = await runDownloadChecks(deps, plan.command, state);
      const platformGroups: DoctorCheckGroup[] = [
        {
          checks: targetChecks,
          id: `control-plane-${plan.platform}`,
          title: `Control Plane (${plan.platform})`,
        },
        {
          checks: nativeChecks,
          id: `native-${plan.platform}`,
          title: `Native Project (${plan.platform})`,
        },
        {
          checks: downloadChecks,
          id: `download-${plan.platform}`,
          title: `Manifest And Download (${plan.platform})`,
        },
      ];

      groups.push(...platformGroups, {
        checks: runDeviceDebugHandoffChecks(plan.command, state, [
          ...commonGroups,
          ...platformGroups,
        ]),
        id: `device-${plan.platform}`,
        title: `Device Debugging (${plan.platform})`,
      });
    }

    return createDoctorResult(groups);
  }

  const state: DoctorExecutionState = {};
  const controlPlaneChecks = await runControlPlaneChecks(deps, command, state);
  const nativeChecks = await runNativeChecks(deps, command, {
    projectRoot,
    projectRootExists: projectRootCheck.status === "pass",
    state,
  });
  const bundlerCheck = await checkBundler(deps, command, {
    projectRoot,
    projectRootExists: projectRootCheck.status === "pass",
  });
  const downloadChecks = await runDownloadChecks(deps, command, state);
  const groups: DoctorCheckGroup[] = [
    contextGroup,
    {
      checks: controlPlaneChecks,
      id: "control-plane",
      title: "Control Plane",
    },
    {
      checks: nativeChecks,
      id: "native",
      title: "Native Project",
    },
    {
      checks: [bundlerCheck],
      id: "bundler",
      title: "Bundler",
    },
    {
      checks: downloadChecks,
      id: "download",
      title: "Manifest And Download",
    },
  ];

  groups.push({
    checks: runDeviceDebugHandoffChecks(command, state, groups),
    id: "device",
    title: "Device Debugging",
  });

  return createDoctorResult(groups);
}

function resolveDoctorPlatformPlans(
  command: DoctorCommand,
  projectConfig: ProjectConfig,
): DoctorPlatformPlan[] {
  if (hasExplicitDoctorTarget(command)) {
    return [];
  }

  const apps = projectConfig.apps;
  if (apps === undefined) {
    return [];
  }

  return (["ios", "android"] as const)
    .flatMap((platform): DoctorPlatformPlan[] => {
      const config = apps[platform];
      if (config === undefined) {
        return [];
      }

      return [
        {
          command: {
            ...command,
            ...(config.app !== undefined ? { app: config.app } : {}),
            ...(config.deployment !== undefined
              ? { deployment: config.deployment }
              : {}),
            platform,
          },
          platform,
        },
      ];
    });
}

function hasExplicitDoctorTarget(command: DoctorCommand): boolean {
  return (
    command.app !== undefined ||
    command.appId !== undefined ||
    command.deployment !== undefined ||
    command.deploymentId !== undefined ||
    command.deploymentKey !== undefined ||
    command.platform !== undefined
  );
}

function cloneDoctorExecutionState(
  state: DoctorExecutionState,
): DoctorExecutionState {
  return {
    ...(state.downloadBaseUrl !== undefined ? { downloadBaseUrl: state.downloadBaseUrl } : {}),
    ...(state.serverUrl !== undefined ? { serverUrl: state.serverUrl } : {}),
    ...(state.targetBinaryVersion !== undefined
      ? { targetBinaryVersion: state.targetBinaryVersion }
      : {}),
    ...(state.teamId !== undefined ? { teamId: state.teamId } : {}),
    ...(state.teams !== undefined ? { teams: state.teams } : {}),
    ...(state.token !== undefined ? { token: state.token } : {}),
  };
}

function runDeviceDebugHandoffChecks(
  command: DoctorCommand,
  state: DoctorExecutionState,
  priorGroups: DoctorCheckGroup[],
): DoctorCheckResult[] {
  const blockingChecks = priorGroups
    .flatMap((group) => group.checks)
    .filter(isDeviceDebugHandoffBlockedBy);

  if (blockingChecks.length > 0) {
    return [
      {
        detail: "Device log handoff waits for local, control-plane, and download checks to be clean.",
        evidence: {
          blockingChecks: blockingChecks.map((check) => check.id),
        },
        id: "device-debug-handoff",
        status: "skip",
        title: "Device debug handoff",
      },
    ];
  }

  const platform = state.platform ?? command.platform;
  if (platform === undefined) {
    return [
      {
        detail: "Device log handoff needs a resolved platform.",
        id: "device-debug-handoff",
        status: "skip",
        title: "Device debug handoff",
      },
    ];
  }

  return [
    {
      detail: "No setup issue was found before the device-side boundary. If updates still do not appear, collect device logs next.",
      id: "device-debug-handoff",
      advice: [
        "Run the debug command while reproducing an update check on the device or simulator.",
      ],
      nextCommands: [`cmpatch debug ${platform}`],
      status: "warn",
      title: "Device debug handoff",
    },
  ];
}

function isDeviceDebugHandoffBlockedBy(check: DoctorCheckResult): boolean {
  if (check.status === "fail" || check.status === "warn") {
    return true;
  }

  if (isActionableSkip(check)) {
    return true;
  }

  return check.status === "skip" && check.id !== "primary-manifest";
}

function commandShapeCheck(command: DoctorCommand): DoctorCheckResult {
  return {
    detail: "The doctor command parsed successfully.",
    evidence: {
      receivedInputs: summarizeReceivedInputs(command),
    },
    id: "command",
    status: "pass",
    title: "Command shape",
  };
}

async function checkProjectRoot(
  deps: Pick<CommandDeps, "stat">,
  inputPath: string,
): Promise<DoctorCheckResult> {
  const projectRoot = resolve(inputPath);

  try {
    const stats = await deps.stat(projectRoot);
    if (!stats.isDirectory()) {
      return {
        detail: `${projectRoot} is not a directory.`,
        evidence: { projectRoot },
        id: "project-root",
        issues: ["The configured project root is not a directory."],
        advice: ["Pass `--project-root <path>` from the app repository root."],
        status: "fail",
        title: "Project root",
      };
    }

    return {
      detail: `Using project root ${projectRoot}.`,
      evidence: { projectRoot },
      id: "project-root",
      status: "pass",
      title: "Project root",
    };
  } catch (error) {
    return {
      detail: `${projectRoot} was not found${formatErrorSuffix(error)}.`,
      evidence: { projectRoot },
      id: "project-root",
      issues: ["The configured project root could not be read."],
      advice: ["Pass `--project-root <path>` from the app repository root."],
      status: "fail",
      title: "Project root",
    };
  }
}

async function loadUserConfigForDoctor(
  deps: Pick<CommandDeps, "env" | "stat">,
): Promise<{ check: DoctorCheckResult; config: CliConfig }> {
  const path = resolveConfigPath(deps.env);
  const exists = await isFile(deps, path);

  try {
    const config = await loadCliConfig({ env: deps.env });
    return {
      check: {
        detail: exists
          ? `Loaded user config from ${path}.`
          : `No user config file found at ${path}.`,
        evidence: {
          path,
          present: exists,
          keys: Object.keys(config).sort(),
        },
        id: "user-config",
        status: "pass",
        title: "User config",
      },
      config,
    };
  } catch (error) {
    return {
      check: {
        detail: `Could not read user config at ${path}${formatErrorSuffix(error)}.`,
        evidence: { path, present: exists },
        id: "user-config",
        issues: [`The user config file is not valid ${PRODUCT_NAME} config JSON.`],
        advice: ["Fix or remove the user config file, then rerun `cmpatch doctor`."],
        status: "fail",
        title: "User config",
      },
      config: {},
    };
  }
}

async function loadProjectConfigForDoctor(
  projectRoot: string,
): Promise<{ check: DoctorCheckResult; config: ProjectConfig }> {
  try {
    const config = await loadProjectConfig(projectRoot);
    return {
      check: {
        detail: "Loaded project config sources that are present and valid.",
        evidence: {
          keys: Object.keys(config).sort(),
          projectRoot,
        },
        id: "project-config",
        status: "pass",
        title: "Project config",
      },
      config,
    };
  } catch (error) {
    return {
      check: {
        detail: `Could not read project config for ${projectRoot}${formatErrorSuffix(error)}.`,
        evidence: { projectRoot },
        id: "project-config",
        issues: [
          "The project config file or package.json codemagicPatch block is invalid.",
        ],
        advice: [
          "Fix codemagic-patch.config.json or the package.json codemagicPatch block, then rerun `cmpatch doctor`.",
        ],
        status: "fail",
        title: "Project config",
      },
      config: {},
    };
  }
}

async function checkCredentialStore(
  deps: Pick<CommandDeps, "env" | "readFile" | "stat">,
): Promise<DoctorCheckResult> {
  const path = resolveCredentialStorePath(deps.env);
  const exists = await isFile(deps, path);

  if (!exists) {
    return {
      detail: `No stored credential file found at ${path}.`,
      evidence: {
        path,
        present: false,
      },
      id: "credential-store",
      status: "pass",
      title: "Stored credentials",
    };
  }

  try {
    const raw = await deps.readFile(path);
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    const validation = validateCredentialStoreFile(parsed);

    if (!validation.ok) {
      return {
        detail: `Stored credential file is invalid: ${validation.error}.`,
        evidence: {
          path,
          present: true,
        },
        id: "credential-store",
        issues: ["Stored credentials cannot be read safely."],
        advice: ["Run `cmpatch login` again after fixing or removing the credential file."],
        status: "fail",
        title: "Stored credentials",
      };
    }

    return {
      detail: `Stored credential file is readable at ${path}.`,
      evidence: {
        path,
        present: true,
        serverCount: validation.serverCount,
      },
      id: "credential-store",
      status: "pass",
      title: "Stored credentials",
    };
  } catch (error) {
    return {
      detail: `Could not read stored credentials at ${path}${formatErrorSuffix(error)}.`,
      evidence: { path, present: true },
      id: "credential-store",
      issues: ["Stored credentials cannot be read safely."],
      advice: ["Run `cmpatch login` again after fixing or removing the credential file."],
      status: "fail",
      title: "Stored credentials",
    };
  }
}

function checkDefaultConflicts(
  userConfig: CliConfig,
  projectConfig: ProjectConfig,
): DoctorCheckResult {
  const issues = [
    ...(userConfig.team !== undefined && userConfig.teamId !== undefined
      ? ["User config contains both team and teamId."]
      : []),
    ...(projectConfig.team !== undefined && projectConfig.teamId !== undefined
      ? ["Project config contains both team and teamId."]
      : []),
  ];

  if (issues.length > 0) {
    return {
      detail: "Conflicting team defaults were found.",
      id: "default-conflicts",
      issues,
      advice: ["Keep only one of team or team-id in each config scope."],
      nextCommands: ["cmpatch context"],
      status: "fail",
      title: "Default conflicts",
    };
  }

  return {
    detail: "No mutually exclusive local defaults were found.",
    id: "default-conflicts",
    status: "pass",
    title: "Default conflicts",
  };
}

function checkEffectiveContext(
  context: EffectiveContext,
  command: DoctorCommand,
): DoctorCheckResult {
  const evidence = summarizeEffectiveContext(context);

  if (context.serverUrl === undefined && command.serverUrl === undefined) {
    return {
      detail: "No server URL was resolved from flags, env, project config, or user config.",
      evidence,
      id: "effective-context",
      issues: ["Remote checks cannot run until a server URL is configured."],
      advice: ["Run `cmpatch config set server-url <url>`."],
      nextCommands: ["cmpatch context"],
      status: "warn",
      title: "Effective context",
    };
  }

  return {
    detail: "Resolved effective local context.",
    evidence: {
      ...evidence,
      ...(context.serverUrl === undefined && command.serverUrl !== undefined
        ? {
            serverUrl: {
              source: "command",
              value: command.serverUrl,
            },
          }
        : {}),
    },
    id: "effective-context",
    nextCommands: ["cmpatch context"],
    status: "pass",
    title: "Effective context",
  };
}

async function runControlPlaneChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult[]> {
  return [
    ...(await runControlPlaneBaseChecks(deps, command, state)),
    ...(await runControlPlaneTargetChecks(deps, command, state)),
  ];
}

async function runControlPlaneBaseChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult[]> {
  const serverUrlCheck = checkServerUrl(command.serverUrl, state);
  const healthCheck = await checkServerHealth(deps, state);
  const authCheck = await checkControlPlaneAuth(deps, command, state);
  const teamCheck = await checkTeamResolution(command, state);

  return [
    serverUrlCheck,
    healthCheck,
    authCheck,
    teamCheck,
  ];
}

async function runControlPlaneTargetChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult[]> {
  const appCheck = await checkAppResolution(deps, command, state);
  const deploymentCheck = await checkDeploymentResolution(deps, command, state);
  const deploymentKeyCheck = checkDeploymentKey(command, state);

  return [
    appCheck,
    deploymentCheck,
    deploymentKeyCheck,
  ];
}

function checkServerUrl(
  serverUrl: string | undefined,
  state: DoctorExecutionState,
): DoctorCheckResult {
  if (serverUrl === undefined) {
    return {
      detail: "Control-plane checks need a server URL.",
      id: "server-url",
      advice: ["Run `cmpatch config set server-url <url>`."],
      status: "skip",
      title: "Server URL",
    };
  }

  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        detail: `${serverUrl} does not use http or https.`,
        evidence: { serverUrl },
        id: "server-url",
        issues: ["The configured server URL has an unsupported protocol."],
        advice: [`Set a ${PRODUCT_NAME} API URL that starts with http:// or https://.`],
        status: "fail",
        title: "Server URL",
      };
    }

    state.serverUrl = serverUrl;
    return {
      detail: `Using control-plane server ${serverUrl}.`,
      evidence: {
        origin: parsed.origin,
        serverUrl,
      },
      id: "server-url",
      status: "pass",
      title: "Server URL",
    };
  } catch (error) {
    return {
      detail: `${serverUrl} is not a valid URL${formatErrorSuffix(error)}.`,
      evidence: { serverUrl },
      id: "server-url",
      issues: ["The configured server URL cannot be parsed."],
      advice: ["Check `CODEMAGIC_PATCH_SERVER_URL` or run `cmpatch config set server-url <url>`."],
      status: "fail",
      title: "Server URL",
    };
  }
}

async function checkServerHealth(
  deps: Pick<CommandDeps, "fetch">,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined) {
    return {
      detail: "Server health check needs a valid server URL.",
      id: "server-health",
      status: "skip",
      title: "Server health",
    };
  }

  // Probe readiness, not liveness: /health returns ok even when the database is
  // down, so it can't tell a healthy server from one that boots but can't serve.
  // /health/ready is 200 only when the DB check passes, 503 otherwise.
  const url = buildApiUrl(state.serverUrl, "/health/ready");

  let response: Response;
  try {
    response = await deps.fetch(url, { method: "GET" });
  } catch (error) {
    return {
      detail: formatRequestError(error),
      evidence: { url },
      id: "server-health",
      issues: ["The server readiness endpoint did not respond."],
      advice: ["Check the configured server URL and network access."],
      status: "fail",
      title: "Server health",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok) {
    return {
      detail: "Server is ready (control plane and database reachable).",
      evidence: {
        response: summarizeHealthResponse(body),
        url,
      },
      id: "server-health",
      status: "pass",
      title: "Server health",
    };
  }

  if (response.status === 503) {
    return {
      detail: "Server is running but not ready; its database readiness check failed.",
      evidence: {
        ...(isRecord(body) && Array.isArray(body.checks)
          ? { checks: body.checks }
          : {}),
        url,
      },
      id: "server-health",
      issues: [
        "The server is up but its readiness check is failing; the database may be unreachable.",
      ],
      advice: [
        "Check the database container and the server logs (e.g. docker compose logs postgres server).",
      ],
      status: "fail",
      title: "Server health",
    };
  }

  return {
    detail: `Server readiness endpoint responded with HTTP ${response.status}.`,
    evidence: { url },
    id: "server-health",
    issues: ["The server readiness endpoint did not respond successfully."],
    advice: ["Check the configured server URL and the server logs."],
    status: "fail",
    title: "Server health",
  };
}

async function checkControlPlaneAuth(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined) {
    return {
      detail: "Auth check needs a valid server URL.",
      id: "auth",
      status: "skip",
      title: "Authentication",
    };
  }

  const authSource = await resolveDoctorAuthSource(deps, command, state.serverUrl);
  if (authSource.kind === "stored-invalid") {
    return {
      detail: authSource.detail,
      evidence: { authSource: "stored" },
      id: "auth",
      issues: ["Stored credentials are present but not usable."],
      advice: ["Run `cmpatch login --server-url <url>` after fixing stored credentials."],
      status: "fail",
      title: "Authentication",
    };
  }

  if (authSource.kind === "none") {
    return {
      detail: "No token or stored session was found for authenticated checks.",
      evidence: { authSource: "none" },
      id: "auth",
      issues: ["Authenticated control-plane routes cannot be checked."],
      advice: [
        state.serverUrl === undefined
          ? "Configure a server URL before signing in."
          : `Run \`cmpatch login --server-url ${state.serverUrl}\` or pass --token/CODEMAGIC_PATCH_TOKEN.`,
      ],
      status: "fail",
      title: "Authentication",
    };
  }

  try {
    const response = await doctorGet(deps, state.serverUrl, "/v1/teams", authSource.token);
    const teams = parseNamedResourceList(response, "teams");
    state.teams = teams;
    state.token = authSource.token;

    return {
      detail: "Authenticated control-plane request succeeded.",
      evidence: {
        authSource: authSource.kind,
        teamCount: teams.length,
      },
      id: "auth",
      status: "pass",
      title: "Authentication",
    };
  } catch (error) {
    return {
      detail: formatRequestError(error),
      evidence: { authSource: authSource.kind },
      id: "auth",
      issues: [formatAuthFailureIssue(authSource.kind, error)],
      advice: [
        authSource.kind === "stored"
          ? `Run \`cmpatch login --server-url ${state.serverUrl}\` again.`
          : "Check the token passed with --token or CODEMAGIC_PATCH_TOKEN.",
      ],
      status: "fail",
      title: "Authentication",
    };
  }
}

async function checkTeamResolution(
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined || state.teams === undefined) {
    return {
      detail: "Team resolution needs a successful authenticated teams request.",
      id: "team",
      status: "skip",
      title: "Team",
    };
  }

  if (command.teamId !== undefined) {
    state.teamId = command.teamId;
    return {
      detail: "Using explicit team id.",
      evidence: { teamId: command.teamId },
      id: "team",
      status: "pass",
      title: "Team",
    };
  }

  if (command.team !== undefined) {
    const match = matchNamedResource(state.teams, command.team, "Team");
    if (match.kind === "matched") {
      state.teamId = match.resource.id;
      return {
        detail: `Resolved team ${command.team}.`,
        evidence: {
          teamId: match.resource.id,
          teamName: match.resource.name,
        },
        id: "team",
        status: "pass",
        title: "Team",
      };
    }

    return resourceMatchFailure("team", command.team, match);
  }

  if (state.teams.length === 1) {
    state.teamId = state.teams[0]!.id;
    return {
      detail: `Auto-selected the only visible team ${state.teams[0]!.name}.`,
      evidence: {
        teamId: state.teams[0]!.id,
        teamName: state.teams[0]!.name,
      },
      id: "team",
      status: "pass",
      title: "Team",
    };
  }

  if (state.teams.length === 0) {
    return {
      detail: "No teams are visible to the current principal.",
      id: "team",
      issues: ["Team resolution failed because no teams are available."],
      advice: [
        "Ask an admin to confirm the server provisioned its default team (default-team), or sign in with an account that can access it.",
      ],
      status: "fail",
      title: "Team",
    };
  }

  return {
    detail: "Multiple teams are visible; this build expects a single default team.",
    evidence: {
      teams: state.teams.map((team) => ({ id: team.id, name: team.name })),
    },
    id: "team",
    issues: ["Team resolution is ambiguous."],
    advice: [
      "Ask an admin to verify the server is provisioned with a single team (default-team).",
    ],
    status: "fail",
    title: "Team",
  };
}

async function checkAppResolution(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined || state.token === undefined) {
    return {
      detail: "App resolution needs a successful authenticated request.",
      id: "app",
      status: "skip",
      title: "App",
    };
  }

  if (command.appId !== undefined) {
    state.appId = command.appId;
    return {
      detail: "Using explicit app id.",
      evidence: { appId: command.appId },
      id: "app",
      status: "pass",
      title: "App",
    };
  }

  if (command.app === undefined) {
    return {
      detail: "No app selector was provided.",
      id: "app",
      advice: ["Pass --app or --app-id, or update codemagic-patch.config.json."],
      status: "skip",
      title: "App",
    };
  }

  if (state.teamId === undefined) {
    return {
      detail: "App resolution needs a resolved team.",
      id: "app",
      status: "skip",
      title: "App",
    };
  }

  try {
    const response = await doctorGet(
      deps,
      state.serverUrl,
      `/v1/teams/${encodeURIComponent(state.teamId)}/apps`,
      state.token,
    );
    const apps = parseNamedResourceList(response, "apps");
    const match = matchNamedResource(apps, command.app, "App");

    if (match.kind !== "matched") {
      return resourceMatchFailure("app", command.app, match);
    }

    state.appId = match.resource.id;
    return {
      detail: `Resolved app ${command.app}.`,
      evidence: {
        appId: match.resource.id,
        appName: match.resource.name,
        teamId: state.teamId,
      },
      id: "app",
      status: "pass",
      title: "App",
    };
  } catch (error) {
    return {
      detail: formatRequestError(error),
      id: "app",
      issues: ["App resolution request failed."],
      advice: ["Run `cmpatch app list` with the same team selector."],
      status: "fail",
      title: "App",
    };
  }
}

async function checkDeploymentResolution(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined || state.token === undefined) {
    return {
      detail: "Deployment resolution needs a successful authenticated request.",
      id: "deployment",
      status: "skip",
      title: "Deployment",
    };
  }

  if (command.deploymentId !== undefined) {
    state.deploymentId = command.deploymentId;
    return {
      detail: "Using explicit deployment id.",
      evidence: { deploymentId: command.deploymentId },
      id: "deployment",
      status: "pass",
      title: "Deployment",
    };
  }

  if (command.deployment === undefined) {
    return {
      detail: "No deployment selector was provided.",
      id: "deployment",
      advice: [
        "Pass --deployment or --deployment-id, or update codemagic-patch.config.json.",
      ],
      status: "skip",
      title: "Deployment",
    };
  }

  if (state.appId === undefined) {
    return {
      detail: "Deployment resolution needs a resolved app.",
      id: "deployment",
      status: "skip",
      title: "Deployment",
    };
  }

  try {
    const response = await doctorGet(
      deps,
      state.serverUrl,
      `/v1/apps/${encodeURIComponent(state.appId)}/deployments`,
      state.token,
    );
    const deployments = parseDeploymentList(response);
    const match = matchNamedResource(deployments, command.deployment, "Deployment");

    if (match.kind !== "matched") {
      return resourceMatchFailure("deployment", command.deployment, match);
    }

    state.deployment = match.resource;
    state.deploymentId = match.resource.id;
    return {
      detail: `Resolved deployment ${command.deployment}.`,
      evidence: {
        appId: state.appId,
        deploymentId: match.resource.id,
        deploymentName: match.resource.name,
        ...(match.resource.deploymentKey !== undefined
          ? { deploymentKey: redactValue(match.resource.deploymentKey) }
          : {}),
      },
      id: "deployment",
      status: "pass",
      title: "Deployment",
    };
  } catch (error) {
    return {
      detail: formatRequestError(error),
      id: "deployment",
      issues: ["Deployment resolution request failed."],
      advice: ["Run `cmpatch deployment list` with the same app selector."],
      status: "fail",
      title: "Deployment",
    };
  }
}

function checkDeploymentKey(
  command: DoctorCommand,
  state: DoctorExecutionState,
): DoctorCheckResult {
  if (command.deploymentKey !== undefined && looksLikeCredential(command.deploymentKey)) {
    return {
      detail: "The supplied deployment key looks like an API or OAuth credential.",
      evidence: {
        deploymentKey: "<redacted>",
      },
      id: "deployment-key",
      issues: ["A private credential may be wired as the client deployment key."],
      advice: ["Use the deployment key from `cmpatch deployment list`, not a personal access token."],
      status: "fail",
      title: "Deployment key",
    };
  }

  const resolvedKey = state.deployment?.deploymentKey;
  if (command.deploymentKey !== undefined && resolvedKey !== undefined) {
    const matches = command.deploymentKey === resolvedKey;
    return {
      detail: matches
        ? "Supplied deployment key matches the resolved deployment."
        : "Supplied deployment key does not match the resolved deployment.",
      evidence: {
        resolvedDeploymentKey: redactValue(resolvedKey),
        suppliedDeploymentKey: redactValue(command.deploymentKey),
      },
      id: "deployment-key",
      ...(matches
        ? {}
        : {
            issues: ["The client may be pointing at a different deployment."],
            advice: ["Update the native CodemagicPatchDeploymentKey value."],
            nextCommands: ["cmpatch deployment list"],
          }),
      status: matches ? "pass" : "fail",
      title: "Deployment key",
    };
  }

  if (resolvedKey !== undefined) {
    return {
      detail: "Resolved deployment exposes a deployment key.",
      evidence: {
        resolvedDeploymentKey: redactValue(resolvedKey),
      },
      id: "deployment-key",
      status: "pass",
      title: "Deployment key",
    };
  }

  if (command.deploymentKey !== undefined) {
    return {
      detail: "A deployment key was supplied, but doctor could not resolve a deployment key to compare.",
      evidence: {
        suppliedDeploymentKey: redactValue(command.deploymentKey),
      },
      id: "deployment-key",
      advice: ["Resolve the app and deployment by name, or verify with `cmpatch deployment list`."],
      nextCommands: ["cmpatch deployment list"],
      status: "skip",
      title: "Deployment key",
    };
  }

  return {
    detail: "Deployment key comparison needs a supplied key or a resolved deployment.",
    id: "deployment-key",
    status: "skip",
    title: "Deployment key",
  };
}

async function resolveDoctorAuthSource(
  deps: Pick<CommandDeps, "env">,
  command: DoctorCommand,
  serverUrl: string,
): Promise<AuthProbeSource> {
  const flagToken = resolveOptionalString(command.token);
  if (flagToken !== undefined) {
    return { kind: "flag", token: flagToken };
  }

  const envToken = resolveOptionalString(deps.env.CODEMAGIC_PATCH_TOKEN);
  if (envToken !== undefined) {
    return { kind: "env", token: envToken };
  }

  try {
    const stored = await loadStoredCredential(serverUrl, { env: deps.env });
    if (stored === null) {
      return { kind: "none" };
    }

    if (resolveOptionalString(stored.accessToken) === undefined) {
      return {
        detail: "Stored credential is missing a usable access token.",
        kind: "stored-invalid",
      };
    }

    return {
      kind: "stored",
      token: stored.accessToken,
    };
  } catch (error) {
    return {
      detail: `Stored credential could not be read${formatErrorSuffix(error)}.`,
      kind: "stored-invalid",
    };
  }
}

async function doctorGet(
  deps: Pick<CommandDeps, "fetch">,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
): Promise<unknown> {
  return request(deps.fetch, buildApiUrl(serverUrl, pathname), {
    headers:
      token !== undefined
        ? { authorization: `Bearer ${normalizeBearerToken(token)}` }
        : {},
    method: "GET",
  });
}

function parseNamedResourceList(
  response: unknown,
  wrapperKey: "apps" | "teams",
): NamedResource[] {
  if (!isRecord(response) || !Array.isArray(response[wrapperKey])) {
    throw new UsageError(
      `Malformed ${wrapperKey} response: expected { "${wrapperKey}": [{ "id": string, "name": string }] }`,
    );
  }

  return response[wrapperKey].map((resource, index) => {
    if (!isNamedResource(resource)) {
      throw new UsageError(
        `Malformed ${wrapperKey} response: item ${index} must include string id and name`,
      );
    }

    return {
      id: resource.id,
      name: resource.name,
    };
  });
}

function parseDeploymentList(response: unknown): DeploymentResource[] {
  if (!isRecord(response) || !Array.isArray(response.deployments)) {
    throw new UsageError(
      'Malformed deployments response: expected { "deployments": [{ "id": string, "name": string, "deployment_key"?: string }] }',
    );
  }

  return response.deployments.map((deployment, index) => {
    if (!isNamedResource(deployment)) {
      throw new UsageError(
        `Malformed deployments response: item ${index} must include string id and name`,
      );
    }
    const deploymentRecord = deployment as Record<string, unknown>;

    if (
      "deployment_key" in deploymentRecord &&
      deploymentRecord.deployment_key !== undefined &&
      typeof deploymentRecord.deployment_key !== "string"
    ) {
      throw new UsageError(
        `Malformed deployments response: item ${index} deployment_key must be a string`,
      );
    }

    return {
      id: deployment.id,
      name: deployment.name,
      ...(typeof deploymentRecord.deployment_key === "string"
        ? { deploymentKey: deploymentRecord.deployment_key }
        : {}),
    };
  });
}

function matchNamedResource<T extends NamedResource>(
  resources: T[],
  requestedName: string,
  label: "App" | "Deployment" | "Team",
):
  | { kind: "ambiguous"; matches: T[] }
  | { kind: "matched"; resource: T }
  | { kind: "missing"; label: "App" | "Deployment" | "Team" } {
  const exactMatches = resources.filter(
    (resource) => resource.name === requestedName,
  );

  if (exactMatches.length === 1) {
    return { kind: "matched", resource: exactMatches[0]! };
  }

  if (exactMatches.length > 1) {
    return { kind: "ambiguous", matches: exactMatches };
  }

  const normalizedName = requestedName.toLocaleLowerCase();
  const caseInsensitiveMatches = resources.filter(
    (resource) => resource.name.toLocaleLowerCase() === normalizedName,
  );

  if (caseInsensitiveMatches.length === 1) {
    return { kind: "matched", resource: caseInsensitiveMatches[0]! };
  }

  if (caseInsensitiveMatches.length > 1) {
    return { kind: "ambiguous", matches: caseInsensitiveMatches };
  }

  return { kind: "missing", label };
}

function resourceMatchFailure(
  id: "app" | "deployment" | "team",
  requestedName: string,
  match:
    | { kind: "ambiguous"; matches: NamedResource[] }
    | { kind: "missing"; label: "App" | "Deployment" | "Team" },
): DoctorCheckResult {
  if (match.kind === "ambiguous") {
    return {
      detail: `${capitalize(id)} "${requestedName}" is ambiguous.`,
      evidence: {
        matches: match.matches.map((resource) => ({
          id: resource.id,
          name: resource.name,
        })),
      },
      id,
      issues: [`Multiple ${id} resources matched "${requestedName}".`],
      advice: [`Pass --${id}-id where supported.`],
      status: "fail",
      title: capitalize(id),
    };
  }

  return {
    detail: `${match.label} "${requestedName}" was not found.`,
    id,
    issues: [`The selected ${id} does not exist or is not visible.`],
    advice: [`Run \`cmpatch ${id === "team" ? "team" : id} list\` to inspect available resources.`],
    status: "fail",
    title: capitalize(id),
  };
}

function summarizeHealthResponse(response: unknown): Record<string, unknown> {
  if (isRecord(response)) {
    return {
      ...(typeof response.mode === "string" ? { mode: response.mode } : {}),
      ...(typeof response.ok === "boolean" ? { ok: response.ok } : {}),
    };
  }

  return {
    type: response === null ? "empty" : typeof response,
  };
}

function formatRequestError(error: unknown): string {
  if (error instanceof HttpProblemError) {
    const title =
      typeof error.problem.title === "string" ? error.problem.title : "Request failed";
    const detail =
      typeof error.problem.detail === "string" ? `: ${error.problem.detail}` : "";
    return `${title} (${error.responseStatus})${detail}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function formatAuthFailureIssue(
  source: Exclude<AuthProbeSource["kind"], "none" | "stored-invalid">,
  error: unknown,
): string {
  if (error instanceof HttpProblemError && error.responseStatus === 401) {
    return source === "stored"
      ? "Stored credentials were rejected and may be expired or revoked."
      : "The supplied token was rejected.";
  }

  if (error instanceof HttpProblemError && error.responseStatus === 403) {
    return "The authenticated principal is forbidden from this server.";
  }

  return "Authenticated control-plane request failed.";
}

function looksLikeCredential(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("cm_pat_") ||
    /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed) ||
    trimmed.includes("BEGIN PRIVATE KEY")
  );
}

function isNamedResource(value: unknown): value is NamedResource {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

async function runDownloadChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult[]> {
  const downloadBaseUrlCheck = checkDownloadBaseUrl(command.downloadBaseUrl, state);
  const deploymentMetaCheck = await checkDeploymentMeta(deps, command, state);
  const fallbackManifestCheck = await checkFallbackManifest(deps, command, state);
  const primaryManifestCheck = await checkPrimaryManifest(deps, command, state);

  return [
    downloadBaseUrlCheck,
    deploymentMetaCheck,
    fallbackManifestCheck,
    primaryManifestCheck,
  ];
}

function checkDownloadBaseUrl(
  downloadBaseUrl: string | undefined,
  state: DoctorExecutionState,
): DoctorCheckResult {
  if (downloadBaseUrl === undefined) {
    return {
      detail: "Download checks need a client-facing download base URL.",
      id: "download-base-url",
      status: "skip",
      title: "Download Base URL",
    };
  }

  try {
    const parsed = new URL(downloadBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        detail: `${downloadBaseUrl} does not use http or https.`,
        evidence: { downloadBaseUrl },
        id: "download-base-url",
        issues: ["The configured download base URL has an unsupported protocol."],
        advice: ["Use the client-facing CodemagicPatchDownloadBaseUrl value."],
        status: "fail",
        title: "Download Base URL",
      };
    }

    state.downloadBaseUrl = downloadBaseUrl;
    return {
      detail: `Using download base URL ${downloadBaseUrl}.`,
      evidence: {
        downloadBaseUrl,
        origin: parsed.origin,
      },
      id: "download-base-url",
      status: "pass",
      title: "Download Base URL",
    };
  } catch (error) {
    return {
      detail: `${downloadBaseUrl} is not a valid URL${formatErrorSuffix(error)}.`,
      evidence: { downloadBaseUrl },
      id: "download-base-url",
      issues: ["The configured download base URL cannot be parsed."],
      advice: ["Pass the client-facing CodemagicPatchDownloadBaseUrl value with --download-base-url."],
      status: "fail",
      title: "Download Base URL",
    };
  }
}

async function checkDeploymentMeta(
  deps: Pick<CommandDeps, "fetch">,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.downloadBaseUrl === undefined) {
    return {
      detail: "Deployment metadata check needs a valid download base URL.",
      id: "deployment-meta",
      status: "skip",
      title: "Deployment metadata",
    };
  }

  const keyResolution = resolveDeliveryDeploymentKey(command, state);
  if (keyResolution.kind !== "resolved") {
    return deliveryPrerequisiteSkip("deployment-meta", "Deployment metadata", keyResolution);
  }

  const url = buildDownloadUrl(state.downloadBaseUrl, [
    keyResolution.deploymentKey,
    "meta.json",
  ]);

  try {
    const response = await fetchDeliveryJson(deps.fetch, url);
    if (!response.ok) {
      return deliveryHttpFailure(
        "deployment-meta",
        "Deployment metadata",
        response,
        response.status === 404
          ? "Deployment metadata was not found at the download base URL."
          : "Deployment metadata request failed.",
        response.status === 404
          ? ["meta.json at the download base URL is missing for the selected deployment key."]
          : ["Deployment metadata request did not complete successfully."],
      );
    }

    const validation = validateDeploymentMeta(response.body);
    if (!validation.ok) {
      return {
        detail: `Deployment metadata response is malformed: ${validation.error}.`,
        evidence: { url },
        id: "deployment-meta",
        issues: [`meta.json at the download base URL does not match the expected ${PRODUCT_NAME} shape.`],
        advice: [`Verify the public delivery endpoint points at ${PRODUCT_NAME} artifacts.`],
        status: "fail",
        title: "Deployment metadata",
      };
    }

    return {
      detail: "Deployment metadata is reachable at the download base URL.",
      evidence: {
        deploymentKeySource: keyResolution.source,
        latestBinaryVersion: validation.latestBinaryVersion,
        url,
      },
      id: "deployment-meta",
      status: "pass",
      title: "Deployment metadata",
    };
  } catch (error) {
    return deliveryNetworkFailure(
      "deployment-meta",
      "Deployment metadata",
      url,
      error,
    );
  }
}

async function checkFallbackManifest(
  deps: Pick<CommandDeps, "fetch">,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.downloadBaseUrl === undefined) {
    return {
      detail: "Fallback manifest check needs a valid download base URL.",
      id: "fallback-manifest",
      status: "skip",
      title: "Fallback manifest",
    };
  }

  const keyResolution = resolveDeliveryDeploymentKey(command, state);
  if (keyResolution.kind !== "resolved") {
    return deliveryPrerequisiteSkip("fallback-manifest", "Fallback manifest", keyResolution);
  }

  const targetBinaryVersion = resolveDeliveryTargetBinaryVersion(command, state);
  if (targetBinaryVersion === undefined) {
    return {
      detail: "Fallback manifest check needs a target binary version.",
      id: "fallback-manifest",
      issues: ["Manifest URL cannot be built without the binary version."],
      advice: ["Pass --target-binary-version <version> or run doctor from a native project."],
      status: "skip",
      title: "Fallback manifest",
    };
  }

  const url = buildDownloadUrl(state.downloadBaseUrl, [
    keyResolution.deploymentKey,
    targetBinaryVersion,
    "manifest.json",
  ]);

  return checkManifestUrl(deps.fetch, {
    id: "fallback-manifest",
    kind: "fallback",
    title: "Fallback manifest",
    url,
  });
}

async function checkPrimaryManifest(
  deps: Pick<CommandDeps, "fetch">,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.downloadBaseUrl === undefined) {
    return {
      detail: "Primary manifest check needs a valid download base URL.",
      id: "primary-manifest",
      status: "skip",
      title: "Primary manifest",
    };
  }

  if (command.currentPackageHash === undefined) {
    return {
      detail: "Primary manifest probing needs --current-package-hash.",
      id: "primary-manifest",
      status: "skip",
      title: "Primary manifest",
    };
  }

  const keyResolution = resolveDeliveryDeploymentKey(command, state);
  if (keyResolution.kind !== "resolved") {
    return deliveryPrerequisiteSkip("primary-manifest", "Primary manifest", keyResolution);
  }

  const targetBinaryVersion = resolveDeliveryTargetBinaryVersion(command, state);
  if (targetBinaryVersion === undefined) {
    return {
      detail: "Primary manifest check needs a target binary version.",
      id: "primary-manifest",
      issues: ["Manifest URL cannot be built without the binary version."],
      advice: ["Pass --target-binary-version <version> or run doctor from a native project."],
      status: "skip",
      title: "Primary manifest",
    };
  }

  const url = buildDownloadUrl(state.downloadBaseUrl, [
    keyResolution.deploymentKey,
    targetBinaryVersion,
    command.currentPackageHash,
    "manifest.json",
  ]);

  return checkManifestUrl(deps.fetch, {
    id: "primary-manifest",
    kind: "primary",
    title: "Primary manifest",
    url,
  });
}

async function checkManifestUrl(
  fetchImpl: typeof globalThis.fetch,
  input: {
    id: "fallback-manifest" | "primary-manifest";
    kind: "fallback" | "primary";
    title: string;
    url: string;
  },
): Promise<DoctorCheckResult> {
  try {
    const response = await fetchDeliveryJson(fetchImpl, input.url);
    if (!response.ok) {
      return deliveryHttpFailure(
        input.id,
        input.title,
        response,
        response.status === 404
          ? input.kind === "fallback"
            ? "Fallback manifest was not found at the download base URL."
            : "Primary manifest was not found at the download base URL."
          : `${input.title} request failed.`,
        response.status === 404
          ? [
              input.kind === "fallback"
                ? "No healthy published OTA manifest exists for this binary version."
                : "No pre-generated manifest exists for this current package hash.",
            ]
          : ["Manifest request did not complete successfully."],
      );
    }

    const validation = validateManifest(response.body);
    if (!validation.ok) {
      return {
        detail: `${input.title} response is malformed: ${validation.error}.`,
        evidence: { url: input.url },
        id: input.id,
        issues: [`manifest.json at the download base URL does not match the expected ${PRODUCT_NAME} shape.`],
        advice: [`Verify the public delivery endpoint points at ${PRODUCT_NAME} artifacts.`],
        status: "fail",
        title: input.title,
      };
    }

    const summary = summarizeManifest(response.body);
    if (summary.targetPackageHash === null) {
      return {
        detail: `${input.title} is reachable but does not target a healthy OTA release.`,
        evidence: {
          ...summary,
          url: input.url,
        },
        id: input.id,
        issues: ["The manifest reports that no OTA package is available."],
        advice: ["Run `cmpatch release inspect --wait` for the expected release."],
        status: "warn",
        title: input.title,
      };
    }

    return {
      detail: `${input.title} is reachable at the download base URL.`,
      evidence: {
        ...summary,
        url: input.url,
      },
      id: input.id,
      status: "pass",
      title: input.title,
    };
  } catch (error) {
    return deliveryNetworkFailure(input.id, input.title, input.url, error);
  }
}

type DeliveryDeploymentKeyResolution =
  | {
      deploymentKey: string;
      kind: "resolved";
      source: "resolved-deployment" | "supplied";
    }
  | {
      advice: string[];
      detail: string;
      issues: string[];
      kind: "missing";
    };

function resolveDeliveryDeploymentKey(
  command: DoctorCommand,
  state: DoctorExecutionState,
): DeliveryDeploymentKeyResolution {
  if (command.deploymentKey !== undefined) {
    if (looksLikeCredential(command.deploymentKey)) {
      return {
        advice: ["Use the deployment key from `cmpatch deployment list`, not a personal access token."],
        detail: "Download URL construction was skipped because the supplied deployment key looks like a credential.",
        issues: ["A private credential may be wired as the client deployment key."],
        kind: "missing",
      };
    }

    return {
      deploymentKey: command.deploymentKey,
      kind: "resolved",
      source: "supplied",
    };
  }

  if (state.deployment?.deploymentKey !== undefined) {
    return {
      deploymentKey: state.deployment.deploymentKey,
      kind: "resolved",
      source: "resolved-deployment",
    };
  }

  return {
    advice: [
      "Pass --deployment-key <key>, or resolve deployment by name so doctor can read it back.",
    ],
    detail: "Download URL construction needs a deployment key.",
    issues: ["Download checks cannot run without the client deployment key."],
    kind: "missing",
  };
}

function resolveDeliveryTargetBinaryVersion(
  command: DoctorCommand,
  state: DoctorExecutionState,
): string | undefined {
  return state.targetBinaryVersion ?? command.targetBinaryVersion;
}

function deliveryPrerequisiteSkip(
  id: "deployment-meta" | "fallback-manifest" | "primary-manifest",
  title: string,
  resolution: Exclude<DeliveryDeploymentKeyResolution, { kind: "resolved" }>,
): DoctorCheckResult {
  return {
    detail: resolution.detail,
    id,
    issues: resolution.issues,
    advice: resolution.advice,
    nextCommands: ["cmpatch deployment list"],
    status: "skip",
    title,
  };
}

function deliveryHttpFailure(
  id: "deployment-meta" | "fallback-manifest" | "primary-manifest",
  title: string,
  response: DeliveryJsonResponse,
  detail: string,
  issues: string[],
): DoctorCheckResult {
  return {
    detail: `${detail} (${formatHttpStatus(response.status)})`,
    evidence: {
      status: response.status,
      url: response.url,
    },
    id,
    issues,
    advice: [
      "Verify the client's CodemagicPatchDownloadBaseUrl and CodemagicPatchDeploymentKey values.",
      "Retry after the release worker has published manifests.",
    ],
    nextCommands: ["cmpatch release inspect --wait"],
    status: "fail",
    title,
  };
}

function deliveryNetworkFailure(
  id: "deployment-meta" | "fallback-manifest" | "primary-manifest",
  title: string,
  url: string,
  error: unknown,
): DoctorCheckResult {
  return {
    detail: error instanceof Error ? error.message : String(error),
    evidence: { url },
    id,
    issues: ["Download request failed before a usable response was received."],
    advice: ["Check the download base URL and network access."],
    status: "fail",
    title,
  };
}

function validateDeploymentMeta(
  value: unknown,
): { latestBinaryVersion: string; ok: true } | { error: string; ok: false } {
  if (!isRecord(value)) {
    return { error: "expected an object", ok: false };
  }

  if (typeof value.latest_binary_version !== "string") {
    return { error: "latest_binary_version must be a string", ok: false };
  }

  return {
    latestBinaryVersion: value.latest_binary_version,
    ok: true,
  };
}

function validateManifest(
  value: unknown,
): { ok: true } | { error: string; ok: false } {
  if (!isRecord(value)) {
    return { error: "expected an object", ok: false };
  }

  if (
    value.target_package_hash !== null &&
    typeof value.target_package_hash !== "string"
  ) {
    return { error: "target_package_hash must be a string or null", ok: false };
  }

  if (typeof value.is_mandatory !== "boolean") {
    return { error: "is_mandatory must be a boolean", ok: false };
  }

  if (
    value.release_notes !== null &&
    typeof value.release_notes !== "string"
  ) {
    return { error: "release_notes must be a string or null", ok: false };
  }

  if (typeof value.rollout_percentage !== "number") {
    return { error: "rollout_percentage must be a number", ok: false };
  }

  if (
    "full_bundle_url" in value &&
    value.full_bundle_url !== undefined &&
    typeof value.full_bundle_url !== "string"
  ) {
    return { error: "full_bundle_url must be a string", ok: false };
  }

  if (
    "patch_url" in value &&
    value.patch_url !== undefined &&
    typeof value.patch_url !== "string"
  ) {
    return { error: "patch_url must be a string", ok: false };
  }

  return { ok: true };
}

function summarizeManifest(value: unknown): {
  hasFullBundleUrl: boolean;
  hasPatchUrl: boolean;
  releaseLabel?: string;
  targetPackageHash: null | string;
} {
  if (!isRecord(value)) {
    return {
      hasFullBundleUrl: false,
      hasPatchUrl: false,
      targetPackageHash: null,
    };
  }

  return {
    hasFullBundleUrl: typeof value.full_bundle_url === "string",
    hasPatchUrl: typeof value.patch_url === "string",
    ...(typeof value.release_label === "string"
      ? { releaseLabel: value.release_label }
      : {}),
    targetPackageHash:
      typeof value.target_package_hash === "string"
        ? redactFingerprint(value.target_package_hash)
        : null,
  };
}

function formatHttpStatus(status: number): string {
  return `HTTP ${status}`;
}

async function runNativeChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
    state: DoctorExecutionState;
  },
): Promise<DoctorCheckResult[]> {
  const platformResolution = await resolveDoctorPlatform(deps, command, context);
  const platform = platformResolution.platform;
  if (platform !== undefined) {
    context.state.platform = platform;
  }
  const nativeDirectoryCheck = await checkNativeDirectory(deps, platform, context);
  const targetBinaryVersionCheck = await checkTargetBinaryVersion(
    deps,
    command,
    platform,
    context,
    context.state,
  );
  const fingerprintCheck = await checkFingerprint(
    deps,
    command,
    platform,
    nativeDirectoryCheck.status === "pass",
    context,
  );

  return [
    platformResolution.check,
    nativeDirectoryCheck,
    targetBinaryVersionCheck,
    fingerprintCheck,
  ];
}

async function resolveDoctorPlatform(
  deps: Pick<CommandDeps, "stat">,
  command: DoctorCommand,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
  },
): Promise<{
  check: DoctorCheckResult;
  platform?: NativePlatform;
}> {
  if (command.platform !== undefined) {
    return {
      check: {
        detail: `Using ${command.platform} from command context.`,
        evidence: {
          platform: command.platform,
        },
        id: "platform",
        status: "pass",
        title: "Platform",
      },
      platform: command.platform,
    };
  }

  if (!context.projectRootExists) {
    return {
      check: {
        detail: "Platform detection was skipped because the project root is not readable.",
        id: "platform",
        status: "skip",
        title: "Platform",
      },
    };
  }

  const platforms = await detectNativePlatforms(deps, context.projectRoot);
  if (platforms.length === 1) {
    return {
      check: {
        detail: `Detected ${platforms[0]} from native project directories.`,
        evidence: {
          platform: platforms[0],
        },
        id: "platform",
        status: "pass",
        title: "Platform",
      },
      platform: platforms[0],
    };
  }

  if (platforms.length > 1) {
    return {
      check: {
        detail: "Both ios and android native directories are present.",
        evidence: {
          detectedPlatforms: platforms,
        },
        id: "platform",
        issues: ["Doctor needs one platform to run target-version and fingerprint checks."],
        advice: ["Pass `--platform ios` or `--platform android`."],
        status: "warn",
        title: "Platform",
      },
    };
  }

  return {
    check: {
      detail: "No platform was configured or detected.",
      id: "platform",
      advice: ["Pass `--platform ios` or `--platform android`."],
      status: "skip",
      title: "Platform",
    },
  };
}

async function checkNativeDirectory(
  deps: Pick<CommandDeps, "stat">,
  platform: NativePlatform | undefined,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
  },
): Promise<DoctorCheckResult> {
  if (platform === undefined) {
    return {
      detail: "Native directory check needs a platform.",
      id: "native-directory",
      status: "skip",
      title: "Native directory",
    };
  }

  if (!context.projectRootExists) {
    return {
      detail: "Native directory check was skipped because the project root is not readable.",
      id: "native-directory",
      status: "skip",
      title: "Native directory",
    };
  }

  const found = await hasNativeProjectDirectoryForPlatform(
    deps,
    context.projectRoot,
    platform,
  );

  if (!found) {
    return {
      detail: `No ${platform} native directory was found under ${context.projectRoot}.`,
      evidence: {
        platform,
        projectRoot: context.projectRoot,
      },
      id: "native-directory",
      issues: ["The selected platform does not have a native project directory."],
      advice: ["Pass the correct `--project-root` or `--platform`."],
      status: "fail",
      title: "Native directory",
    };
  }

  return {
    detail: `Found ${platform} native directory under ${context.projectRoot}.`,
    evidence: {
      platform,
      projectRoot: context.projectRoot,
    },
    id: "native-directory",
    status: "pass",
    title: "Native directory",
  };
}

async function checkTargetBinaryVersion(
  deps: CommandDeps,
  command: DoctorCommand,
  platform: NativePlatform | undefined,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
  },
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (command.targetBinaryVersion !== undefined) {
    if (!isPathSafeBinaryVersion(command.targetBinaryVersion)) {
      return {
        detail: `${command.targetBinaryVersion} is not a valid binary version: it must start with an alphanumeric character, contain only letters, digits, '.', '_', '+', '-', and be at most 128 characters.`,
        id: "target-binary-version",
        issues: ["The server will reject the supplied target binary version."],
        advice: ["Pass `--target-binary-version <version>` such as 1.2.3."],
        status: "fail",
        title: "Target binary version",
      };
    }

    state.targetBinaryVersion = command.targetBinaryVersion;
    return {
      detail: "Using supplied target binary version.",
      evidence: {
        source: "flag-or-default",
        targetBinaryVersion: command.targetBinaryVersion,
      },
      id: "target-binary-version",
      status: "pass",
      title: "Target binary version",
    };
  }

  if (platform === undefined) {
    return {
      detail: "Target binary version detection needs a platform.",
      id: "target-binary-version",
      status: "skip",
      title: "Target binary version",
    };
  }

  if (!context.projectRootExists) {
    return {
      detail:
        "Target binary version detection was skipped because the project root is not readable.",
      id: "target-binary-version",
      status: "skip",
      title: "Target binary version",
    };
  }

  try {
    const targetBinaryVersion = await resolveTargetBinaryVersion(deps, {
      platform,
      projectRoot: context.projectRoot,
    });

    state.targetBinaryVersion = targetBinaryVersion;
    if (!isPathSafeBinaryVersion(targetBinaryVersion)) {
      return {
        detail: `Detected target binary version '${targetBinaryVersion}' from the native project, but the server will reject it: it must start with an alphanumeric character, contain only letters, digits, '.', '_', '+', '-', and be at most 128 characters.`,
        evidence: {
          platform,
          targetBinaryVersion,
        },
        id: "target-binary-version",
        issues: ["The detected target binary version will be rejected by the server."],
        advice: ["Pass `--target-binary-version <version>` such as 1.2.3."],
        status: "warn",
        title: "Target binary version",
      };
    }

    return {
      detail: "Detected target binary version from the native project.",
      evidence: {
        platform,
        targetBinaryVersion,
      },
      id: "target-binary-version",
      status: "pass",
      title: "Target binary version",
    };
  } catch (error) {
    return {
      detail:
        error instanceof Error
          ? error.message
          : "Could not detect target binary version.",
      id: "target-binary-version",
      issues: ["Doctor could not infer the target binary version."],
      advice: ["Pass `--target-binary-version <version>`."],
      status: "warn",
      title: "Target binary version",
    };
  }
}

async function checkFingerprint(
  deps: CommandDeps,
  command: DoctorCommand,
  platform: NativePlatform | undefined,
  hasNativeDirectory: boolean,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
  },
): Promise<DoctorCheckResult> {
  if (platform === undefined) {
    return {
      detail: "Fingerprint check needs a platform.",
      id: "fingerprint",
      status: "skip",
      title: "Fingerprint",
    };
  }

  if (!context.projectRootExists) {
    return {
      detail: "Fingerprint check was skipped because the project root is not readable.",
      id: "fingerprint",
      status: "skip",
      title: "Fingerprint",
    };
  }

  if (!hasNativeDirectory) {
    return {
      detail: "Fingerprint check was skipped because no native directory was found.",
      id: "fingerprint",
      status: "skip",
      title: "Fingerprint",
    };
  }

  try {
    if (command.verbose) {
      const details = await deps.computeFingerprintDetails({
        platform,
        projectRoot: context.projectRoot,
      });
      return {
        detail: "Computed native fingerprint.",
        evidence: {
          fingerprint: redactFingerprint(details.fingerprint),
          platform,
          sourceCount: details.sources.length,
        },
        id: "fingerprint",
        status: "pass",
        title: "Fingerprint",
      };
    }

    const fingerprint = await deps.computeFingerprint({
      platform,
      projectRoot: context.projectRoot,
    });
    return {
      detail: "Computed native fingerprint.",
      evidence: {
        fingerprint: redactFingerprint(fingerprint),
        platform,
      },
      id: "fingerprint",
      status: "pass",
      title: "Fingerprint",
    };
  } catch (error) {
    return {
      detail:
        error instanceof Error
          ? error.message
          : "Could not compute native fingerprint.",
      id: "fingerprint",
      issues: ["Native fingerprint computation failed."],
      advice: ["Run `cmpatch fingerprint --platform <platform> --verbose`."],
      nextCommands: [`cmpatch fingerprint --platform ${platform} --verbose`],
      status: "fail",
      title: "Fingerprint",
    };
  }
}

async function checkBundler(
  deps: CommandDeps,
  command: DoctorCommand,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
  },
): Promise<DoctorCheckResult> {
  if (command.bundler !== undefined && command.bundler !== "auto") {
    if (command.bundler !== "metro" && command.bundler !== "expo") {
      return {
        detail: `${command.bundler} is not supported by release-react.`,
        evidence: {
          bundler: command.bundler,
        },
        id: "bundler",
        issues: ["The configured bundler is unsupported."],
        advice: ["Set project bundler to metro or expo."],
        nextCommands: ["cmpatch init --bundler metro"],
        status: "fail",
        title: "Bundler",
      };
    }

    return {
      detail: `Using configured ${command.bundler} bundler.`,
      evidence: {
        bundler: command.bundler,
        source: "flag-or-default",
      },
      id: "bundler",
      status: "pass",
      title: "Bundler",
    };
  }

  if (!context.projectRootExists) {
    return {
      detail: "Bundler detection was skipped because the project root is not readable.",
      id: "bundler",
      status: "skip",
      title: "Bundler",
    };
  }

  try {
    const detected = await detectProjectBundler(deps, context.projectRoot);
    if (detected.kind === "repack" || detected.kind === "rock") {
      return {
        detail: `Detected ${formatBundlerName(detected.kind)} from ${detected.reason}.`,
        evidence: {
          bundler: detected.kind,
          reason: detected.reason,
        },
        id: "bundler",
        issues: [
          `${formatBundlerName(detected.kind)} projects are not supported by release-react yet.`,
        ],
        advice: [
          "Pass `--bundler metro` only if this project can still bundle with Metro.",
        ],
        nextCommands: ["cmpatch release-react --dry-run"],
        status: "fail",
        title: "Bundler",
      };
    }

    return {
      detail: `Detected ${detected.kind} bundler from ${detected.reason}.`,
      evidence: {
        bundler: detected.kind,
        reason: detected.reason,
      },
      id: "bundler",
      status: "pass",
      title: "Bundler",
    };
  } catch (error) {
    return {
      detail:
        error instanceof Error ? error.message : "Could not detect project bundler.",
      id: "bundler",
      issues: ["Bundler detection failed."],
      advice: ["Set the project bundler explicitly."],
      nextCommands: ["cmpatch init --bundler metro"],
      status: "fail",
      title: "Bundler",
    };
  }
}

function summarizeEffectiveContext(
  context: EffectiveContext,
): Record<string, unknown> {
  return {
    projectRoot: context.projectRoot,
    ...(context.serverUrl !== undefined
      ? { serverUrl: summarizeEffectiveValue(context.serverUrl) }
      : {}),
    ...(context.team !== undefined
      ? { team: summarizeEffectiveValue(context.team) }
      : {}),
    ...(context.teamId !== undefined
      ? { teamId: summarizeEffectiveValue(context.teamId) }
      : {}),
    ...(context.app !== undefined
      ? { app: summarizeEffectiveValue(context.app) }
      : {}),
    ...(context.deployment !== undefined
      ? { deployment: summarizeEffectiveValue(context.deployment) }
      : {}),
    ...(context.platform !== undefined
      ? { platform: summarizeEffectiveValue(context.platform) }
      : {}),
    ...(context.bundler !== undefined
      ? { bundler: summarizeEffectiveValue(context.bundler) }
      : {}),
  };
}

function summarizeEffectiveValue(value: {
  source: string;
  value: string;
}): Record<string, string> {
  return {
    source: value.source,
    value: value.value,
  };
}

function validateCredentialStoreFile(
  value: unknown,
): { ok: true; serverCount: number } | { error: string; ok: false } {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) {
    return { error: "expected version 1 with a servers object", ok: false };
  }

  for (const [serverUrl, credential] of Object.entries(value.servers)) {
    if (!isStoredCredential(credential)) {
      return {
        error: `credential for ${serverUrl} does not match the expected schema`,
        ok: false,
      };
    }
  }

  return {
    ok: true,
    serverCount: Object.keys(value.servers).length,
  };
}

function isStoredCredential(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.accessToken === "string" &&
    typeof value.accessTokenExpiresAt === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.refreshTokenExpiresAt === "string" &&
    isRecord(value.user) &&
    typeof value.user.email === "string" &&
    typeof value.user.id === "string" &&
    (typeof value.user.displayName === "string" ||
      value.user.displayName === null)
  );
}

async function isFile(
  deps: Pick<CommandDeps, "stat">,
  path: string,
): Promise<boolean> {
  try {
    return (await deps.stat(path)).isFile();
  } catch {
    return false;
  }
}

function formatErrorSuffix(error: unknown): string {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "";
  }

  return ` (${error.message})`;
}

function redactFingerprint(value: string): string {
  if (value.length <= 12) {
    return "<redacted>";
  }

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export function renderDoctorTable(
  result: unknown,
  command: DoctorCommand,
): string {
  if (!isDoctorResult(result)) {
    throw new UsageError("Cannot render doctor output: invalid doctor result");
  }

  const lines = ["Codemagic Patch doctor", "", renderSummary(result.summary)];

  if (command.verbose) {
    lines.push("", ...renderVerboseGroups(result.groups));
    return `${lines.join("\n")}\n`;
  }

  const failedChecks = result.groups.flatMap((group) =>
    group.checks.filter((check) => check.status === "fail"),
  );
  const warningChecks = result.groups.flatMap((group) =>
    group.checks.filter(
      (check) => check.status === "warn" || isActionableSkip(check),
    ),
  );
  const hiddenCount = result.groups
    .flatMap((group) => group.checks)
    .filter(
      (check) =>
        check.status === "pass" ||
        (check.status === "skip" && !isActionableSkip(check)),
    ).length;

  if (failedChecks.length > 0) {
    lines.push("", "Possible issues detected:", "", ...renderChecks(failedChecks));
  }

  if (warningChecks.length > 0) {
    lines.push("", "Warnings:", "", ...renderChecks(warningChecks));
  }

  if (hiddenCount > 0) {
    lines.push("", "Use `--verbose` to see all passed and skipped checks.");
  }

  return `${lines.join("\n")}\n`;
}

function createDoctorResult(groups: DoctorCheckGroup[]): DoctorResult {
  const checks = groups.flatMap((group) => group.checks);
  const summary = {
    fail: countChecks(checks, "fail"),
    pass: countChecks(checks, "pass"),
    skip: countChecks(checks, "skip"),
    total: checks.length,
    warn: countChecks(checks, "warn"),
  };

  return {
    command: "doctor",
    exitCode: summary.fail > 0 ? 1 : 0,
    groups,
    summary,
  };
}

function summarizeReceivedInputs(
  command: DoctorCommand,
): Record<string, unknown> {
  return {
    ...(command.serverUrl !== undefined ? { serverUrl: command.serverUrl } : {}),
    ...(command.team !== undefined ? { team: command.team } : {}),
    ...(command.teamId !== undefined ? { teamId: command.teamId } : {}),
    ...(command.app !== undefined ? { app: command.app } : {}),
    ...(command.appId !== undefined ? { appId: command.appId } : {}),
    ...(command.deployment !== undefined
      ? { deployment: command.deployment }
      : {}),
    ...(command.deploymentId !== undefined
      ? { deploymentId: command.deploymentId }
      : {}),
    ...(command.platform !== undefined ? { platform: command.platform } : {}),
    projectRoot: command.projectRoot,
    ...(command.bundler !== undefined ? { bundler: command.bundler } : {}),
    ...(command.downloadBaseUrl !== undefined ? { downloadBaseUrl: command.downloadBaseUrl } : {}),
    ...(command.targetBinaryVersion !== undefined
      ? { targetBinaryVersion: command.targetBinaryVersion }
      : {}),
    ...(command.currentPackageHash !== undefined
      ? { currentPackageHash: command.currentPackageHash }
      : {}),
    ...(command.deploymentKey !== undefined
      ? { deploymentKey: redactValue(command.deploymentKey) }
      : {}),
    ...(command.token !== undefined ? { token: "<redacted>" } : {}),
  };
}

function redactValue(value: string): string {
  if (value.length <= 8) {
    return "<redacted>";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function countChecks(
  checks: DoctorCheckResult[],
  status: DoctorCheckStatus,
): number {
  return checks.filter((check) => check.status === status).length;
}

function renderSummary(summary: DoctorResult["summary"]): string {
  if (summary.total === 0) {
    return "No checks ran.";
  }

  return [
    formatCount(summary.pass, "check passed", "checks passed"),
    formatCount(summary.warn, "warning", "warnings"),
    formatCount(summary.fail, "failed", "failed"),
    formatCount(summary.skip, "skipped", "skipped"),
  ]
    .filter((part) => part !== null)
    .join(". ")
    .concat(".");
}

function formatCount(
  count: number,
  singular: string,
  plural: string,
): string | null {
  if (count === 0) {
    return null;
  }

  return `${count} ${count === 1 ? singular : plural}`;
}

function renderVerboseGroups(groups: DoctorCheckGroup[]): string[] {
  const lines: string[] = [];

  for (const group of groups) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`${group.title}:`, "", ...renderChecks(group.checks, true));
  }

  return lines;
}

function renderChecks(
  checks: DoctorCheckResult[],
  includeEvidence = false,
): string[] {
  return checks.flatMap((check, index) => [
    ...(index > 0 ? [""] : []),
    ...renderCheck(check, includeEvidence),
  ]);
}

function renderCheck(
  check: DoctorCheckResult,
  includeEvidence: boolean,
): string[] {
  const lines = [`${check.status.toUpperCase().padEnd(5)} ${check.id}`];
  appendIndentedText(lines, check.detail);
  appendList(lines, "Issues", check.issues);
  appendList(lines, "Advice", check.advice);
  appendList(lines, "Next commands", check.nextCommands);

  if (includeEvidence && check.evidence !== undefined) {
    appendIndentedText(lines, `Evidence: ${JSON.stringify(check.evidence)}`);
  }

  return lines;
}

function appendIndentedText(lines: string[], text: string | undefined): void {
  if (text === undefined || text.length === 0) {
    return;
  }

  for (const line of text.split("\n")) {
    lines.push(`      ${line}`);
  }
}

function appendList(
  lines: string[],
  title: string,
  values: string[] | undefined,
): void {
  if (values === undefined || values.length === 0) {
    return;
  }

  lines.push(`      ${title}:`);
  for (const value of values) {
    lines.push(`        ${value}`);
  }
}

function isActionableSkip(check: DoctorCheckResult): boolean {
  return (
    check.status === "skip" &&
    ((check.issues?.length ?? 0) > 0 ||
      (check.advice?.length ?? 0) > 0 ||
      (check.nextCommands?.length ?? 0) > 0)
  );
}

function isDoctorResult(value: unknown): value is DoctorResult {
  if (!isRecord(value) || value.command !== "doctor") {
    return false;
  }

  return (
    Array.isArray(value.groups) &&
    isRecord(value.summary) &&
    (value.exitCode === 0 || value.exitCode === 1)
  );
}
