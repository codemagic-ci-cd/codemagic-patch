// Asking for a required flag instead of failing on it.
//
// A command reaches this module only after the normal resolution order has
// already run: explicit flag, then environment, then stored configuration. So a
// flag that is still missing here is one the user has never supplied anywhere,
// and the CLI already knows how to source it — the `defaults` policy on the
// command says so. That policy is the boundary: this module will never ask for
// a flag the command did not declare as config-resolvable.

import { teamAppsPath } from "./appFramework";
import { hasBooleanOption, readOptionValue } from "./argv";
import {
  CONFIG_DEFAULTED_FLAGS,
  formatFlagAssignment,
  hasFlagOption,
  PROMPTABLE_FLAG_ORDER,
} from "./promptableFlags";
import type { CommandDefaultPolicy } from "./commandSpecs";
import type {
  CommandDefaultFlagValues,
  DeploymentSelector,
  ParseCliResult,
  PromptableFlag,
} from "./commandTypes";
import {
  canPromptOnStderr,
  UsageError,
  type CommandDeps,
} from "./commands/shared";
import {
  noTeamsAvailableError,
  resolveDeploymentId,
} from "./commands/resolveNames";
import {
  listNamedResources,
  listReleaseChoices,
  listReleaseLabels,
  promptBundler,
  promptChoice,
  promptName,
  promptPlatform,
  promptResource,
  promptSelect,
  promptServerUrl,
  promptValue,
  TEAM_ROLES,
  type NamedResource,
} from "./flagPrompts";
import { detectNativePlatforms, detectProjectBundler } from "./projectAnalysis";
import type { WritableStream } from "./output";
import type { PromptFn } from "./prompt";

export type InteractiveFlagDeps = CommandDeps & {
  prompt?: PromptFn;
  stderr?: WritableStream;
  stdin?: { isTTY?: boolean };
};

/**
 * Stricter than `canPromptInteractively`, which only guards stdin. A prompt is
 * drawn on stderr and read from stdin, so BOTH must be a terminal — piping
 * stderr to a log file while stdin stays a tty is a real shape, and a half-drawn
 * prompt there would hang the run. `CI` is checked separately because several
 * runners do allocate a tty.
 */
export function canResolveMissingFlags(
  argv: string[],
  deps: Pick<InteractiveFlagDeps, "env" | "prompt" | "stderr" | "stdin">,
): boolean {
  return (
    canPromptOnStderr(deps, declinesInteraction(argv)) &&
    deps.prompt !== undefined
  );
}

/**
 * Whether the caller has said not to ask.
 *
 * `--non-interactive` says it directly. `--yes` says it too, and skipping it
 * here would be unsafe rather than merely chatty: a resolved selector is only
 * ever shown to the user by the mutation-safety note, and `--yes` is precisely
 * what skips that note. Resolving under it would let `cmpatch app remove --yes`
 * infer a sole app and delete a resource the user never named and never saw.
 * Refusing instead costs one clear "Missing required flag" — and a run that
 * cannot be seen is exactly the run that must not guess.
 */
export function declinesInteraction(argv: string[]): boolean {
  return (
    hasBooleanOption(argv, "--non-interactive") ||
    hasBooleanOption(argv, "--yes")
  );
}

export type InteractiveParseOutcome = {
  /** The values the user supplied, for echoing and for offering to save. */
  answers: CommandDefaultFlagValues;
  result: ParseCliResult;
};

/**
 * Re-parses as answers come in. The parser reports one missing flag at a time
 * (it returns on the first failure), so this walks the chain rather than
 * assuming a single round. `asked` guarantees termination: a flag is offered
 * once, and if answering it does not move the parse forward the original error
 * is returned untouched.
 */
