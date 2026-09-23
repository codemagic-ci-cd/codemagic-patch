import { basename, isAbsolute, relative } from "node:path";

import type { ConfigCommand, ContextCommand, InitCommand } from "../commandTypes";
import { authenticatedRequest, isAuthenticationFailure } from "../authenticatedRequest";
import { PRODUCT_NAME, SELFHOST_DOCS_URL } from "../branding";
import { normalizeServerUrl } from "../credentialStore";
import { RequestNetworkError } from "../http";
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
  type ConfigSource,
  type EffectiveValue,
  resolveEffectiveContext,
  resolveProjectRoot,
} from "../localContext";
import { writeClosing, writeMessage, writeNote, writeOpening } from "../notice";
import { createPalette, isRecord, writeLine, type WritableStream } from "../output";
import {
  listNamedResources,
  promptBundler,
  promptName,
  promptResource,
  promptResourceOrCreate,
  promptServerUrl,
  type NamedResource,
} from "../flagPrompts";
import {
  detectNativePlatforms,
  detectProjectBundler,
  detectProjectName,
  formatBundlerName,
  type NativePlatform,
} from "../projectAnalysis";
import type { PromptFn } from "../prompt";
import { onInterruptCleanup } from "../progress";
import { getCliVersion } from "../version";
import { PromptAbortError } from "../prompt";
import { runWire, type WireOptions } from "../wire/run";
import type { WireResult } from "../wire/types";
import { isWorktreeDirty } from "../wire/worktree";
import { executeLogin } from "./auth";
import { runInstall, type InstallOutcome } from "./selfhostInstall";
import { parseWireFlags, WIRE_BOOLEAN_FLAGS } from "./wire";
import {
  assertHttpUrl,
  buildApiUrl,
  canPromptInteractively,
  type CommandDeps,
  UsageError,
} from "./shared";

