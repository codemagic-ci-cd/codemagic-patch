/**
 * The process boundary every Fly command shares: finding and running flyctl,
 * the Tigris CLI and git, the organization lookup and the waits. Each run
 * opens one `FlyContext`; nothing here is module state.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { SOURCE_REPO_URL } from "../branding";
import {
  chooseServerTag,
  FLY_INSTALL_SCRIPT,
  FLYCTL_MIN_VERSION,
  isBelowMinimum,
  parseToolVersion,
  TIGRIS_INSTALL_SCRIPT,
  TIGRIS_MIN_VERSION,
} from "../flySetup";
import { createProgress, NO_OP_PROGRESS, type Progress } from "../progress";
import type { ProcessRunResult } from "../remoteExec";
import { askSelect, notice } from "./selfhostInstall/ask";
import { UsageError, type CommandDeps } from "./shared";

export type FlyTool = "fly" | "tigris";

export type FlyContext = {
  /** The binaries `ensureTool` resolved; the bare names until then. */
  readonly commands: Record<FlyTool, string>;
  readonly deps: CommandDeps;
  /** Replaced when the caller opens its step tree; a no-op before that. */
  progress: Progress;
  /** The command a version failure tells the operator to run again, such as `cmpatch selfhost install --fly`. */
  readonly rerun: string;
};

export function createFlyContext(
  deps: CommandDeps,
  rerun: string,
  progress: Progress = NO_OP_PROGRESS,
): FlyContext {
  return { commands: { fly: "fly", tigris: "tigris" }, deps, progress, rerun };
}

/** The run's step tree on stderr, labelled with the command. */
export function flyProgress(deps: CommandDeps, label: string): Progress {
  return createProgress({
    label,
    ...(deps.stderr !== undefined ? { stderr: deps.stderr } : {}),
  });
}

/** What a command says when flyctl is not signed in. */
export function flyLoginFirst(rerun: string): string {
  return `Run fly auth login, then run ${rerun} again.`;
}

type RunOptions = {
  cwd?: string;
  /** Feed the latest output line to the step in flight. Not for commands that print a secret. */
  show?: boolean;
  stdin?: string;
  /** Kill the process and fail with a usage error when it has not finished by then. */
  timeoutMs?: number;
};

const FLY_MANUAL = `curl -fsSL ${FLY_INSTALL_SCRIPT} | sh`;
const TIGRIS_MANUAL = `curl -fsSL ${TIGRIS_INSTALL_SCRIPT} | sh`;

export function toolCommand(fly: FlyContext, command: string): string {
  if (command === "fly" || command === "tigris") {
    return fly.commands[command];
  }
  return command;
}

export function flyServerUrl(stem: string): string {
  return `https://${stem}.fly.dev`;
}

type ResolvedTool = { command: string; versionOutput: string };

/**
 * Whether a missing tool may be installed. `installAllowed` is the tool's
 * --install-* flag: it skips the question in an interactive run, and a run
 * that cannot ask installs only with it.
 */
export type ToolInstallConsent = { installAllowed: boolean; interactive: boolean };

/** Find the tool, installing it when it is missing and the run consents, and check its version. */
export async function ensureTool(
  fly: FlyContext,
  consent: ToolInstallConsent,
  tool: FlyTool,
): Promise<ResolvedTool> {
  const present = await resolveTool(fly.deps, tool);
  if (present !== null) {
    requireMinimumVersion(fly, tool, present);
    fly.commands[tool] = present.command;
    return present;
  }

  await installTool(fly.deps, consent, tool);

  const resolved = await resolveTool(fly.deps, tool);
  if (resolved === null) {
    const name = tool === "fly" ? "flyctl" : "The Tigris CLI";
    throw new UsageError(
      `${name} is still not available after the installer finished. Install it with ${manualInstall(tool)}`,
    );
  }
  requireMinimumVersion(fly, tool, resolved);
  fly.commands[tool] = resolved.command;
  return resolved;
}