export async function parseWithInteractiveFlags(input: {
  argv: string[];
  commandKind: string;
  defaults: CommandDefaultFlagValues;
  deps: InteractiveFlagDeps;
  parse: (defaults: CommandDefaultFlagValues) => ParseCliResult;
  policy: CommandDefaultPolicy;
  projectRoot: string;
}): Promise<InteractiveParseOutcome> {
  const { argv, commandKind, defaults, deps, parse, policy, projectRoot } = input;
  const answers: CommandDefaultFlagValues = {};
  const asked = new Set<PromptableFlag>();
  let current = { ...defaults };
  let result = parse(current);

  while (!result.ok) {
    const askable = (result.missing ?? []).filter(
      (flag) =>
        !asked.has(flag) &&
        // A flag the user explicitly spelled cannot be asked into a different
        // value: the explicit token wins over any answer on the re-parse, so
        // the question would change nothing — and for a server-side selector
        // it would cost a network round before changing nothing.
        !hasFlagOption(argv, flag) &&
        (isConfigDefaulted(policy, flag) ||
          (policy.prompt ?? []).includes(flag)),
    );

    if (askable.length === 0) {
      return { answers, result };
    }

    for (const flag of askable) {
      asked.add(flag);
    }

    const round = await askFor(askable, {
      argv,
      commandKind,
      current,
      deps,
      // A single available resource may be taken without asking only when a
      // later confirm re-displays it (or nothing is mutated at all); a command
      // that mutates without confirming must ask even a one-option question.
      inferSoleEntry: policy.mutatesWithoutConfirm !== true,
      projectRoot,
    });

    if (Object.keys(round).length === 0) {
      return { answers, result };
    }

    Object.assign(answers, round);
    current = { ...current, ...round };
    result = parse(current);
  }

  return { answers, result };
}

/**
 * Whether stored configuration could have supplied this flag. `name` never
 * can — a name for something being created exists nowhere until the user says
 * it — so it is not part of the config policy at all.
 */
function isConfigDefaulted(
  policy: CommandDefaultPolicy,
  flag: PromptableFlag,
): boolean {
  return (
    CONFIG_DEFAULTED_FLAGS.includes(flag) &&
    policy[flag as keyof Omit<CommandDefaultPolicy, "prompt">] !== undefined
  );
}

async function askFor(
  flags: PromptableFlag[],
  context: {
    argv: string[];
    commandKind: string;
    current: CommandDefaultFlagValues;
    deps: InteractiveFlagDeps;
    inferSoleEntry: boolean;
    projectRoot: string;
  },
): Promise<CommandDefaultFlagValues> {
  const { argv, commandKind, current, deps, inferSoleEntry, projectRoot } =
    context;
  const prompt = deps.prompt;

  if (prompt === undefined) {
    return {};
  }

  const answers: CommandDefaultFlagValues = {};
  // Declaration order in the registry is resolution order; sorting by it means
  // the dependency (server URL before the resources it lists) is stated in one
  // place rather than implied by the order of the branches below.
  const wanted = new Set(
    PROMPTABLE_FLAG_ORDER.filter((flag) => flags.includes(flag)),
  );

  if (wanted.has("name")) {
    // "app-create" -> "app": the noun is what the command creates, so the
    // question reads as a question rather than as a restated flag name.
    const [noun] = commandKind.split("-");
    answers.name = await promptName(prompt, noun ?? "item");
  }

  if (wanted.has("newName")) {
    answers.newName = await promptValue(prompt, "New name");
  }

  if (wanted.has("bundlePath")) {
    answers.bundlePath = await promptValue(prompt, "Path to the bundle");
  }

  if (wanted.has("email")) {
    answers.email = await promptValue(prompt, "Email address");
  }

  if (wanted.has("githubHandle")) {
    answers.githubHandle = await promptValue(prompt, "GitHub handle");
  }

  if (wanted.has("role")) {
    answers.role = await promptChoice(prompt, "Select role", TEAM_ROLES);
  }

  if (wanted.has("fromRole")) {
    answers.fromRole = await promptChoice(
      prompt,
      "Select the role being replaced",
      TEAM_ROLES,
    );
  }

  if (wanted.has("serverUrl")) {
    answers.serverUrl = await promptServerUrl(deps, prompt, current.serverUrl);
  }

  // The server-side selectors have to be walked in order: apps belong to a
  // team, deployments belong to an app. Promote's ends are deployments of that
  // app too — listed once the app is known, not typed.
  const needsServerWalk =
    wanted.has("team") ||
    wanted.has("app") ||
    wanted.has("deployment") ||
    wanted.has("sourceDeployment") ||
    wanted.has("destDeployment");

  if (needsServerWalk) {
    const serverUrl =
      answers.serverUrl ??
      current.serverUrl ??
      readOptionValue(argv, "--server-url");

    if (serverUrl !== undefined && serverUrl.length > 0) {
      Object.assign(
        answers,
        await askForServerResources(wanted, {
          argv,
          current,
          deps,
          inferSoleEntry,
          prompt,
          serverUrl,
        }),
      );
    } else {
      // No server to list from yet: fall back to the flag names as free text.
      if (wanted.has("sourceDeployment")) {
        answers.sourceDeployment = await promptValue(
          prompt,
          "Source deployment",
        );
      }

      if (wanted.has("destDeployment")) {
        answers.destDeployment = await promptValue(
          prompt,
          "Destination deployment",
        );
      }
    }
  }

  // The walk above fills `label` only when it also resolved a deployment. When
  // it did not, a deployment the user already identified — by flag or by
  // stored configuration — is still enough to offer a list; otherwise the
  // label is asked for plainly. Promote's label names a release in its SOURCE
  // deployment, so the list comes from there.
  if (wanted.has("label") && answers.label === undefined) {
    const serverUrl =
      answers.serverUrl ??
      current.serverUrl ??
      readOptionValue(argv, "--server-url");
    const scope =
      commandKind === "release-promote" ? "promote-source" : "deployment";
    const sourceTeam =
      scope === "promote-source" && serverUrl !== undefined
        ? await askForPromoteSourceTeam({
            argv,
            current: { ...current, ...answers },
            deps,
            prompt,
            serverUrl,
          })
        : undefined;

    if (sourceTeam?.answer !== undefined) {
      answers.team = sourceTeam.answer;
    }

    answers.label = await askForLabel(prompt, {
      argv,
      current: { ...current, ...answers },
      deps,
      scope,
      serverUrl,
      teamId: sourceTeam?.teamId,
    });
  }

  if (wanted.has("platform")) {
    answers.platform = await promptPlatform(
      prompt,
      await detectNativePlatforms(deps, projectRoot),
    );
  }

  if (wanted.has("bundler")) {
    const detected = await detectProjectBundler(deps, projectRoot);
    answers.bundler = await promptBundler(
      prompt,
      detected.kind === "expo" ? "expo" : "metro",
    );
  }

  return answers;
}