export async function executeConfigCommand(
  command: ConfigCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const [subcommand, rawKey, value, ...extra] = command.argv;
  const key = rawKey === undefined ? undefined : normalizeConfigKey(rawKey);
  const config = await loadCliConfig({ env: deps.env });

  if (subcommand === "list" && key === undefined) {
    return scalarConfigView(config);
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
  const projectRoot = command.projectRoot ?? process.cwd();

  const userConfig = await loadCliConfig({ env: deps.env });
  const projectConfig = await loadProjectConfig(projectRoot);
  const context = resolveEffectiveContext(
    deps.env,
    userConfig,
    projectConfig,
    projectRoot,
  );

  if (!command.remote) {
    if (deps.stderr?.isTTY === true) {
      writeLine(
        deps.stderr,
        "Tip: run `cmpatch context --remote` to include server-provided SDK configuration.",
      );
    }
    return context;
  }

  const serverUrl = context.serverUrl?.value;
  if (serverUrl === undefined) {
    throw new UsageError(
      "Remote SDK configuration requires a server URL. Pass CODEMAGIC_PATCH_SERVER_URL, configure the project, or run `cmpatch config set server-url <url>`.",
    );
  }

  const response = await authenticatedRequest(deps, {
    init: { method: "GET" },
    serverUrl,
    token: command.token,
    url: buildApiUrl(serverUrl, "/v1/sdk-config"),
  });

  return {
    ...context,
    sdkConfig: {
      apiUrl: assertHttpUrl(serverUrl).replace(/\/+$/, ""),
      downloadBaseUrl: readSdkDownloadBaseUrl(response),
    },
  };
}

export function readSdkDownloadBaseUrl(response: unknown): string {
  if (
    !isRecord(response) ||
    typeof response.download_base_url !== "string" ||
    response.download_base_url.trim().length === 0
  ) {
    throw new Error("SDK config lookup returned an invalid response");
  }

  return response.download_base_url.trim();
}

/**
 * `config` speaks only for the scalar user defaults. The `selfhost` and
 * `pendingInstall` sections live in the same file, but they are ssh state the
 * `selfhost` commands own — not something to get, set, unset, or print here.
 * Narrowing the key type is also what keeps `config set` from assigning a
 * string over a section.
 */
type ScalarConfigKey = "serverUrl" | "team" | "teamId";

function isConfigKey(key: string): key is ScalarConfigKey {
  return key === "serverUrl" || key === "team" || key === "teamId";
}

function scalarConfigView(config: CliConfig): CliConfig {
  return {
    ...(config.serverUrl !== undefined ? { serverUrl: config.serverUrl } : {}),
    ...(config.team !== undefined ? { team: config.team } : {}),
    ...(config.teamId !== undefined ? { teamId: config.teamId } : {}),
  };
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
  /** Plan everything, write nothing: no config, no app creation, no wiring edits. */
  dryRun: boolean;
  iosApp?: string;
  iosAppId?: string;
  iosDeployment?: string;
  iosDeploymentId?: string;
  nonInteractive: boolean;
  platform?: string;
  projectRoot?: string;
  serverUrl?: string;
  /** Connection-only setup; wiring is reported as skipped, not as incomplete. */
  skipWire: boolean;
  team?: string;
  teamId?: string;
  token?: string;
  yes: boolean;
};

export type InitWiring =
  | WireResult
  | { status: "skipped" }
  /** Wiring could not run at all; the connection is saved regardless. */
  | { status: "failed"; error: string };

async function linkProject(
  args: string[],
  deps: CommandDeps,
  projectRoot: string,
  existingConfig: ProjectConfig,
): Promise<unknown> {
  const flags = parseLinkFlags(args);
  validatePlatformSpecificFlags(flags);
  const wireOptions = flags.skipWire
    ? null
    : parseWireFlags(args.filter((token) => !/^--skip-wire(=|$)/.test(token)), INIT_VALUE_FLAGS);
  const interactive =
    canPromptInteractively(deps, flags.nonInteractive === true) &&
    !flags.yes &&
    deps.prompt !== undefined;

  // The prompt tree opens before the first question, with the welcome, and
  // every way out of the flow closes it: `writeClosing` on the two planned
  // exits below, and here on anything thrown, so the error printed after it
  // lands under a closed tree rather than inside an open one.
  if (!interactive || deps.stderr === undefined) {
    return linkProjectFlow(
      wireOptions,
      flags,
      interactive,
      deps,
      projectRoot,
      existingConfig,
    );
  }
  const stderr = deps.stderr;
  openInitFlow(stderr, deps.env, projectRoot, existingConfig, flags.dryRun);
  try {
    return await linkProjectFlow(
      wireOptions,
      flags,
      interactive,
      deps,
      projectRoot,
      existingConfig,
    );
  } catch (error) {
    writeClosing(stderr, "");
    throw error;
  }
}

/**
 * What the user sees before init's first question: which command this is,
 * and what it is about to do — where the link goes, what will be asked, and
 * when the file is written — so the questions that follow read as steps of
 * one thing instead of arriving cold. The version is on the line because a
 * report of what went wrong starts with which cmpatch it was.
 */
function openInitFlow(
  stderr: WritableStream,
  env: Record<string, string | undefined>,
  projectRoot: string,
  existingConfig: ProjectConfig,
  dryRun: boolean,
): void {
  const palette = createPalette(stderr, env);
  writeOpening(
    stderr,
    `${PRODUCT_NAME} · cmpatch init ${palette.dim(getCliVersion())}${dryRun ? " (dry run)" : ""}`,
  );
  const verb = Object.keys(existingConfig).length === 0 ? "links" : "re-links";
  writeMessage(stderr, [
    `Welcome! This command ${verb} the app in ${describeProjectRoot(projectRoot)} to a ${PRODUCT_NAME} server, writes codemagic-patch.config.json next to it, and then wires the SDK into the app.`,
    "It asks which server to use, signs you in, and picks the app and its deployments.",
    dryRun
      ? "This is a dry run: nothing is written and no app is created."
      : "The config file is only written after the last answer; the SDK changes are shown and confirmed before they are made.",
  ]);
}

/** The project root as the user would name it: relative when it is nearby. */
function describeProjectRoot(projectRoot: string): string {
  const fromHere = relative(process.cwd(), projectRoot);
  if (fromHere === "") {
    return "this directory";
  }
  return isAbsolute(fromHere) || fromHere.startsWith("..")
    ? projectRoot
    : fromHere;
}

async function linkProjectFlow(
  /** Null when wiring is skipped. */
  wireOptions: WireOptions | null,
  flags: LinkFlags,
  interactive: boolean,
  deps: CommandDeps,
  projectRoot: string,
  existingConfig: ProjectConfig,
): Promise<unknown> {
  const userConfig = await loadCliConfig({ env: deps.env });
  const effectiveContext = resolveEffectiveContext(
    deps.env,
    userConfig,
    existingConfig,
    projectRoot,
  );
  let serverUrl: string | undefined;
  /** Set only by the install handoff, which is the one path that owes a sign-in. */
  let installed: InstallOutcome | undefined;
  if (flags.serverUrl !== undefined) {
    serverUrl = flags.serverUrl;
  } else if (interactive && deps.prompt) {
    // The branch point, and the only place init knows anything about
    // self-hosting: the question is where this project's server comes from.
    // A machine that already knows a server gets it as the first answer, but
    // the other two stay on the menu — a second project on the same machine
    // may well need a second server. Installing hands off wholesale to the
    // wizard and takes back a URL — no install flag, question, or step lives
    // here.
    const known = effectiveContext.serverUrl;
    const source = await chooseServerSource(deps, deps.prompt, known, flags.dryRun);
    switch (source) {
      case "exit":
        if (deps.stderr !== undefined) {
          writeClosing(deps.stderr, "Nothing was changed.");
        }
        return renderReadTheDocsFirst();
      case "install":
        if (flags.dryRun) {
          throw new UsageError("A dry run cannot install a server. Use an existing server URL, or run again without --dry-run.");
        }
        installed = await installServer(deps);
        serverUrl = installed.serverUrl ?? undefined;
        break;
      case "use-known":
        serverUrl = known?.value;
        break;
      case "enter-url":
        serverUrl = await askReachableServerUrl(deps, deps.prompt);
        break;
    }
  } else {
    serverUrl = effectiveContext.serverUrl?.value;
  }
  if (serverUrl === undefined) {
    throw new UsageError(
      "Init needs a server URL. Pass --server-url <url> or run `cmpatch config set server-url <url>`.",
    );
  }
  serverUrl = assertHttpUrl(serverUrl);

  if (installed !== undefined) {
    await signInToNewServer(deps, serverUrl, installed);
  }

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
  // Creating an app is part of linking a project, not a separate command the
  // user has to discover: the picker used to refuse an empty list, and only
  // list what was already there otherwise, so both a server that has never had
  // an app and a team holding somebody else's ended the run at
  // `cmpatch app create`. One app per platform, because a deployment serves
  // one platform's releases and the documented model is an app per platform.
  // Nothing here is self-host-specific — it is about what the team holds,
  // however the project got there.
  const projectName = await detectProjectName(deps, projectRoot);
  const createApp =
    interactive && deps.prompt !== undefined
      ? (platform: NativePlatform) => {
          if (flags.dryRun) {
            throw new UsageError(
              `The team has no ${platform} app yet, and a dry run creates nothing. Run again without --dry-run, or create one with \`cmpatch app create\`.`,
            );
          }
          return createFirstApp(deps, deps.prompt as PromptFn, {
            defaultName: `${projectName ?? basename(projectRoot)}-${platform}`,
            noun: `${platform} app`,
            serverUrl,
            teamId: team.id,
            ...(flags.token !== undefined ? { token: flags.token } : {}),
          });
        }
      : null;

  const platformConfigs: ProjectPlatformConfigMap = {};
  const dashboard: Partial<Record<NativePlatform, string>> = {};
  for (const platform of platforms) {
    const app = await selectAppForPlatform(
      deps,
      apps,
      flags,
      platform,
      autoSelected,
      interactive,
      createApp,
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
    dashboard[platform] = deploymentPageUrl(serverUrl, team.id, app.id, deployment.id);
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
  // Read before the config is written: the file init is about to create
  // must not be what makes the tree look dirty to the wiring gate.
  const worktreeDirty = flags.skipWire ? null : await isWorktreeDirty(deps, projectRoot);
  if (!flags.dryRun) {
    await saveProjectConfig(projectRoot, nextConfig);
  }
  if (interactive && deps.stderr !== undefined) {
    writeMessage(
      deps.stderr,
      flags.dryRun
        ? "Dry run: codemagic-patch.config.json was not written."
        : "Wrote codemagic-patch.config.json",
    );
  }

  const wiring =
    wireOptions === null
      ? { status: "skipped" as const }
      : await wireAfterLinking(deps, {
          connection: nextConfig,
          // The interactive init flow opened the prompt tree wiring continues.
          inheritsTree: interactive && deps.stderr !== undefined,
          options: wireOptions,
          projectRoot,
          worktreeDirty,
        });

  if (interactive && deps.stderr !== undefined) {
    // Closes the prompt tree the interactive init flow opened.
    writeClosing(deps.stderr, flags.dryRun ? "Dry run: nothing written" : describeInitOutcome(wiring));
  }

  // What the closing summary needs beyond the config: the team by name, the
  // dashboard page per deployment, and the server this project was pointed
  // at before — when that was a local evaluation stack, the SDK in the app
  // still carries its URL and key.
  const previousServerUrl = existingConfig.serverUrl;
  return {
    command: "init",
    config: nextConfig,
    dashboard,
    dryRun: flags.dryRun,
    exitCode: "status" in wiring ? (wiring.status === "failed" ? 1 : 0) : wiring.exitCode,
    nextActions: [
      "cmpatch context",
      "cmpatch release-react --dry-run",
    ],
    ...(previousServerUrl !== undefined &&
    safeNormalize(previousServerUrl) !== safeNormalize(serverUrl)
      ? { previousServerUrl }
      : {}),
    projectName: projectName ?? basename(projectRoot),
    projectRoot,
    team: { id: team.id, name: team.name },
    wiring,
  };
}

/**
 * Wiring, with the connection already saved: an error that is not the
 * user's interruption or an authentication refusal becomes the wiring outcome
 * rather than the run's, so the report still says the link is in place.
 */
async function wireAfterLinking(
  deps: CommandDeps,
  input: Parameters<typeof runWire>[1],
): Promise<InitWiring> {
  try {
    const result = await runWire(deps, input);
    return input.options.dryRun
      ? { ...result, nextSteps: ["Link the project and apply this plan by running init again without --dry-run."] }
      : result;
  } catch (error) {
    if (error instanceof PromptAbortError || isAuthenticationFailure(error)) {
      throw error;
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export function describeInitOutcome(wiring: InitWiring): string {
  if ("status" in wiring) {
    return wiring.status === "skipped" ? "Linked; SDK wiring skipped" : "Linked; SDK wiring failed";
  }
  switch (wiring.result) {
    case "complete":
      return "Linked and wired";
    case "incomplete":
      return "Linked; SDK wiring has steps left";
    case "failed":
      return "Linked; SDK wiring failed";
  }
}

/** The dashboard page for one deployment — where its releases are listed. */
function deploymentPageUrl(
  serverUrl: string,
  teamId: string,
  appId: string,
  deploymentId: string,
): string {
  return `${serverUrl.replace(/\/+$/u, "")}/teams/${encodeURIComponent(teamId)}/apps/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}`;
}

function safeNormalize(serverUrl: string): string {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return serverUrl;
  }
}

type ServerSource = "enter-url" | "exit" | "install" | "use-known";

const SERVER_SOURCE_LABELS: Record<ConfigSource, string> = {
  env: "the environment",
  project: "this project",
  user: "your CLI settings",
};

/**
 * Where a project gets its server.
 *
 * With nothing known there are three answers and no fourth: a URL the user
 * already has, an install performed right here, or a way out that is not an
 * error — someone who wants to read first should not have to type a URL to
 * escape a prompt.
 *
 * With a server already known to this machine the known URL takes the top
 * slot and the exit goes, but entering another URL and installing stay: a
 * remembered address is a default, not a decision made for every project on
 * the machine. The note says where the address came from so a stale user
 * default or an env override is recognisable before it is accepted.
 */
async function chooseServerSource(
  deps: CommandDeps,
  prompt: PromptFn,
  known: EffectiveValue | undefined,
  dryRun: boolean,
): Promise<ServerSource> {
  if (deps.stderr !== undefined) {
    if (known === undefined) {
      writeNote(deps.stderr, `No ${PRODUCT_NAME} server found`, [
        "Checked the environment, this project, and your CLI settings.",
      ]);
    } else {
      writeNote(deps.stderr, `${PRODUCT_NAME} server found`, [
        `${known.value} (from ${SERVER_SOURCE_LABELS[known.source]})`,
      ]);
    }
  }

  const answer = await prompt({
    choices: (
      known === undefined
        ? [
            { title: "Install a self-hosted server now", value: "install" },
            { title: "Enter an existing server URL", value: "enter-url" },
            { title: "Exit — read the self-hosting docs first", value: "exit" },
          ]
        : [
            { title: `Use ${known.value}`, value: "use-known" },
            { title: "Enter a different server URL", value: "enter-url" },
            { title: "Install a self-hosted server now", value: "install" },
          ]).filter((choice) => !dryRun || choice.value !== "install"),
    message: "How do you want to connect to a server?",
    type: "select",
  });

  const value = Array.isArray(answer) ? answer[0] : answer;
  if (value === "install" || value === "enter-url") {
    return value;
  }
  if (known === undefined) {
    return value === "exit" ? "exit" : "enter-url";
  }
  return value === "use-known" ? "use-known" : "enter-url";
}

const SERVER_PROBE_TIMEOUT_MS = 10_000;

/**
 * A typed URL, checked against the server behind it before anything is built
 * on it. The form check inside `promptServerUrl` catches a missing scheme;
 * this catches the likelier mistake — a host typed wrong, or the address of
 * something that is not a Patch server — which used to surface as the team
 * listing failing and the run ending. A mistake found here costs one more
 * question, with the typed value left in the field to correct.
 *
 * The probe is `/health/ready`, which needs no sign-in: whether the user is
 * signed in to this server is the next step's question, not this one's.
 */
async function askReachableServerUrl(
  deps: CommandDeps,
  prompt: PromptFn,
): Promise<string> {
  let initial: string | undefined;
  for (;;) {
    const serverUrl = await promptServerUrl(deps, prompt, initial);
    if (deps.stderr !== undefined) {
      writeLine(deps.stderr, `Checking ${serverUrl}…`);
    }

    const problem = await describeServerProblem(deps, serverUrl);
    if (problem === null) {
      return serverUrl;
    }

    if (deps.stderr !== undefined) {
      writeLine(deps.stderr, problem);
    }
    initial = serverUrl;
  }
}

/**
 * What is wrong with the server at a URL, or null when it answers like a
 * ready Patch server. Three failures are told apart because each needs a
 * different fix: nothing answered (the address), something answered that is
 * not a Patch server (the address, again — a dashboard or an unrelated site),
 * and a Patch server that is up but not ready (the server).
 */
async function describeServerProblem(
  deps: CommandDeps,
  serverUrl: string,
): Promise<string | null> {
  const url = buildApiUrl(serverUrl, "/health/ready");

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return `No answer from ${serverUrl} within ${SERVER_PROBE_TIMEOUT_MS / 1000} seconds. Check the URL and that the server is reachable.`;
    }
    return new RequestNetworkError(url, error).message;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const answersLikePatch =
    isRecord(body) && typeof body.ok === "boolean" && Array.isArray(body.checks);

  if (response.ok && answersLikePatch) {
    return null;
  }

  if (response.status === 503 && answersLikePatch) {
    return `The ${PRODUCT_NAME} server at ${serverUrl} is running but not ready: its database check is failing. Check the server, then enter the URL again.`;
  }

  return `${serverUrl} answered, but not like a ${PRODUCT_NAME} server (HTTP ${response.status} from ${url}). Check that this is the server's address and not another site.`;
}

/**
 * The handoff. init hands the whole installation to `selfhost install` and
 * takes back one thing — the server URL — which is what keeps every install
 * question, flag, and step out of this command.
 */
async function installServer(deps: CommandDeps): Promise<InstallOutcome> {
  const outcome = await runInstall(deps, [], { handoff: true });
  writeInstallSummary(deps, outcome.summary);

  if (outcome.serverUrl === null) {
    // The server is up either way — this is init unable to continue, not an
    // install that failed, and the message has to say which.
    throw new UsageError(
      [
        "The server is installed, but its address could not be read back, so init cannot continue on its own.",
        "",
        "Link the project to it with:",
        "  cmpatch init --server-url <url>",
      ].join("\n"),
    );
  }

  return outcome;
}

/** The one prompt with no answer: the install is done, and init carries on. */
const CONTINUE_TO_SIGN_IN = "Press Enter to open the browser and sign in";

/** What that sign-in is for, printed above the pause so Enter is informed. */
const SIGN_IN_PREVIEW =
  "Next, your browser opens the new dashboard. Signing in there creates the administrator account and connects cmpatch to the server.";

/**
 * The first sign-in to a server this run just installed, done here rather than
 * left as a `cmpatch login` the user runs afterwards.
 *
 * It is one browser round-trip because the dashboard's `/cli/authorize` sits
 * behind its sign-in and preserves the request across it: the GitHub sign-in
 * that creates the admin account, the approval, and the CLI token all happen
 * on that one visit. The method question `cmpatch login` asks is skipped —
 * init is mid-flow, and the browser is the only method that can create the
 * admin account it needs next.
 *
 * An abort here is not a dead end: the server URL was persisted before the
 * browser ever opened (the wizard commits it the moment the server is
 * healthy), so the printed recovery command works, and re-running `cmpatch
 * init` resumes at this sign-in instead of offering a second install.
 */
async function signInToNewServer(
  deps: CommandDeps,
  serverUrl: string,
  { adminEmail, signInProvider }: Pick<InstallOutcome, "adminEmail" | "signInProvider">,
): Promise<void> {
  // Ctrl-C during the browser wait would otherwise leave an installed server,
  // a written config, and no idea what to run next. The wait animates a
  // spinner, under which the press never becomes a signal, so this has to be
  // a cleanup hook and not a signal listener; the exit itself is left to it.
  const removeInterruptHook = onInterruptCleanup(async () => {
    writeSignInRecovery(deps, serverUrl);
  });

  try {
    // A pause between the install and the sign-in. The summary just printed
    // is the only place the dashboard address and anything the CDN step left
    // over appear, and the browser about to open would push it off the screen
    // unread. The wait also says what init does next, so the project questions
    // moments from now do not arrive as a change of subject. A Ctrl-C here is
    // the same abort as one at the browser: the recovery below still applies.
    if (deps.prompt !== undefined) {
      if (deps.stderr !== undefined) {
        writeLine(deps.stderr, SIGN_IN_PREVIEW);
      }
      await deps.prompt({
        message: CONTINUE_TO_SIGN_IN,
        optional: true,
        type: "text",
      });
    }

    if (deps.stderr !== undefined) {
      writeNote(deps.stderr, "Signing you in", [
        adminEmail === undefined
          ? `Use the ${signInProvider ?? "sign-in"} account for the administrator email you gave the installer.`
          : `Use the ${signInProvider ?? "sign-in"} account for ${adminEmail}.`,
        "This first sign-in creates the admin account.",
      ]);
    }

    const message = await executeLogin(
      { kind: "login", nonInteractive: true, serverUrl },
      deps,
      {
        writeAuthorizationInstructions: (instructions) => {
          if (deps.stderr !== undefined) {
            writeLine(deps.stderr, instructions);
          }
        },
      },
    );

    if (deps.stderr !== undefined) {
      writeLine(deps.stderr, message);
    }
  } catch (error) {
    writeSignInRecovery(deps, serverUrl);
    throw error;
  } finally {
    removeInterruptHook();
  }
}

/**
 * Fully qualified on purpose: a bare `cmpatch login` depends on this machine's
 * stored server URL, and the recovery has to work in a fresh project and on a
 * machine whose config was never written or has since changed.
 */
function writeSignInRecovery(deps: CommandDeps, serverUrl: string): void {
  if (deps.stderr === undefined) {
    return;
  }

  writeLine(
    deps.stderr,
    `\nThe server is installed and ready. Sign in and finish linking the project with:\n  cmpatch login --server-url ${serverUrl}\n  cmpatch init --server-url ${serverUrl}\nIf the OAuth app credentials are wrong, correct them first with:\n  cmpatch selfhost install --repair\n`,
  );
}

/**
 * The wizard's closing summary, relayed into init's own flow: it carries the
 * dashboard address and anything the CDN step could not finish, and nothing
 * downstream would ever mention those again.
 */
function writeInstallSummary(deps: CommandDeps, summary: string): void {
  if (deps.stderr === undefined) {
    return;
  }

  const [headline = "", ...rest] = summary.split("\n");
  while (rest[0] === "") {
    rest.shift();
  }

  writeNote(deps.stderr, headline, rest);
}

function renderReadTheDocsFirst(): string {
  return [
    `Set up a ${PRODUCT_NAME} server first, then run \`cmpatch init\` again.`,
    "",
    "Self-hosting guide:",
    `  ${SELFHOST_DOCS_URL}`,
  ].join("\n");
}

/**
 * The first app on a server that has none, created from `init` rather than
 * from a command the user has to go and find.
 *
 * It is the same `POST /v1/apps` `cmpatch app create` uses — idempotency key
 * included — so the server stays the only place app creation is implemented,
 * and the Staging and Production deployments it returns are what the
 * deployment picker asks about next.
 */
async function createFirstApp(
  deps: CommandDeps,
  prompt: PromptFn,
  input: {
    defaultName: string;
    noun: string;
    serverUrl: string;
    teamId: string;
    token?: string;
  },
): Promise<NamedResource> {
  const name = await promptName(prompt, input.noun, input.defaultName);
  const response = await authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        name,
        require_code_signing: false,
        team_id: input.teamId,
      }),
      headers: {
        "content-type": "application/json",
        "idempotency-key": deps.randomUUID(),
      },
      method: "POST",
    },
    serverUrl: input.serverUrl,
    ...(input.token !== undefined ? { token: input.token } : {}),
    url: buildApiUrl(input.serverUrl, "/v1/apps"),
  });

  const created = readCreatedApp(response);
  if (deps.stderr !== undefined) {
    writeLine(
      deps.stderr,
      `Created app ${created.name} with Staging and Production deployments.`,
    );
  }

  return created;
}