/** Find the tool and check its version, without offering to install it. */
export async function requireTool(fly: FlyContext, tool: FlyTool): Promise<ResolvedTool> {
  const present = await resolveTool(fly.deps, tool);
  if (present === null) {
    throw new UsageError(missingBinary(tool));
  }
  requireMinimumVersion(fly, tool, present);
  fly.commands[tool] = present.command;
  return present;
}

/** A version string this cannot parse proceeds: a change in the version output's format must not block every install. */
function requireMinimumVersion(fly: FlyContext, tool: FlyTool, resolved: ResolvedTool): void {
  const installed = parseToolVersion(tool, resolved.versionOutput);
  const minimum = tool === "fly" ? FLYCTL_MIN_VERSION : TIGRIS_MIN_VERSION;
  if (installed === null || !isBelowMinimum(installed, minimum)) {
    return;
  }

  const name = tool === "fly" ? "flyctl" : "The Tigris CLI";
  const upgrade = tool === "fly" ? `${resolved.command} version upgrade` : TIGRIS_MANUAL;
  throw new UsageError(
    `${name} ${installed.join(".")} is older than ${minimum}, the oldest this command supports. Upgrade it with ${upgrade}, then run ${fly.rerun} again.`,
  );
}

function manualInstall(tool: FlyTool): string {
  return tool === "fly" ? FLY_MANUAL : TIGRIS_MANUAL;
}

async function installTool(deps: CommandDeps, consent: ToolInstallConsent, tool: FlyTool): Promise<void> {
  const manual = manualInstall(tool);
  if (!consent.interactive && !consent.installAllowed) {
    // The installer runs a script from the network, so a run that cannot
    // ask must opt in, as the ssh installer's --install-* flags do.
    const name = tool === "fly" ? "flyctl" : "The Tigris CLI";
    const flag = tool === "fly" ? "--install-flyctl" : "--install-tigris";
    throw new UsageError(
      `${name} is not installed. Pass ${flag} to let this command install it, or install it with ${manual}`,
    );
  }

  notice(deps, tool === "fly"
    ? "flyctl is not installed. This command uses it to create the Fly app."
    : "The Tigris CLI is not installed. This command uses it to create the buckets.");
  if (!consent.installAllowed) {
    const agreed = (await deps.confirm?.({
      initial: true,
      message: tool === "fly" ? "Install flyctl now?" : "Install the Tigris CLI now?",
    })) ?? false;
    if (!agreed) {
      throw new UsageError(`Install it with ${manual}`);
    }
  }

  notice(deps, tool === "fly" ? "Installing flyctl." : "Installing the Tigris CLI.");
  await runInstaller(deps, tool, manual);
}

async function runInstaller(deps: CommandDeps, tool: FlyTool, manual: string): Promise<void> {
  const result = await spawn(deps, "sh", ["-c", manual], {
    // The Tigris script's default directory is /usr/local/bin, and it uses
    // sudo when that directory is not writable. A directory under the home
    // folder lets this process install the binary and run it without a
    // password prompt.
    ...(tool === "tigris" ? { env: { TIGRIS_INSTALL_DIR: tigrisInstallDir(deps) } } : {}),
  });
  if (result === null || result.exitCode !== 0) {
    throw new UsageError(installerFailed(tool, result?.output ?? "", manual));
  }
}

function installerFailed(tool: FlyTool, output: string, manual: string): string {
  const tail = lastLines(output, 20);
  const lead = tool === "fly"
    ? "flyctl could not be installed."
    : "The Tigris CLI could not be installed.";
  return [lead, tail, `Install it with ${manual}`].filter((line) => line.length > 0).join("\n");
}

function flyInstallRoot(deps: CommandDeps): string {
  const configured = deps.env.FLYCTL_INSTALL?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".fly");
}

function tigrisInstallDir(deps: CommandDeps): string {
  const configured = deps.env.TIGRIS_INSTALL_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".tigris", "bin");
}