async function askForServerResources(
  wanted: Set<PromptableFlag>,
  context: {
    argv: string[];
    current: CommandDefaultFlagValues;
    deps: InteractiveFlagDeps;
    inferSoleEntry: boolean;
    prompt: PromptFn;
    serverUrl: string;
  },
): Promise<CommandDefaultFlagValues> {
  const { argv, current, deps, inferSoleEntry, prompt, serverUrl } = context;
  const token = readOptionValue(argv, "--token");
  const answers: CommandDefaultFlagValues = {};

  // An id the user already supplied IS the scope. Walking past it to a globally
  // chosen team or app would list resources from somewhere else entirely, and
  // the name picked there would then be applied back to the original id — a
  // destructive command would act on the wrong thing under a matching name.
  const explicitAppId = readOptionValue(argv, "--app-id") ?? current.appId;
  const explicitTeamId = readOptionValue(argv, "--team-id") ?? current.teamId;

  let appId = explicitAppId;

  if (appId === undefined) {
    let teamId = explicitTeamId;

    if (teamId === undefined) {
      const team = await pickTeam({
        argv,
        current,
        deps,
        prompt,
        serverUrl,
        token,
        wantedTeam: wanted.has("team"),
      });
      teamId = team.teamId;

      if (team.answer !== undefined) {
        answers.team = team.answer;
      }
    }

    if (
      !wanted.has("app") &&
      !wanted.has("deployment") &&
      !wanted.has("sourceDeployment") &&
      !wanted.has("destDeployment")
    ) {
      return answers;
    }

    const apps = await listNamedResources(
      deps,
      serverUrl,
      teamAppsPath(teamId),
      token,
      "apps",
    );
    const configuredAppName = current.app ?? readOptionValue(argv, "--app");
    const app = await pickResource(prompt, {
      configuredName: configuredAppName,
      inferSoleEntry,
      label: "app",
      message: "Select app",
      resources: apps,
    });
    appId = app.id;

    if (
      shouldRecordPick(wanted.has("app"), configuredAppName, app, apps.length)
    ) {
      answers.app = app.name;
    }
  }

  if (wanted.has("sourceDeployment") || wanted.has("destDeployment")) {
    const deployments = await listNamedResources(
      deps,
      serverUrl,
      `/v1/apps/${encodeURIComponent(appId)}/deployments`,
      token,
      "deployments",
    );

    if (wanted.has("sourceDeployment")) {
      const configuredName =
        current.sourceDeployment ??
        readOptionValue(argv, "--source-deployment");
      const source = await pickResource(prompt, {
        configuredName,
        inferSoleEntry,
        label: "deployment",
        message: "Select source deployment",
        resources: deployments,
      });

      if (
        shouldRecordPick(
          wanted.has("sourceDeployment"),
          configuredName,
          source,
          deployments.length,
        )
      ) {
        answers.sourceDeployment = source.name;
      }
    }

    if (wanted.has("destDeployment")) {
      const configuredName =
        current.destDeployment ?? readOptionValue(argv, "--dest-deployment");
      const destination = await pickResource(prompt, {
        configuredName,
        inferSoleEntry,
        label: "deployment",
        message: "Select destination deployment",
        resources: deployments,
      });

      if (
        shouldRecordPick(
          wanted.has("destDeployment"),
          configuredName,
          destination,
          deployments.length,
        )
      ) {
        answers.destDeployment = destination.name;
      }
    }
  }

  // `label` rides this walk only when the deployment it lists releases from is
  // the one this command will act on. Where a command scopes its deployment
  // with a different flag, the label is asked for separately.
  if (!wanted.has("deployment")) {
    return answers;
  }

  const deployments = await listNamedResources(
    deps,
    serverUrl,
    `/v1/apps/${encodeURIComponent(appId)}/deployments`,
    token,
    "deployments",
  );
  const configuredDeploymentName =
    current.deployment ?? readOptionValue(argv, "--deployment");
  const deployment = await pickResource(prompt, {
    configuredName: configuredDeploymentName,
    inferSoleEntry,
    label: "deployment",
    message: "Select deployment",
    resources: deployments,
  });

  if (
    shouldRecordPick(
      wanted.has("deployment"),
      configuredDeploymentName,
      deployment,
      deployments.length,
    )
  ) {
    answers.deployment = deployment.name;
  }

  if (wanted.has("label")) {
    const labels = await listReleaseLabels(deps, serverUrl, deployment.id, token);

    if (labels.length === 0) {
      throw new UsageError(
        `No releases found in ${deployment.name}. Publish one first.`,
      );
    }

    answers.label = await promptChoice(prompt, "Select release", labels);
  }

  return answers;
}

