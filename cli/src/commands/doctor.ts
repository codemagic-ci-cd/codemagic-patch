import { prepareDoctorFix, applyDoctorFix, type DoctorFix } from "../doctor/fixes";
import { canPromptOnStderr } from "./shared";
import { doctorBlockers } from "../doctor/report";
import { verifyDoctorDelivery, type PublicationCache } from "../doctor/deliveryVerification";
import { basename, resolve } from "node:path";

import { PRODUCT_NAME } from "../branding";
import {
  discoverDoctorProject,
  readDoctorSource,
  type DiscoveryFinding,
  type PlatformDiscovery,
} from "../doctor/discovery";
import {
  compareUrl,
  httpUrl,
  probeDownloadOrigin,
  safeUrl,
  redactUrlText,
} from "../doctor/connectivity";
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
import { request } from "../http";
import {
  resolveEffectiveContext,
  type EffectiveContext,
} from "../localContext";
import {
  isInteractiveOutput,
  isRecord,
  PLAIN_PALETTE,
  type Palette,
} from "../output";
import { HttpProblemError } from "../problem-details";
import { createProgress, fitSpinnerLine, onInterruptCleanup, type Progress } from "../progress";
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
  severity?: "info";
  reason?: string;
  prerequisites?: string[];
  scope?: "setup" | "delivery";
  platform?: NativePlatform;
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
  fixes?: Array<DoctorFix & { status: "available" | "applied" | "declined" | "failed"; detail?: string }>;
  coverage: { setup: DoctorCoverage; delivery: DoctorCoverage };
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

export type DoctorCoverage = {
  state: "complete" | "incomplete" | "not_requested";
  outcome: "passed" | "warnings" | "failed" | "not_verified";
  reasons: string[];
  platforms?: Partial<Record<NativePlatform, DoctorCoverage>>;
};

/**
 * Bounds every remote probe doctor makes. A hung server or delivery origin is
 * itself a finding — it must surface as a failed check within seconds, not
 * stall the whole run.
 */
const DOCTOR_REQUEST_TIMEOUT_MS = 10_000;