async function resolveTool(deps: CommandDeps, tool: FlyTool): Promise<ResolvedTool | null> {
  // Fly's script installs to ~/.fly/bin and does not update this process's PATH.
  const root = flyInstallRoot(deps);
  const candidates = tool === "fly"
    ? ["fly", "flyctl", join(root, "bin", "fly"), join(root, "bin", "flyctl")]
    : ["tigris", join(tigrisInstallDir(deps), "tigris"), "/usr/local/bin/tigris"];

  for (const candidate of candidates) {
    const versionOutput = await versionOf(deps, candidate);
    if (versionOutput !== null) {
      return { command: candidate, versionOutput };
    }
  }

  return null;
}

/** `<command> version` output, or null when the binary is missing. A non-zero exit still counts as present. */
async function versionOf(deps: CommandDeps, command: string): Promise<string | null> {
  return (await spawn(deps, command, ["version"]))?.output ?? null;
}

export async function signedIn(fly: FlyContext): Promise<boolean> {
  return (await capture(fly, "fly", ["auth", "whoami"])).exitCode === 0;
}

export async function runInteractive(
  fly: FlyContext,
  command: string,
  args: readonly string[],
): Promise<void> {
  const result = await spawn(fly.deps, toolCommand(fly, command), args, { interactive: true });
  if (result === null) {
    throw new UsageError(missingBinary(command));
  }
  if (result.exitCode !== 0) {
    throw new UsageError(`${command} ${args.join(" ")} did not finish.`);
  }
}

type ProcessOutcome = { exitCode: ProcessRunResult["exitCode"]; output: string };

/**
 * One process and its merged output, or null when the binary is missing
 * (ENOENT). `show` gets each line but the secret-looking ones; an
 * `interactive` child has the terminal, so nothing is captured.
 */