/**
 * The team a server-side walk scopes to, from the same list and with the same
 * rules wherever it is asked: a configured name that matches wins, a sole team
 * is taken silently even for mutating commands (the team only scopes the walk,
 * it is never itself the mutation target), and several teams are a question.
 * `answer` is set when the pick must be written back — when the parser asked
 * for the team itself, and whenever the pick corrected the configured value —
 * so the replayed flags carry it and execution resolves the same team without
 * asking again.
 */
async function pickTeam(context: {
  argv: string[];
  current: CommandDefaultFlagValues;
  deps: InteractiveFlagDeps;
  prompt: PromptFn;
  serverUrl: string;
  token: string | undefined;
  wantedTeam: boolean;
}): Promise<{ answer?: string; teamId: string }> {
  const { argv, current, deps, prompt, serverUrl, token, wantedTeam } = context;
  const teams = await listNamedResources(
    deps,
    serverUrl,
    "/v1/teams",
    token,
    "teams",
  );

  if (teams.length === 0) {
    throw noTeamsAvailableError(serverUrl);
  }

  const configuredTeamName = current.team ?? readOptionValue(argv, "--team");
  const team = await pickResource(prompt, {
    configuredName: configuredTeamName,
    inferSoleEntry: true,
    label: "team",
    message: "Select team",
    resources: teams,
  });

  return shouldRecordPick(wantedTeam, configuredTeamName, team, teams.length)
    ? { answer: team.name, teamId: team.id }
    : { teamId: team.id };
}

/**
 * Promote's source and destination are both looked up by app name in the team
 * the parser attaches. Left to the resolver, the label picker would ask for
 * that team itself and keep only the label, and execution would ask again and
 * could land in another team. So when the source is named by app and
 * deployment and no id pins the team, it is picked here, once, the way the
 * walk picks it (a stored team wins when it matches), and recorded like any
 * walked pick: the releases listed are the ones execution looks the label up
 * in, and the `Using:` line replays the team. An explicit `--team` is left to
 * the resolver: the explicit token wins on the re-parse, so a pick could not
 * change what runs.
 */
