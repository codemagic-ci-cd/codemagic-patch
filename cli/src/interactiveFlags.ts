// Asking for a required flag instead of failing on it.
//
// A command reaches this module only after the normal resolution order has
// already run: explicit flag, then environment, then stored configuration. So a
// flag that is still missing here is one the user has never supplied anywhere,
// and the CLI already knows how to source it — the `defaults` policy on the
// command says so. That policy is the boundary: this module will never ask for
// a flag the command did not declare as config-resolvable.

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
  listReleaseLabels,
  promptBundler,
  promptChoice,
  promptName,
  promptPlatform,
  promptResource,
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

  if (wanted.has("requireCodeSigning")) {
    answers.requireCodeSigning = await promptChoice(
      prompt,
      "Require code signing?",
      ["true", "false"],
    );
  }

  if (wanted.has("sourceDeployment")) {
    answers.sourceDeployment = await promptValue(prompt, "Source deployment");
  }

  if (wanted.has("destDeployment")) {
    answers.destDeployment = await promptValue(prompt, "Destination deployment");
  }

  if (wanted.has("serverUrl")) {
    answers.serverUrl = await promptServerUrl(prompt, current.serverUrl);
  }

  // The server-side selectors have to be walked in order: apps belong to a
  // team, deployments belong to an app.
  if (wanted.has("team") || wanted.has("app") || wanted.has("deployment")) {
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
    }
  }

  // The walk above fills `label` only when it also resolved a deployment. When
  // it did not, a deployment the user already identified — by flag or by
  // stored configuration — is still enough to offer a list; otherwise the
  // label is asked for plainly.
  if (wanted.has("label") && answers.label === undefined) {
    answers.label = await askForLabel(prompt, {
      argv,
      current,
      deps,
      serverUrl:
        answers.serverUrl ??
        current.serverUrl ??
        readOptionValue(argv, "--server-url"),
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

      // A sole team is taken silently even for mutating commands: the team
      // only scopes the walk, it is never itself the mutation target.
      const configuredTeamName = current.team ?? readOptionValue(argv, "--team");
      const team = await pickResource(prompt, {
        configuredName: configuredTeamName,
        inferSoleEntry: true,
        label: "team",
        message: "Select team",
        resources: teams,
      });
      teamId = team.id;

      // Recorded when the parser asked for the team itself — and whenever the
      // pick corrected the configured value, so the replayed flags carry the
      // pick and execution resolves the same team without asking again.
      if (
        shouldRecordPick(wanted.has("team"), configuredTeamName, team, teams.length)
      ) {
        answers.team = team.name;
      }
    }

    if (!wanted.has("app") && !wanted.has("deployment")) {
      return answers;
    }

    const apps = await listNamedResources(
      deps,
      serverUrl,
      `/v1/teams/${encodeURIComponent(teamId)}/apps`,
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
 * A release label, from a list where one is reachable and typed where it is
 * not. Promote scopes its source with its own flag, so the walk that produces a
 * deployment never runs there — a typed label is worse than a picked one and
 * far better than a usage error.
 */
async function askForLabel(
  prompt: PromptFn,
  context: {
    argv: string[];
    current: CommandDefaultFlagValues;
    deps: InteractiveFlagDeps;
    serverUrl: string | undefined;
  },
): Promise<string> {
  const { argv, current, deps, serverUrl } = context;

  if (serverUrl === undefined) {
    return promptValue(prompt, "Release label");
  }

  const token = readOptionValue(argv, "--token");
  const deploymentId = await resolveLabelDeploymentId(
    argv,
    current,
    deps,
    serverUrl,
    token,
  );

  if (deploymentId === undefined) {
    return promptValue(prompt, "Release label");
  }

  const labels = await listReleaseLabels(deps, serverUrl, deploymentId, token);

  return labels.length === 0
    ? promptValue(prompt, "Release label")
    : promptChoice(prompt, "Select release", labels);
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