async function spawn(
  deps: CommandDeps,
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    interactive?: boolean;
    show?: Progress;
    stdin?: string;
    timeoutMs?: number;
  } = {},
): Promise<ProcessOutcome | null> {
  const { show, ...runner } = options;
  let output = "";
  let pending = "";
  try {
    const result = await deps.runProcess({
      args,
      command,
      ...runner,
      ...(runner.interactive === true
        ? {}
        : {
            onOutput: (chunk: string) => {
              output += chunk;
              if (show !== undefined) {
                pending = showBuildLine(show, pending, chunk);
              }
            },
          }),
    });
    if (show !== undefined && pending.trim().length > 0) {
      showBuildLine(show, "", `${pending}\n`);
    }
    return { exitCode: result.exitCode, output };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

/** A tool's exit code and output, whatever the exit code; a missing binary is a usage error. */
export async function capture(fly: FlyContext, command: string, args: readonly string[]): Promise<ProcessOutcome> {
  const result = await spawn(fly.deps, toolCommand(fly, command), args);
  if (result === null) {
    throw new UsageError(missingBinary(command));
  }
  return result;
}

const SECRET_LINE = /AWS_SECRET_ACCESS_KEY|TIGRIS_STORAGE_SECRET|tsec_|FlyV1 |fm2_/u;

/** `text` without the lines that look like they carry a secret. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .filter((line) => !SECRET_LINE.test(line))
    .join("\n");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first line of `text`, trimmed. */
export function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/** The last `count` lines of trimmed output. */
export function lastLines(output: string, count: number): string {
  return output.trim().split("\n").slice(-count).join("\n");
}

function showBuildLine(progress: Progress, pending: string, chunk: string): string {
  const parts = `${pending}${chunk}`.split(/\r|\n/u);
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.trim();
    if (line.length > 0 && !SECRET_LINE.test(line)) {
      progress.detail(line);
    }
  }
  return rest;
}

export async function run(
  fly: FlyContext,
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> {
  let result: ProcessOutcome | null;
  try {
    result = await spawn(fly.deps, toolCommand(fly, command), args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.show === true ? { show: fly.progress } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  } catch (error) {
    // The runner rejects a process it killed for running past `timeoutMs`.
    if (options.timeoutMs !== undefined && error instanceof Error && /timed out/u.test(error.message)) {
      throw new UsageError(`${command} ${args.join(" ")} did not finish within ${Math.round(options.timeoutMs / 1000)} seconds.`);
    }
    throw error;
  }
  if (result === null) {
    throw new UsageError(missingBinary(command));
  }
  if (result.exitCode !== 0) {
    throw new UsageError([`${command} ${args.join(" ")} failed.`, lastLines(result.output, 20)].filter((line) => line.length > 0).join("\n"));
  }

  return result.output;
}

/** `git ls-remote --tags` of the public repo, which lists the server releases. */
export function listRemoteTags(fly: FlyContext): Promise<string> {
  return run(fly, "git", ["ls-remote", "--tags", SOURCE_REPO_URL]);
}

/** The newest server release tag in `git ls-remote --tags` output. */
export function latestServerTag(lsRemote: string): string {
  const tag = chooseServerTag(lsRemote);
  if (tag === null) {
    throw new UsageError("Could not find a codemagic-patch-server release tag.");
  }
  return tag;
}

/** A shallow clone of `tag` at `<parent>/codemagic-patch`, which it returns. */
export async function cloneServerTag(fly: FlyContext, tag: string, parent: string): Promise<string> {
  const checkout = join(parent, "codemagic-patch");
  fly.progress.write(`Cloning ${tag}`);
  await run(fly, "git", ["clone", "--depth", "1", "--branch", tag, SOURCE_REPO_URL, checkout]);
  return checkout;
}

export function missingBinary(command: string): string {
  if (command === "fly" || command === "flyctl" || command.endsWith("/fly") || command.endsWith("/flyctl")) {
    return `flyctl is not installed. Install it with ${FLY_MANUAL}`;
  }
  if (command === "tigris" || command.endsWith("/tigris")) {
    return `The Tigris CLI is not installed. Install it with ${TIGRIS_MANUAL}`;
  }

  return `${command} is not installed.`;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

/**
 * `--fly-org`, else the only organization this login can see. Several are
 * asked about when the run can ask; a run that cannot names `--fly-org`.
 */
export async function resolveFlyOrgSlug(
  fly: FlyContext,
  interactive: boolean,
  org: string | undefined,
): Promise<string> {
  if (org !== undefined) {
    return org;
  }

  const orgs = await listFlyOrgs(fly);
  if (orgs === null) {
    throw new UsageError("Could not read this login's Fly organizations. Pass --fly-org <slug>; fly orgs list shows them.");
  }
  const [only] = orgs;
  if (only === undefined) {
    throw new UsageError(`This Fly login has no organization. Create one with fly orgs create, then run ${fly.rerun} again.`);
  }
  if (orgs.length === 1) {
    return only.slug;
  }

  const slugs = orgs.map((candidate) => candidate.slug);
  if (!interactive) {
    throw new UsageError(`This login can see more than one Fly organization: ${slugs.join(", ")}. Pass --fly-org <slug> to choose one.`);
  }

  notice(fly.deps, "This login can see more than one Fly organization. The app and the buckets are created and billed in the one you choose.");
  const chosen = await askSelect(fly.deps, {
    choices: orgs.map((candidate) => ({
      title: candidate.cardSaved ? candidate.slug : `${candidate.slug} (no card yet)`,
      value: candidate.slug,
    })),
    fallback: "",
    message: "Which Fly organization should this run in?",
  });
  if (!slugs.includes(chosen)) {
    throw new UsageError(`Choose a Fly organization, or pass --fly-org with one of ${slugs.join(", ")}.`);
  }
  return chosen;
}

export type Billing = "TRIAL_ACTIVE" | "TRIAL_ENDED" | null;

export type FlyOrg = {
  cardSaved: boolean;
  slug: string;
  status: Billing;
};

const BILLING_QUERY = `query($admin: Boolean!) {
  organizations(admin: $admin) {
    nodes { slug billingStatus isCreditCardSaved }
  }
}`;

/** `org` as this login sees it, or null when it is not among them or the lookup failed. */
export async function readFlyOrg(fly: FlyContext, org: string): Promise<FlyOrg | null> {
  return (await listFlyOrgs(fly))?.find((candidate) => candidate.slug === org) ?? null;
}

/**
 * The organizations this login can see, or null when the token, the request
 * or the response's shape fails.
 */
export async function listFlyOrgs(fly: FlyContext): Promise<FlyOrg[] | null> {
  const { deps } = fly;
  let token: string;
  try {
    const result = await spawn(deps, toolCommand(fly, "fly"), ["auth", "token"]);
    if (result === null || result.exitCode !== 0) {
      return null;
    }
    token = readFlyToken(result.output);
  } catch {
    return null;
  }

  if (token.length === 0) {
    return null;
  }

  try {
    const response = await deps.fetch("https://api.fly.io/graphql", {
      body: JSON.stringify({ query: BILLING_QUERY, variables: { admin: false } }),
      headers: {
        authorization: token,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      return null;
    }

    const body = await response.json() as {
      data?: {
        organizations?: {
          nodes?: Array<{ billingStatus?: string; isCreditCardSaved?: boolean; slug?: string }>;
        };
      };
    };
    const nodes = body.data?.organizations?.nodes;
    if (!Array.isArray(nodes)) {
      return null;
    }

    const orgs: FlyOrg[] = [];
    for (const node of nodes) {
      if (typeof node.slug !== "string" || typeof node.isCreditCardSaved !== "boolean") {
        return null;
      }
      const status = node.billingStatus === "TRIAL_ACTIVE" || node.billingStatus === "TRIAL_ENDED"
        ? node.billingStatus
        : null;
      orgs.push({ cardSaved: node.isCreditCardSaved, slug: node.slug, status });
    }
    return orgs;
  } catch {
    return null;
  }
}

/** `fly auth token` writes a deprecation warning to stderr, and this runner merges both streams. */
function readFlyToken(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("FlyV1 ") || trimmed.startsWith("fm2_")) {
      return trimmed;
    }
  }
  return "";
}

/**
 * A command that was told to stop (Ctrl-C) by its own cancellation guard.
 * Waits that swallow request errors rethrow it.
 */
export class FlyInterrupted extends Error {
  constructor() {
    super("Interrupted.");
    this.name = "FlyInterrupted";
  }
}

const READY_REQUEST_TIMEOUT_MS = 15_000;
const READY_WAIT_MS = 5 * 60_000;

/**
 * Calls `attempt` every `intervalMs` until it returns a value, for at most
 * `waitMs` from `from` (default: now); undefined when the wait ran out. The
 * attempt cap only guards against a clock that does not move.
 */
export async function pollUntil<T>(
  deps: Pick<CommandDeps, "now" | "sleep">,
  wait: { from?: number; intervalMs: number; sleepAfterLast?: boolean; waitMs: number },
  attempt: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = (wait.from ?? deps.now()) + wait.waitMs;
  const attempts = wait.waitMs / wait.intervalMs;
  for (let index = 0; index < attempts && deps.now() < deadline; index += 1) {
    const value = await attempt();
    if (value !== undefined) {
      return value;
    }
    if (wait.sleepAfterLast !== false || index < attempts - 1) {
      await deps.sleep(wait.intervalMs);
    }
  }
  return undefined;
}

/** Polls `/health/ready` every 5 seconds for 5 minutes, each request bounded to 15 seconds. */
export async function waitUntilReady(fly: FlyContext, stem: string): Promise<void> {
  const url = `${flyServerUrl(stem)}/health/ready`;
  fly.progress.write(`Waiting for ${url}`);

  const ready = await pollUntil(fly.deps, { intervalMs: 5_000, sleepAfterLast: false, waitMs: READY_WAIT_MS }, async () => {
    try {
      const response = await fly.deps.fetch(url, { signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) });
      return response.ok ? true : undefined;
    } catch (error) {
      if (error instanceof FlyInterrupted) {
        throw error;
      }
      // The app is still deploying, the machine has not started, or the request timed out.
      return undefined;
    }
  });
  if (ready === undefined) {
    throw new UsageError(`The app did not answer ${url}. fly logs --app ${stem} shows why.`);
  }
}