async function askForPromoteSourceTeam(context: {
  argv: string[];
  current: CommandDefaultFlagValues;
  deps: InteractiveFlagDeps;
  prompt: PromptFn;
  serverUrl: string;
}): Promise<{ answer?: string; teamId: string } | undefined> {
  const { argv, current, deps, prompt, serverUrl } = context;
  const scopedElsewhere =
    readOptionValue(argv, "--source-deployment-id") !== undefined ||
    (readOptionValue(argv, "--app-id") ?? current.appId) !== undefined ||
    (readOptionValue(argv, "--team-id") ?? current.teamId) !== undefined ||
    readOptionValue(argv, "--team") !== undefined;
  const nameScoped =
    (readOptionValue(argv, "--app") ?? current.app) !== undefined &&
    (readOptionValue(argv, "--source-deployment") ?? current.sourceDeployment) !==
      undefined;

  if (scopedElsewhere || !nameScoped) {
    return undefined;
  }

  return pickTeam({
    argv,
    current,
    deps,
    prompt,
    serverUrl,
    token: readOptionValue(argv, "--token"),
    wantedTeam: false,
  });
}

/**
 * A release label, from a list where one is reachable and typed where it is
 * not — a typed label is worse than a picked one and far better than a usage
 * error. Promote scopes its source with its own flags, so the walk that
 * produces a deployment never runs there; its list is resolved from those
 * flags instead, and its entries show status and target binary version, since
 * promoting a disabled release or one built for another binary is the mistake
 * the list is there to prevent.
 */
async function askForLabel(
  prompt: PromptFn,
  context: {
    argv: string[];
    current: CommandDefaultFlagValues;
    deps: InteractiveFlagDeps;
    scope: "deployment" | "promote-source";
    serverUrl: string | undefined;
    /** The team `askForPromoteSourceTeam` picked, when it had to pick one. */
    teamId?: string;
  },
): Promise<string> {
  const { argv, current, deps, scope, serverUrl, teamId } = context;

  if (serverUrl === undefined) {
    return promptValue(prompt, "Release label");
  }

  const token = readOptionValue(argv, "--token");
  const deploymentId =
    scope === "promote-source"
      ? await resolvePromoteSourceDeploymentId(argv, current, deps, serverUrl, token, teamId)
      : await resolveLabelDeploymentId(argv, current, deps, serverUrl, token);

  if (deploymentId === undefined) {
    return promptValue(prompt, "Release label");
  }

  if (scope === "promote-source") {
    const releases = await listReleaseChoices(deps, serverUrl, deploymentId, token);

    return releases.length === 0
      ? promptValue(prompt, "Release label")
      : promptSelect(prompt, "Select release to promote", releases);
  }

  const labels = await listReleaseLabels(deps, serverUrl, deploymentId, token);

  return labels.length === 0
    ? promptValue(prompt, "Release label")
    : promptChoice(prompt, "Select release", labels);
}

/**
 * Promote's source deployment, built the way `parseReleasePromote` builds it —
 * an explicit `--source-deployment-id`, or the app plus `--source-deployment`
 * (with the team the parser would attach, or the one just picked for it) —
 * so the releases listed are the ones execution will look the picked label up
 * in.
 */
async function resolvePromoteSourceDeploymentId(
  argv: string[],
  current: CommandDefaultFlagValues,
  deps: InteractiveFlagDeps,
  serverUrl: string,
  token: string | undefined,
  pickedTeamId: string | undefined,
): Promise<string | undefined> {
  const explicitDeploymentId = readOptionValue(argv, "--source-deployment-id");

  if (explicitDeploymentId !== undefined) {
    return explicitDeploymentId;
  }

  const deploymentName =
    readOptionValue(argv, "--source-deployment") ?? current.sourceDeployment;
  const appId = readOptionValue(argv, "--app-id") ?? current.appId;
  const appName = readOptionValue(argv, "--app") ?? current.app;

  if (deploymentName === undefined) {
    return undefined;
  }

  if (appId !== undefined) {
    return resolveDeploymentId({ appId, deploymentName }, serverUrl, token, deps);
  }

  if (appName === undefined) {
    return undefined;
  }

  const teamId =
    readOptionValue(argv, "--team-id") ?? current.teamId ?? pickedTeamId;
  const teamName = readOptionValue(argv, "--team") ?? current.team;
  const selector: DeploymentSelector =
    teamId !== undefined
      ? { appName, deploymentName, teamId }
      : teamName !== undefined
        ? { appName, deploymentName, teamName }
        : { appName, deploymentName };

  return resolveDeploymentId(selector, serverUrl, token, deps);
}