function readCreatedApp(response: unknown): NamedResource {
  const app = isRecord(response) ? response.app : undefined;
  if (
    !isRecord(app) ||
    typeof app.id !== "string" ||
    typeof app.name !== "string"
  ) {
    throw new Error("App creation returned an invalid response");
  }

  return { id: app.id, name: app.name };
}

/** init's own value flags, which the wiring flag parser lets through. */
const INIT_VALUE_FLAGS: readonly string[] = [
  "app",
  "app-id",
  "android-app",
  "android-app-id",
  "android-deployment",
  "android-deployment-id",
  "bundler",
  "deployment",
  "deployment-id",
  "ios-app",
  "ios-app-id",
  "ios-deployment",
  "ios-deployment-id",
  "platform",
  "project-root",
  "server-url",
  "team",
  "team-id",
];
function parseLinkFlags(args: string[]): LinkFlags {
  const flags: LinkFlags = { dryRun: false, nonInteractive: false, skipWire: false, yes: false };

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
    if (name === "skipWire") {
      flags.skipWire = inlineValue === undefined || inlineValue === "true";
      continue;
    }
    if (name === "dryRun") {
      flags.dryRun = inlineValue === undefined || inlineValue === "true";
      continue;
    }
    // Wiring flags pass through to `parseWireFlags`; `token` and `platform`
    // are init's as well and are read below.
    if ((WIRE_BOOLEAN_FLAGS as readonly string[]).includes(rawName ?? "")) {
      continue;
    }
    if (rawName === "native-projects") {
      if (inlineValue === undefined) index += 1;
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
    // A picker with one entry is not a question. Self-hosted servers have
    // exactly one team by design, so on the fresh-install path this would be
    // the first thing the user is asked and the only possible answer.
    if (teams.length === 1) {
      return teams[0]!;
    }

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
    if (deps.stderr !== undefined) {
      writeLine(
        deps.stderr,
        "Each platform gets its own app on the server; the next questions create or pick one per platform.",
      );
    }
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
  /** Creates this platform's app when the team has none; null when it cannot. */
  createApp: ((platform: NativePlatform) => Promise<NamedResource>) | null,
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
    // Reached only after the flag branches above: an explicit selector names
    // an app the user expects to exist, and creating one behind it would hide
    // a typo.
    if (createApp === null) {
      return promptResource(deps.prompt, `Select app for ${platform}`, apps, "app");
    }

    // A picker with nothing in it is not a question.
    if (apps.length === 0) {
      return createApp(platform);
    }

    // With apps present the list is still offered first — but never as the
    // only answer. A team can hold another project's apps, and a run stopped
    // between creating this project's first app and its second leaves exactly
    // that shape behind: without this, the rerun could only link the second
    // platform to the first platform's app.
    const chosen = await promptResourceOrCreate(
      deps.prompt,
      `Select app for ${platform}`,
      apps,
      "app",
      `Create a new app for ${platform}`,
    );

    return chosen === "create" ? createApp(platform) : chosen;
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
      `Default deployment for ${platform} releases`,
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
    message: "Which platforms does this project ship?",
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