export async function executeDoctor(
  command: DoctorCommand,
  deps: CommandDeps,
): Promise<DoctorResult> {
  const controller = new AbortController();
  const progress = createProgress({
    label: "doctor",
    title: fitSpinnerLine(`${PRODUCT_NAME} doctor · ${basename(resolve(command.projectRoot))} · ${command.platform ?? "configured iOS/Android"} · ${command.verifyDelivery ? "setup + delivery" : "setup"}`, deps.stderr?.columns),
    neutralSteps: true,
    stderr:
      command.format !== "json" &&
      deps.stdout !== undefined &&
      isInteractiveOutput(deps.stdout) &&
      !deps.env.CI
        ? deps.stderr
        : undefined,
  });
  const dispose = onInterruptCleanup(async () => {
    controller.abort();
    progress.fail("Doctor interrupted");
  });
  const scopedDeps: CommandDeps = {
    ...deps,
    fetch: (input, init) => {
      controller.signal.throwIfAborted();
      return deps.fetch(input, {
        ...init,
        signal: AbortSignal.any([
          controller.signal,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
    },
  };
  try {
    let result = await runDoctorChecks(command, scopedDeps, progress);
    controller.signal.throwIfAborted();
    progress.stop("Diagnostic checks completed");
    if (command.fix) {
      const fix = await prepareDoctorFix(command.projectRoot, command.fixServerUrl, result);
      if (fix) {
        let approved = command.yes === true;
        if (!approved && command.format !== "json" && deps.stdout && isInteractiveOutput(deps.stdout) && canPromptOnStderr(deps, command.nonInteractive === true) && deps.confirm) {
          deps.stdout.write(renderDoctorTable(sanitizeDoctorOutput(result), command));
          approved = await deps.confirm({
            initial: false,
            message: `Create ${fix.preview.file} with serverUrl = ${fix.preview.value}?`,
          });
        }
        controller.signal.throwIfAborted();
        result.fixes = [{ ...fix.preview, status: approved ? "available" : "declined" }];
        if (approved) {
          try {
            await applyDoctorFix(fix, controller.signal);
          } catch {
            controller.signal.throwIfAborted();
            result.fixes = [{ ...fix.preview, status: "failed", detail: "Configuration could not be created safely. Check permissions or concurrent changes and rerun doctor." }];
            result.exitCode = 1;
            return sanitizeDoctorOutput(result);
          }
          result = await runDoctorChecks(command, scopedDeps, progress);
          controller.signal.throwIfAborted();
          progress.stop("Configuration saved; diagnostic recheck completed");
          result.fixes = [{ ...fix.preview, status: "applied" }];
        }
      } else result.fixes = [];
    }
    return sanitizeDoctorOutput(result);
  } catch (error) {
    progress.fail();
    throw error;
  } finally {
    dispose();
    controller.abort();
    progress.stop();
  }
}

function sanitizeDoctorOutput<T>(value: T): T {
  if (typeof value === "string")
    return redactUrlText(value)
      .replace(
        /cm_pat_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "<redacted>",
      ) as T;
  if (Array.isArray(value)) return value.map(sanitizeDoctorOutput) as T;
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDoctorOutput(item),
      ]),
    ) as T;
  return value;
}

async function runDoctorChecks(
  command: DoctorCommand,
  deps: CommandDeps,
  progress: Progress,
): Promise<DoctorResult> {
  const projectRoot = resolve(command.projectRoot);
  progress.write("Checking local configuration");
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
  progress.write("Inspecting application SDK configuration");
  const discovery = await discoverDoctorProject(command, projectConfig.config);
  const toCheck = (check: DiscoveryFinding): DoctorCheckResult => ({
    id: check.id,
    ...(check.severity ? { severity: check.severity } : {}),
    ...(check.platform ? { platform: check.platform } : {}),
    title:
      check.id
        .replace(/^sdk-/, "")
        .replace(/-/g, " ")
        .replace(/apiUrl/g, "API URL")
        .replace(/downloadBaseUrl/g, "download URL")
        .replace(/deploymentKey/g, "deployment key") +
      (check.platform ? ` (${check.platform})` : ""),
    status: check.status,
    detail: check.detail,
    reason: check.reason,
    evidence: { sources: check.sources },
    ...(check.advice ? { advice: check.advice } : {}),
  });
  const projectContext = {
    projectRoot,
    projectRootExists: projectRootCheck.status === "pass",
  };
  const state: DoctorExecutionState = {};
  progress.write("Checking control plane and project");
  const [baseChecks, bundlerCheck] = await Promise.all([
    runControlPlaneBaseChecks(deps, command, state,
      !command.team && !command.teamId &&
      (discovery.platforms.some((item) => item.intent !== "not_configured")
        ? discovery.platforms.filter((item) => item.intent !== "not_configured").every((item) => !!item.binding.appId)
        : !!command.appId)),
    checkBundler(deps, command, projectContext),
  ]);
  const sdkConfigCheck = await checkServerSdkConfig(deps, state);
  const groups: DoctorCheckGroup[] = [
    contextGroup,
    {
      id: "sdk-project",
      title: "SDK Project",
      checks: discovery.findings.map(toCheck),
    },
    {
      id: "control-plane",
      title: "Control Plane",
      checks: [...baseChecks, sdkConfigCheck],
    },
    { id: "bundler", title: "Bundler", checks: [bundlerCheck] },
  ];
  const platforms = discovery.platforms.filter(
    (item) => item.intent !== "not_configured",
  );
  for (const item of discovery.platforms.filter(
    (item) => item.intent === "not_configured",
  )) {
    groups.push({
      id: `sdk-${item.platform}`,
      title: `SDK Configuration (${item.platform})`,
      checks: item.findings
        .map(toCheck)
        .map((check) => ({ ...check, platform: item.platform })),
    });
  }
  // No known OTA scope still gets useful CLI/server probes, never a guessed SDK binding.
  const publicationCache: PublicationCache = new Map();
  const plans: Array<PlatformDiscovery | undefined> = platforms.length
    ? platforms
    : [undefined];
  for (const item of plans) {
    const platform = item?.platform;
    const suffix = platforms.length > 1 ? `-${platform}` : "";
    const localState: DoctorExecutionState = { ...state, platform };
    const bound = item?.binding.state === "resolved";
    const selectors = item?.binding;
    const plan: DoctorCommand = item
      ? {
          ...command,
          platform,
          unboundSelectors: item.binding.state === "unresolved" &&
            (!!(command.app || command.appId) && !selectors?.app && !selectors?.appId || !!command.deploymentId && !selectors?.deploymentId),
          app: selectors?.app,
          appId: selectors?.appId,
          deployment: selectors?.deployment,
          deploymentId: selectors?.deploymentId,
          deploymentKey:
            platforms.length === 1 ? command.deploymentKey : undefined,
        }
      : command;
    progress.write(
      `Checking ${platform ?? "selected"} setup and download connectivity`,
    );
    const targetChecks = await runControlPlaneTargetChecks(
      deps,
      plan,
      localState,
    );
    const nativeChecks =
      item &&
      !item.nativePresent &&
      (item.findings.some(
        (check) => check.id === "sdk-native" && check.reason === "deferred",
      ) ||
        item.intent === "unresolved")
        ? [
            {
              id: "native-prebuild",
              title: "Generated native project",
              status: "skip" as const,
              reason: "deferred",
              detail:
                "Native build evidence is unavailable; inspect the Expo configuration and generated project after prebuild/build. Doctor did not run prebuild.",
            },
          ]
        : await runNativeChecks(deps, plan, {
            ...projectContext,
            state: localState,
            iosVersionSource: item?.iosVersionSource,
          });
    const sdkChecks = item
      ? [
          ...item.findings.map(toCheck),
          ...compareApplicationSettings(item, plan, localState),
        ]
      : [];
    // Overrides get their own probe; they never erase app-source comparisons or failures.
    const sources = [
      item?.native?.downloadBaseUrl,
      item?.expo?.downloadBaseUrl,
    ].filter((source) => source?.state === "resolved");
    const urls = [
      ...new Set([
        ...sources.map((source) => source!.value!),
        ...(command.downloadBaseUrl ? [command.downloadBaseUrl] : []),
      ]),
    ];
    const downloadChecks: DoctorCheckResult[] = urls.length
      ? await Promise.all(
          urls.map(async (url) => {
            const check = await probeDownloadOrigin(deps.fetch, url);
            return {
              ...check,
              evidence: {
                ...check.evidence,
                sources: sources
                  .filter((source) => source?.value === url)
                  .map((source) => source!.source),
                override: command.downloadBaseUrl === url,
              },
            };
          }),
        )
      : [
          {
            id: "download-connectivity",
            title: "Download endpoint connectivity",
            status: "skip",
            reason: "unresolved",
            detail:
              "No resolved application download URL or explicit probe override is available.",
          },
        ];
    const appSettings = item?.native ?? item?.expo;
    const deliveryCommand = {
      ...plan,
      downloadBaseUrl:
        command.downloadBaseUrl ??
        (appSettings?.downloadBaseUrl.state === "resolved"
          ? appSettings.downloadBaseUrl.value
          : undefined),
      deploymentKey:
        plan.deploymentKey ??
        (appSettings?.deploymentKey.state === "resolved" && bound
          ? appSettings.deploymentKey.value
          : undefined),
    };
    const deliveryChecks: DoctorCheckResult[] = command.verifyDelivery
      ? await verifyDoctorDelivery({
          fetch: deps.fetch, cache: publicationCache,
          downloadBaseUrl: deliveryCommand.downloadBaseUrl,
          deploymentKey: deliveryCommand.deploymentKey ?? localState.deployment?.deploymentKey,
          version: localState.targetBinaryVersion ?? command.targetBinaryVersion,
          currentHash: command.currentPackageHash,
          serverUrl: localState.serverUrl, token: localState.token,
          deploymentId: (deliveryCommand.deploymentKey === undefined || deliveryCommand.deploymentKey === localState.deployment?.deploymentKey) ? localState.deploymentId : undefined,
        })
      : [{ id: "delivery-not-requested", title: "Optional delivery verification", status: "skip", reason: "not_requested", detail: "Delivery verification was not requested. No release history, metadata, manifests, or OTA artifacts were requested." }];
    const platformGroups: DoctorCheckGroup[] = [
      {
        id: `control-plane${suffix || "-target"}`,
        title: `Control Plane${platform ? ` (${platform})` : ""}`,
        checks: targetChecks,
      },
      {
        id: `native${suffix}`,
        title: `Native Project${platform ? ` (${platform})` : ""}`,
        checks: nativeChecks,
      },
      {
        id: `sdk-${platform ?? "unknown"}`,
        title: `SDK Configuration (${platform ?? "unresolved"})`,
        checks: sdkChecks,
      },
      {
        id: `download${suffix}`,
        title: `Download Connectivity${platform ? ` (${platform})` : ""}`,
        checks: downloadChecks,
      },
      {
        id: `delivery${suffix}`,
        title: `Optional Delivery${platform ? ` (${platform})` : ""}`,
        checks: deliveryChecks.map((check) => ({
          ...check,
          scope: "delivery",
        })),
      },
    ];
    for (const group of platformGroups)
      group.checks = group.checks.map((check) => ({
        ...check,
        ...(platform ? { platform } : {}),
      }));
    groups.push(...platformGroups);
  }
  const preliminary = createDoctorResult(groups);
  for (const item of plans) {
    const platform = item?.platform;
    const setup = platform
      ? preliminary.coverage.setup.platforms?.[platform]
      : preliminary.coverage.setup;
    const complete = setup?.state === "complete" && setup.outcome !== "failed";
    groups.push({
      id: platforms.length > 1 ? `device-${platform}` : "device",
      title: `Device Debugging${platform ? ` (${platform})` : ""}`,
      checks: [
        {
          id: "device-debug-handoff",
          title: "Device debugging handoff",
          status: complete ? "pass" : "skip",
          reason: "not_applicable",
          ...(platform ? { platform } : {}),
          detail: complete
            ? "Evaluated setup assertions are complete; device behavior remains unverified."
            : "Review setup findings before moving to device debugging.",
          ...(complete && platform
            ? { nextCommands: [`cmpatch debug ${platform}`] }
            : {}),
        },
      ],
    });
  }
  return createDoctorResult(groups);
}

async function checkServerSdkConfig(
  deps: CommandDeps,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  const base = { id: "server-sdk-config", title: "Server SDK configuration" };
  if (!state.serverUrl || !state.token)
    return {
      ...base,
      status: "skip",
      reason: "blocked",
      prerequisites: ["auth"],
      detail:
        "Server comparison requires authentication; public connectivity remains independent.",
    };
  try {
    const response = await doctorGet(
      deps,
      state.serverUrl,
      "/v1/sdk-config",
      state.token,
    );
    if (
      !isRecord(response) ||
      typeof response.download_base_url !== "string" ||
      !httpUrl(response.download_base_url)
    ) {
      return {
        ...base,
        status: "skip",
        reason: "unresolved",
        detail:
          "The SDK-config endpoint did not return a valid download_base_url.",
      };
    }
    state.downloadBaseUrl = response.download_base_url;
    return {
      ...base,
      status: "pass",
      detail: "Server download configuration was retrieved.",
      evidence: { downloadBaseUrl: safeUrl(state.downloadBaseUrl) },
    };
  } catch (error) {
    return {
      ...base,
      status: "skip",
      reason: "unresolved",
      detail:
        error instanceof HttpProblemError && error.responseStatus === 501
          ? "Server SDK configuration is not available (HTTP 501)."
          : "Server SDK configuration could not be retrieved.",
      advice: [
        "Inspect the server's download configuration; public endpoint probes still run independently.",
      ],
    };
  }
}

function compareApplicationSettings(
  item: PlatformDiscovery,
  command: DoctorCommand,
  state: DoctorExecutionState,
): DoctorCheckResult[] {
  const checks: DoctorCheckResult[] = [];
  for (const [kind, settings] of [
    ["native", item.native],
    ["expo", item.expo],
  ] as const) {
    if (!settings) continue;
    const value = (field: keyof typeof settings) =>
      settings[field].state === "resolved" ? settings[field].value : undefined;
    checks.push(
      compareUrl(
        `sdk-${kind}-api-comparison`,
        value("apiUrl"),
        state.serverUrl,
        settings.apiUrl.source,
      ),
    );
    checks.push({
      ...compareUrl(
        `sdk-${kind}-download-comparison`,
        value("downloadBaseUrl"),
        state.downloadBaseUrl,
        settings.downloadBaseUrl.source,
      ),
      prerequisites: ["server-sdk-config"],
    });
    const key = value("deploymentKey");
    const verified =
      item.binding.state === "resolved" &&
      state.appId &&
      state.deployment?.deploymentKey &&
      key;
    checks.push({
      id: `sdk-${kind}-key-comparison`,
      title: "Application deployment key",
      status: verified
        ? key === state.deployment!.deploymentKey
          ? "pass"
          : "fail"
        : "skip",
      ...(!verified
        ? {
            reason: "blocked",
            prerequisites: [
              "app",
              "deployment",
              `sdk-${kind}-deploymentKey`,
              ...(item.binding.state === "unresolved"
                ? ["sdk-platform-binding"]
                : []),
            ],
          }
        : {}),
      detail: verified
        ? key === state.deployment!.deploymentKey
          ? "Application key matches the verified deployment."
          : "Application key differs from the verified deployment; a CLI override does not repair the app."
        : "Application key comparison needs resolved same-platform app, deployment, and source evidence.",
      evidence: {
        source: settings.deploymentKey.source,
        overrideSupplied: command.deploymentKey !== undefined,
      },
    });
  }
  return checks;
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
    ...(projectConfig.app !== undefined && projectConfig.appId !== undefined
      ? ["Project config contains both app and appId."]
      : []),
    ...(["android", "ios"] as const).flatMap((platform) => {
      const platformConfig = projectConfig.apps?.[platform];
      return platformConfig?.app !== undefined &&
        platformConfig.appId !== undefined
        ? [`Project config contains both app and appId for ${platform}.`]
        : [];
    }),
  ];

  if (issues.length > 0) {
    return {
      detail: "Conflicting team or app defaults were found.",
      id: "default-conflicts",
      issues,
      advice: [
        "Keep only one of team or team-id, and one of app or app-id, in each config scope.",
      ],
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

async function runControlPlaneBaseChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
  teamIndependent = false,
): Promise<DoctorCheckResult[]> {
  const serverUrlCheck = checkServerUrl(command.serverUrl, state);
  // The readiness probe is unauthenticated and independent of the auth->team
  // chain; both only need the validated server URL, so they overlap.
  const [healthCheck, authAndTeamChecks] = await Promise.all([
    checkServerHealth(deps, state),
    (async () => {
      const authCheck = await checkControlPlaneAuth(deps, command, state);
      const teamCheck: DoctorCheckResult = teamIndependent
        ? { id: "team", title: "Team", status: "skip", reason: "not_applicable", detail: "App IDs are verified directly; no team selection is required." }
        : await checkTeamResolution(command, state);
      if (teamCheck.status === "skip" && !teamCheck.reason) { teamCheck.reason = "blocked"; teamCheck.prerequisites = ["auth"]; }
      return [authCheck, teamCheck];
    })(),
  ]);

  return [serverUrlCheck, healthCheck, ...authAndTeamChecks];
}

async function runControlPlaneTargetChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult[]> {
  if (command.unboundSelectors) return ["app", "deployment", "deployment-key"].map((id) => ({
    id, title: id, status: "skip" as const, reason: "blocked", prerequisites: ["sdk-platform-binding"],
    detail: "App/deployment selectors were supplied, but cannot be assigned to this platform safely.",
    advice: [`Select --platform ${command.platform} or configure its apps.${command.platform} mapping.`],
  }));
  const appCheck = await checkAppResolution(deps, command, state);
  const deploymentCheck = await checkDeploymentResolution(deps, command, state);
  const deploymentKeyCheck = checkDeploymentKey(command, state);
  if (appCheck.status === "skip" && (!state.token || !state.teamId)) { appCheck.reason = "blocked"; appCheck.prerequisites = [!state.token ? "auth" : "team"]; }
  if (deploymentCheck.status === "skip" && !state.appId) { deploymentCheck.reason = "blocked"; deploymentCheck.prerequisites = ["app"]; }
  if (deploymentKeyCheck.status === "skip" && !state.deployment) { deploymentKeyCheck.reason = "blocked"; deploymentKeyCheck.prerequisites = ["deployment"]; }

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
    const parsed = httpUrl(serverUrl);
    if (!parsed) throw new Error("Invalid HTTP URL");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        detail: `${safeUrl(serverUrl)} does not use http or https.`,
        evidence: { serverUrl: safeUrl(serverUrl) },
        id: "server-url",
        issues: ["The configured server URL has an unsupported protocol."],
        advice: [`Set a ${PRODUCT_NAME} API URL that starts with http:// or https://.`],
        status: "fail",
        title: "Server URL",
      };
    }

    state.serverUrl = serverUrl;
    return {
      detail: `Using control-plane server ${safeUrl(serverUrl)}.`,
      evidence: {
        origin: parsed.origin,
        serverUrl: safeUrl(serverUrl),
      },
      id: "server-url",
      status: "pass",
      title: "Server URL",
    };
  } catch (error) {
    return {
      detail: `${safeUrl(serverUrl)} is not a valid URL${formatErrorSuffix(error)}.`,
      evidence: { serverUrl: safeUrl(serverUrl) },
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
    response = await deps.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DOCTOR_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      detail: formatRequestError(error),
      ...(error instanceof DoctorRedirectError ? {reason: "redirect"} : {}),
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

  if (response.ok && isRecord(body) && body.ok === true) {
    return {
      detail: "Server readiness endpoint reports ok=true.",
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
      detail: "Server readiness endpoint returned HTTP 503.",
      evidence: {
        response: summarizeHealthResponse(body),
        url,
      },
      id: "server-health",
      issues: [
        "Readiness failed; inspect server logs to establish the cause.",
      ],
      advice: [
        "Check the database container and the server logs (e.g. docker compose logs postgres server).",
      ],
      status: "fail",
      title: "Server health",
    };
  }

  return {
    detail: `Server readiness endpoint returned HTTP ${response.status} with an unexpected readiness response.`,
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
      ...(error instanceof DoctorRedirectError ? {reason: "redirect"} : {}),
      evidence: { authSource: authSource.kind },
      id: "auth",
      issues: [formatAuthFailureIssue(authSource.kind, error)],
      advice: [
        error instanceof DoctorRedirectError ? "Use the verified canonical server URL; this is not evidence of an invalid token." : authSource.kind === "stored"
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
    const exists = state.teams.some(team => team.id === command.teamId);
    if (exists) state.teamId = command.teamId;
    return { id: "team", title: "Team", status: exists ? "pass" : "fail", detail: exists ? "Explicit team ID is accessible." : "Explicit team ID is not among the accessible teams.", evidence: { teamId: command.teamId } };
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
    detail:
      "Multiple teams are visible; doctor cannot pick one on its own, so team-scoped checks are skipped.",
    evidence: {
      teams: state.teams.map((team) => ({ id: team.id, name: team.name })),
    },
    id: "team",
    issues: ["No team was selected among several visible teams."],
    advice: [
      "Pass --team <name> or --team-id <id>, or run `cmpatch config set team <name>` to store a default.",
    ],
    status: "warn",
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

  if (command.app === undefined && command.appId === undefined) {
    return {
      detail: "No app selector was provided.",
      id: "app",
      advice: ["Pass --app or --app-id, or update codemagic-patch.config.json."],
      status: "skip",
      title: "App",
    };
  }

  if (state.teamId === undefined && (!command.appId || command.team || command.teamId)) {
    return {
      detail: "App resolution needs a resolved team.",
      id: "app",
      status: "skip",
      title: "App",
    };
  }

  try {
    if (command.appId) {
      const response = await doctorGet(deps, state.serverUrl, `/v1/apps/${encodeURIComponent(command.appId)}`, state.token);
      const app = isRecord(response) ? response.app : undefined;
      const appTeam = isRecord(app) ? app.team_id : undefined;
      if (!isNamedResource(app) || app.id !== command.appId || typeof appTeam !== "string") throw new Error("Invalid app response");
      if ((command.team || command.teamId) && appTeam !== state.teamId) return {
        id: "app", title: "App", status: "fail", detail: "The requested app does not belong to the selected team.",
      };
      state.appId = app.id;
      return { id: "app", title: "App", status: "pass", detail: `Verified app ${app.name}.`, evidence: {appId: app.id, appName: app.name, teamId: appTeam} };
    }
    const response = await doctorGet(
      deps,
      state.serverUrl,
      `/v1/teams/${encodeURIComponent(state.teamId!)}/apps`,
      state.token,
    );
    const apps = parseNamedResourceList(response, "apps");
    const selector = command.app!;
    const match = matchNamedResource(apps, selector, "App");

    if (match.kind !== "matched") {
      return resourceMatchFailure("app", selector, match);
    }

    state.appId = match.resource.id;
    return {
      detail: `Resolved app ${match.resource.name}.`,
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
      ...(error instanceof DoctorRedirectError ? {reason: "redirect"} : {}),
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

  if (command.deployment === undefined && command.deploymentId === undefined) {
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
    const selector = command.deploymentId ?? command.deployment!;
    const candidates = command.deploymentId ? deployments.filter(resource => resource.id === command.deploymentId) : deployments;
    const match = matchNamedResource(candidates, command.deploymentId ? candidates[0]?.name ?? selector : selector, "Deployment");

    if (match.kind !== "matched") {
      return resourceMatchFailure("deployment", selector, match);
    }

    state.deployment = match.resource;
    state.deploymentId = match.resource.id;
    return {
      detail: `Resolved deployment ${match.resource.name}.`,
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
      ...(error instanceof DoctorRedirectError ? {reason: "redirect"} : {}),
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

class DoctorRedirectError extends Error {
  constructor(readonly target?: string) { super("Control-plane redirect"); }
}

async function doctorGet(
  deps: Pick<CommandDeps, "fetch">,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
): Promise<unknown> {
  const response = await deps.fetch(buildApiUrl(serverUrl, pathname), {
    headers: token !== undefined ? { authorization: `Bearer ${normalizeBearerToken(token)}` } : {},
    method: "GET", redirect: "manual",
    signal: AbortSignal.timeout(DOCTOR_REQUEST_TIMEOUT_MS),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    let target: string | undefined;
    try { target = location ? safeUrl(new URL(location, buildApiUrl(serverUrl, pathname)).toString()) : undefined; } catch { /* unavailable */ }
    throw new DoctorRedirectError(target);
  }
  return request(async () => response, buildApiUrl(serverUrl, pathname), { method: "GET" });
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
  if (error instanceof DoctorRedirectError) return `The control-plane endpoint redirected${error.target ? ` to ${error.target}` : ""}. No credentials were forwarded. Verify the canonical server URL and rerun with --server-url.`;
  if (isTimeoutError(error)) {
    return `The request did not respond within ${DOCTOR_REQUEST_TIMEOUT_MS / 1000} seconds.`;
  }

  if (error instanceof HttpProblemError) {
    return `Control-plane request failed (HTTP ${error.responseStatus}).`;
  }
  return "The control-plane request failed or returned an unexpected response.";
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

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function runNativeChecks(
  deps: CommandDeps,
  command: DoctorCommand,
  context: {
    projectRoot: string;
    projectRootExists: boolean;
    state: DoctorExecutionState;
    iosVersionSource?: PlatformDiscovery["iosVersionSource"];
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
    iosVersionSource?: PlatformDiscovery["iosVersionSource"];
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
    // The resolver can still pick the plist from a project, target or build
    // configuration the flags name; only a bare invocation has nothing to go on.
    const selectsIosTarget =
      command.xcodeProjectFile !== undefined ||
      command.xcodeTargetName !== undefined ||
      command.buildConfigurationName !== undefined;
    if (platform === "ios" && context.iosVersionSource && !context.iosVersionSource.plistFile && !selectsIosTarget) {
      return {
        id: "target-binary-version",
        title: "Target binary version",
        status: "skip",
        reason: "unresolved",
        detail: "The iOS application plist is not selected; a version from another target cannot be used.",
        advice: ["Select --plist-file <app-plist-path>, --xcode-target-name <name> or --build-configuration-name <name>, or pass --target-binary-version <version>."],
      };
    }
    const selectedFile = platform === "ios"
      ? command.plistFile ?? context.iosVersionSource?.plistFile
      : command.gradleFile;
    const selectedPath = selectedFile === undefined ? undefined : resolve(context.projectRoot, selectedFile);
    const selectedSource = selectedPath === undefined ? undefined : await readDoctorSource(selectedPath);
    if (selectedSource !== undefined && selectedSource.state !== "resolved") {
      return {
        id: "target-binary-version",
        title: "Target binary version",
        status: selectedSource.state === "missing" ? "fail" : "skip",
        detail: "The selected binary-version source could not be read within the diagnostic limits.",
        evidence: { source: selectedPath, reason: selectedSource.reason },
        advice: ["Inspect the selected file or pass --target-binary-version <version>."],
      };
    }
    const targetBinaryVersion = await resolveTargetBinaryVersion({
      ...deps,
      readFile: file => selectedSource !== undefined && resolve(file) === selectedPath
        ? Promise.resolve(Buffer.from(selectedSource.text!, "utf8"))
        : deps.readFile(file),
    }, {
      platform,
      projectRoot: context.projectRoot,
      ...(platform === "ios" ? context.iosVersionSource : {}),
      ...(command.plistFile !== undefined ? { plistFile: command.plistFile } : {}),
      ...(command.xcodeProjectFile !== undefined ? { xcodeProjectFile: command.xcodeProjectFile } : {}),
      ...(command.xcodeTargetName !== undefined ? { xcodeTargetName: command.xcodeTargetName } : {}),
      ...(command.buildConfigurationName !== undefined ? { buildConfigurationName: command.buildConfigurationName } : {}),
      ...(command.gradleFile !== undefined ? { gradleFile: command.gradleFile } : {}),
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
    ...(context.appId !== undefined
      ? { appId: summarizeEffectiveValue(context.appId) }
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

// Mirrors the `StoredCredential` union in `src/credentialStore.ts`: an OAuth
// credential carries refresh-token fields, a token credential (from
// `cmpatch login --token`) does not. Checking only the OAuth shape made this
// check fail every personal-access-token login, which is the documented path for
// CI and other headless machines.
function isStoredCredential(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== "string" ||
    !isStoredUser(value.user)
  ) {
    return false;
  }

  if (value.kind === "token") {
    return true;
  }

  // `kind` is absent on credentials written before the discriminator existed;
  // those are always OAuth-shaped.
  return (
    (value.kind === "oauth" || value.kind === undefined) &&
    typeof value.accessTokenExpiresAt === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.refreshTokenExpiresAt === "string"
  );
}

function isStoredUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.email === "string" &&
    typeof value.id === "string" &&
    (typeof value.displayName === "string" || value.displayName === null)
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

  return " (source could not be read or parsed)";
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
  palette: Palette = PLAIN_PALETTE,
): string {
  if (!isDoctorResult(result)) {
    throw new UsageError("Cannot render doctor output: invalid doctor result");
  }

  const platforms = Object.keys(result.coverage.setup.platforms ?? {});
  const lines = [
    palette.heading(`${PRODUCT_NAME} doctor · ${basename(resolve(command.projectRoot))}`),
    palette.dim(`Platforms: ${platforms.length ? platforms.join(", ") : command.platform ?? "not determined"} · ${command.verifyDelivery ? "Setup and delivery verification" : "Setup checks; delivery not requested"}`),
    "", renderVerdict(result, palette), "",
  ];
  const afterFix = result.fixes?.some((fix) => fix.status === "applied") === true;
  if (afterFix) lines.push(result.groups.some((group) => group.checks.some(isProblemCheck))
    ? "Configuration saved and diagnostics rechecked. Remaining findings:"
    : "Configuration saved and diagnostics rechecked. No remaining actionable findings.");
  const blockers = doctorBlockers(result.groups);

  for (const group of result.groups) {
    if (afterFix && !command.verbose && !group.checks.some(isProblemCheck) && !group.checks.some(isNoticeCheck)) continue;
    lines.push(renderGroupLine(group, palette));
    const visibleChecks = command.verbose
      ? group.checks
      : group.checks.filter((check) => !blockers.has(check) && (isProblemCheck(check) || isNoticeCheck(check)));
    for (const check of visibleChecks) {
      lines.push(...renderCheckLines(check, palette, command.verbose === true));
    }
    if (!command.verbose) {
      const affected = new Map<DoctorCheckResult, number>();
      for (const check of group.checks) {
        for (const root of blockers.get(check) ?? []) {
          affected.set(root, (affected.get(root) ?? 0) + 1);
        }
      }
      for (const [root, count] of affected) {
        lines.push(palette.dim(`  ○ ${count} ${count === 1 ? "check" : "checks"} blocked by ${root.title} [${root.id}${root.platform ? ` / ${root.platform}` : ""}].`));
      }
    }
  }

  lines.push("");
  const coverageLine = (label: string, coverage: DoctorResult["coverage"]["setup"]) =>
    `${label}: ${coverage.state.replaceAll("_", " ")} (${coverage.outcome.replaceAll("_", " ")}).`;
  lines.push(coverageLine("Setup", result.coverage.setup));
  lines.push(coverageLine("Delivery", result.coverage.delivery));
  if (result.coverage.delivery.state === "not_requested") {
    lines.push("Run `cmpatch doctor --verify-delivery` to check published artifacts.");
  }
  lines.push("Static/CLI evidence does not verify behavior on a device.");
  if (result.fixes) {
    if (!result.fixes.length) lines.push("No supported configuration fixes are available for these inputs.");
    for (const fix of result.fixes) {
      lines.push(`Configuration fix: ${fix.status} — ${fix.file} (${fix.field}).`);
      if (fix.detail) lines.push(fix.detail);
      if (fix.status === "declined") lines.push("No file was created. Use an interactive terminal or --fix --yes to apply this configuration-only fix.");
    }
  }

  const handoffHint = renderHandoffHint(result);
  if (handoffHint !== null) {
    lines.push(palette.dim(handoffHint));
  }

  if (command.verbose !== true && countHiddenChecks(result) > 0) {
    lines.push(
      palette.dim("Run `cmpatch doctor --verbose` to see all checks."),
    );
  }

  return `${lines.join("\n")}\n`;
}

const STATUS_SYMBOLS: Record<DoctorCheckStatus, string> = {
  fail: "✗",
  pass: "✓",
  skip: "○",
  warn: "!",
};

function paintStatus(status: DoctorCheckStatus, palette: Palette): string {
  const symbol = STATUS_SYMBOLS[status];
  switch (status) {
    case "fail":
      return palette.err(symbol);
    case "pass":
      return palette.ok(symbol);
    case "skip":
      return palette.dim(symbol);
    case "warn":
      return palette.warn(symbol);
  }
}

/**
 * A group inherits the worst status of its checks: any failure taints the
 * group, an actionable skip counts as a warning (the user can unblock it),
 * and a group whose checks were all skipped is reported as skipped rather
 * than passed.
 */
function rollupGroupStatus(group: DoctorCheckGroup): DoctorCheckStatus {
  if (group.checks.some((check) => check.status === "fail")) {
    return "fail";
  }

  if (
    group.checks.some(
      (check) => check.status === "warn" || isActionableSkip(check),
    )
  ) {
    return "warn";
  }

  if (group.checks.every((check) => check.status === "skip") || group.checks.some(isDeliveryBoundary)) {
    return "skip";
  }

  return "pass";
}

function renderGroupLine(group: DoctorCheckGroup, palette: Palette): string {
  const status = rollupGroupStatus(group);

  if (status === "skip") {
    return `${paintStatus(status, palette)} ${palette.dim(`${group.title} — ${group.checks.some(isDeliveryBoundary) ? "verification incomplete" : "skipped"}`)}`;
  }

  return `${paintStatus(status, palette)} ${group.title}`;
}

function isProblemCheck(check: DoctorCheckResult): boolean {
  return (
    check.status === "fail" ||
    check.status === "warn" ||
    isActionableSkip(check)
  );
}

function renderCheckLines(
  check: DoctorCheckResult,
  palette: Palette,
  includeEvidence: boolean,
): string[] {
  const [firstIssue, ...remainingIssues] = check.issues ?? [];
  const lines = [
    `  ${check.severity === "info" ? palette.dim("i") : paintStatus(check.status, palette)} ${check.title}${
      firstIssue !== undefined ? ` — ${firstIssue}` : ""
    }`,
  ];

  for (const issue of remainingIssues) {
    lines.push(`      ${issue}`);
  }

  if (check.detail !== undefined && check.detail.length > 0) {
    for (const line of check.detail.split("\n")) {
      lines.push(palette.dim(`      ${line}`));
    }
  }

  for (const advice of check.advice ?? []) {
    lines.push(`      → ${advice}`);
  }

  for (const nextCommand of nextCommandsNotInAdvice(check)) {
    lines.push(palette.dim(`      $ ${nextCommand}`));
  }

  if (includeEvidence && check.evidence !== undefined) {
    lines.push(palette.dim(`      Evidence: ${JSON.stringify(check.evidence)}`));
  }

  return lines;
}

/** Advice lines often spell out the next command verbatim; print it once. */
function nextCommandsNotInAdvice(check: DoctorCheckResult): string[] {
  const advice = check.advice ?? [];

  return (check.nextCommands ?? []).filter(
    (nextCommand) => !advice.some((entry) => entry.includes(nextCommand)),
  );
}

function renderVerdict(result: DoctorResult, palette: Palette): string {
  if (result.fixes?.some((fix) => fix.status === "failed")) {
    return palette.err("✗ Configuration fix could not be applied; review the fix result below.");
  }
  const counts = palette.dim(`(${renderSummaryCounts(result.summary)})`);
  const failedAreas = result.groups.filter((group) =>
    group.checks.some((check) => check.status === "fail"),
  ).length;

  if (failedAreas > 0) {
    return `${palette.err(
      `✗ Doctor found issues in ${failedAreas} ${failedAreas === 1 ? "area" : "areas"}.`,
    )} ${counts}`;
  }

  const warningAreas = result.groups.filter(
    (group) => rollupGroupStatus(group) === "warn",
  ).length;

  if (warningAreas > 0) {
    return `${palette.warn(
      `! Doctor found warnings in ${warningAreas} ${warningAreas === 1 ? "area" : "areas"}.`,
    )} ${counts}`;
  }

  if (result.coverage.setup.state !== "complete") {
    return `${palette.dim("○ No confirmed failures; setup verification is incomplete.")} ${counts}`;
  }
  if (result.coverage.delivery.state === "incomplete") {
    return `${palette.dim("○ Setup checks passed; delivery verification is incomplete.")} ${counts}`;
  }
  return `${palette.ok(result.coverage.delivery.state === "complete"
    ? "✓ Setup and published artifact accessibility checks passed."
    : "✓ Evaluated setup checks passed.")} ${counts}`;
}

/**
 * The clean-run handoff pointer: passed setup checks cannot prove the device
 * side, so the closing hint tells the user where to look if updates still do
 * not arrive. Rendered as a footer so a healthy run stays all-green.
 */
function renderHandoffHint(result: DoctorResult): string | null {
  const commands = result.groups
    .flatMap((group) => group.checks)
    .filter(
      (check) =>
        check.id === "device-debug-handoff" && check.status === "pass",
    )
    .flatMap((check) => check.nextCommands ?? []);

  if (commands.length === 0) {
    return null;
  }

  return `If updates still do not appear on a device, run ${commands
    .map((command) => `\`${command}\``)
    .join(" or ")} while reproducing an update check.`;
}

function countHiddenChecks(result: DoctorResult): number {
  return result.groups
    .flatMap((group) => group.checks)
    .filter((check) => !isProblemCheck(check) && !isNoticeCheck(check)).length;
}

function createDoctorResult(groups: DoctorCheckGroup[]): DoctorResult {
  for (const group of groups)
    for (const check of group.checks) {
      check.scope ??= "setup";
      if (check.status === "skip") check.reason ??= "unresolved";
      if (check.reason === "blocked" && !check.prerequisites)
        check.prerequisites = ["auth"];
    }
  const checks = groups.flatMap((group) => group.checks);
  const summarizeScope = (items: DoctorCheckResult[]): DoctorCoverage => {
    const applicable = items.filter(
      (check) =>
        check.severity !== "info" &&
        !["not_applicable", "not_configured"].includes(check.reason ?? ""),
    );
    const reasons = [
      ...new Set(
        applicable
          .filter(
            (check) => check.status === "skip" || ["unresolved", "deferred"].includes(check.reason ?? ""),
          )
          .map((check) => check.reason ?? "unresolved"),
      ),
    ];
    const state =
      applicable.length > 0 &&
      applicable.every((check) => check.reason === "not_requested")
        ? "not_requested"
        : !applicable.length || reasons.length
          ? "incomplete"
          : "complete";
    return {
      state,
      outcome: applicable.some((check) => check.status === "fail")
        ? "failed"
        : state !== "complete"
          ? "not_verified"
          : applicable.some((check) => check.status === "warn")
            ? "warnings"
            : "passed",
      reasons,
    };
  };
  const coverageFor = (scope: "setup" | "delivery"): DoctorCoverage => {
    const scoped = checks.filter((check) => check.scope === scope);
    const shared = scoped.filter((check) => !check.platform);
    return {
      ...summarizeScope(scoped),
      platforms: Object.fromEntries(
        (["ios", "android"] as const)
          .filter((platform) =>
            scoped.some(
              (check) =>
                check.platform === platform &&
                check.reason !== "not_configured",
            ),
          )
          .map((platform) => [
            platform,
            summarizeScope([
              ...shared,
              ...scoped.filter((check) => check.platform === platform),
            ]),
          ]),
      ),
    };
  };
  const summary = {
    fail: countChecks(checks, "fail"),
    pass: countChecks(checks, "pass"),
    skip: countChecks(checks, "skip"),
    total: checks.length,
    warn: countChecks(checks, "warn"),
  };

  return {
    command: "doctor",
    coverage: {
      setup: coverageFor("setup"),
      delivery: coverageFor("delivery"),
    },
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

function renderSummaryCounts(summary: DoctorResult["summary"]): string {
  if (summary.total === 0) {
    return "no checks ran";
  }

  return [
    formatCount(summary.pass, "check passed", "checks passed"),
    formatCount(summary.warn, "warning", "warnings"),
    formatCount(summary.fail, "failed", "failed"),
    formatCount(summary.skip, "skipped", "skipped"),
  ]
    .filter((part) => part !== null)
    .join(", ");
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

function isDeliveryBoundary(check: DoctorCheckResult): boolean {
  return check.status === "skip" && ["no_artifact", "embedded_target"].includes(check.reason ?? "");
}

function isNoticeCheck(check: DoctorCheckResult): boolean {
  return check.severity === "info" || isDeliveryBoundary(check);
}

function isActionableSkip(check: DoctorCheckResult): boolean {
  if (isNoticeCheck(check)) return false;
  if (check.status === "skip" && ["blocked", "unresolved", "deferred"].includes(check.reason ?? "")) return true;
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