/**
 * The deployment whose releases the label picker lists. The scope the command
 * will act on can arrive as an explicit id, as flag-supplied names, or as
 * stored configuration (`current` carries those defaults) — all of them
 * identify the same deployment execution will resolve, so all of them earn the
 * picked list. Resolution reuses execution's own resolver: same walk, same
 * not-found and ambiguity errors.
 */
async function resolveLabelDeploymentId(
  argv: string[],
  current: CommandDefaultFlagValues,
  deps: InteractiveFlagDeps,
  serverUrl: string,
  token: string | undefined,
): Promise<string | undefined> {
  const explicitDeploymentId = readOptionValue(argv, "--deployment-id");

  if (explicitDeploymentId !== undefined) {
    return explicitDeploymentId;
  }

  const deploymentName =
    readOptionValue(argv, "--deployment") ?? current.deployment;

  if (deploymentName === undefined) {
    return undefined;
  }

  // Deliberately the same shape the parsed command will carry — an app id or
  // an app name, nothing more — so the deployment listed here is the one
  // execution resolves.
  const appId = readOptionValue(argv, "--app-id") ?? current.appId;
  const appName = readOptionValue(argv, "--app") ?? current.app;

  const selector: DeploymentSelector | undefined =
    appId !== undefined
      ? { appId, deploymentName }
      : appName !== undefined
        ? { appName, deploymentName }
        : undefined;

  if (selector === undefined) {
    return undefined;
  }

  return resolveDeploymentId(selector, serverUrl, token, deps);
}

/**
 * Whether a pick must be written back into the answers. Always when the parser
 * asked for the flag itself. Also whenever the walk corrected the caller: a
 * configured name that did not survive the pick — renamed server-side, or
 * overridden by a choice among several — would otherwise ride into the
 * re-parse unchanged, fail resolution after the user already answered, and
 * leave a `Using:` replay line that repeats the same dead invocation. A
 * configured value that matched (by name or by id) is left alone.
 */
function shouldRecordPick(
  wantedFlag: boolean,
  configuredName: string | undefined,
  picked: NamedResource,
  listedCount: number,
): boolean {
  if (wantedFlag) {
    return true;
  }

  if (configuredName === picked.name || configuredName === picked.id) {
    return false;
  }

  return listedCount > 1 || configuredName !== undefined;
}

/**
 * Only asks when there is a real choice to make: a name the user already
 * configured wins, and a single option is not a question — unless the command
 * mutates without confirming, in which case even the one-option question is
 * asked, because the prompt is then the only place the target is ever shown.
 */
async function pickResource(
  prompt: PromptFn,
  input: {
    configuredName: string | undefined;
    inferSoleEntry: boolean;
    label: "app" | "deployment" | "team";
    message: string;
    resources: NamedResource[];
  },
): Promise<NamedResource> {
  const { configuredName, inferSoleEntry, label, message, resources } = input;
  const configured =
    configuredName === undefined
      ? undefined
      : // An id in the name slot is accepted the way execution accepts it:
        // ids are unambiguous, and older stored configs hold ids under names.
        resources.find(
          (resource) =>
            resource.name === configuredName || resource.id === configuredName,
        );

  if (configured !== undefined) {
    return configured;
  }

  const [only] = resources;
  if (inferSoleEntry && resources.length === 1 && only !== undefined) {
    return only;
  }

  return promptResource(prompt, message, resources, label);
}

/**
 * The answers as the flag tokens that would have skipped the questions. A
 * user who is only ever prompted never learns the flag, and their CI job still
 * fails, so the run has to hand the equivalent invocation back.
 */
export function formatResolvedFlags(
  answers: CommandDefaultFlagValues,
): string[] {
  return Object.entries(answers)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .flatMap(([key, value]) =>
      formatFlagAssignment(key as PromptableFlag, value as string),
    );
}
