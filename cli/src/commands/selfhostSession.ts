/**
 * The machinery every `selfhost` subcommand shares.
 *
 * Argument parsing (hand-rolled, because `parseFlags` rejects the positional
 * `user@vps` these commands take), the session — target resolution, pairing,
 * and the one batched host probe — and running a `scripts/selfhost/*.sh`
 * through the shared output renderer.
 *
 * It lives beside the commands rather than inside one of them because
 * `install` and the maintenance commands are peers: install reaches a host
 * that has nothing on it yet, the others reach one that is already set up, and
 * everything before that fork is identical.
 */

import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { PRODUCT_NAME, SOURCE_REPO_URL } from "../branding";
import {
  loadCliConfig,
  loadProjectConfig,
  saveCliConfig,
  type CliConfig,
} from "../configStore";
import { resolveEffectiveContext, resolveProjectRoot } from "../localContext";
import { writeMessage } from "../notice";
import {
  createPalette,
  isInteractiveWritable,
  PLAIN_PALETTE,
  writeLine,
  type Palette,
} from "../output";
import { createProgress, type Progress } from "../progress";
import type { PromptFn } from "../prompt";
import { pairedSshInvocation, runRemoteScript } from "../remoteExec";
import type { RemoteMilestone } from "../remoteOutput";
import { describeBackupCoverage, type BackupCoverage } from "../selfhostCopy";
import {
  renderSshTargetIntro,
  renderSshUserHint,
} from "../selfhostSetupCopy";
import { pairWithHost, type PairingRecovery } from "../selfhostPairing";
import {
  DEFAULT_REMOTE_CHECKOUT,
  probeRemoteHost,
  type RemoteHostFacts,
} from "../selfhostRemote";
import {
  resolveSelfhostTarget,
  selfhostMappingKey,
  withSelfhostMapping,
  type SelfhostTarget,
} from "../selfhostTarget";
import { RemoteScriptFailure, runRenderedScript } from "./scriptRunner";
import { canPromptOnStderr, UsageError, type CommandDeps } from "./shared";

export { RemoteScriptFailure };

/** The documented one-liner, printed wherever a host turns out to have nothing installed. */
export const INSTALL_ONE_LINER = `ssh -t user@vps 'git clone ${SOURCE_REPO_URL} && cd codemagic-patch && scripts/selfhost/install.sh'`;

// ---------------------------------------------------------------------------
// Argument parsing
//
// Hand-rolled rather than routed through `parseFlags`, which rejects
// positional arguments outright — and `restore [backup] [user@vps]` has two.
// ---------------------------------------------------------------------------

export type FlagShape = Readonly<Record<string, "boolean" | "value">>;

export type ParsedArgs = {
  flags: Record<string, string | true>;
  positionals: string[];
};

export function parseArgs(argv: readonly string[], shape: FlagShape): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const kind = shape[name];

    if (kind === undefined) {
      throw new UsageError(`Unknown flag: ${name}`);
    }

    if (kind === "boolean") {
      if (equals !== -1) {
        throw new UsageError(`${name} does not take a value`);
      }

      flags[name] = true;
      continue;
    }

    const value =
      equals === -1 ? argv[(index += 1)] : argument.slice(equals + 1);
    if (value === undefined || value.length === 0) {
      throw new UsageError(`${name} requires a value`);
    }

    flags[name] = value;
  }

  return { flags, positionals };
}

export const COMMON_FLAGS = {
  "--non-interactive": "boolean",
  "--ssh-key": "value",
} as const satisfies FlagShape;

/**
 * An ssh target is recognised by its `@`. `restore` accepts two positionals
 * and this is what tells them apart without a flag the plan never asked for;
 * `upgrade` and `backup` take one, so an alias from `~/.ssh/config` works
 * there too.
 */
export function looksLikeSshTarget(value: string): boolean {
  return value.includes("@");
}

export function readStringFlag(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function readBooleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

// ---------------------------------------------------------------------------
// Session — target resolution, pairing, and the host probe
// ---------------------------------------------------------------------------

export type SelfhostSession = {
  coverage: BackupCoverage;
  facts: RemoteHostFacts;
  identityFile: string;
  progress: Progress;
  /**
   * The checkout the scripts run from. For `install` on a host with no
   * checkout yet this is where the clone is *going* to land, so the caller
   * clones before it runs anything; `facts.checkoutPath` stays null and is the
   * honest record of what was actually found.
   */
  remotePath: string;
  serverUrl: string | null;
  sshTarget: string;
};

export type SelfhostSessionMode = "install" | "maintenance";

export async function openSession(
  deps: CommandDeps,
  input: {
    label: string;
    /**
     * `"install"` skips the two "nothing is installed here" refusals — an
     * empty host is the normal starting point there, not an error — and asks
     * the probe for the host survey in the same round trip.
     */
    mode?: SelfhostSessionMode;
    parsed: ParsedArgs;
    /**
     * A step tree the caller already opened, for a command that has things to
     * say before the ssh questions. Owned here from the moment it is handed
     * over until the session is returned, exactly as one created here is.
     */
    progress?: Progress;
    /**
     * Install mode only: what to do when the target came from this machine's
     * records rather than from the command line. `"ask-new"` asks for a host
     * outright — the caller knows the recorded one is not the one wanted —
     * and `"offer"` puts the recorded host up as a choice next to a new one.
     * Unset keeps the recorded host, as the recovery edges must.
     */
    recordedTarget?: RecordedTargetPolicy;
    /** Where the checkout should be, when the caller pins one. */
    remotePath?: string;
    sshTarget?: string;
  },
): Promise<SelfhostSession> {
  const mode = input.mode ?? "maintenance";
  const config = await loadCliConfig({ env: deps.env });
  // The effective server URL, resolved exactly as every other command resolves
  // it (env → project config → user config): a project that pins a server must
  // steer the destructive commands too, and the shared resolver also treats an
  // empty env var as unset instead of as a URL.
  const projectRoot = resolveProjectRoot([]);
  const projectConfig = await loadProjectConfig(projectRoot);
  const serverUrl = resolveEffectiveContext(
    deps.env,
    config,
    projectConfig,
    projectRoot,
  ).serverUrl?.value;

  let resolution = resolveSelfhostTarget({
    config,
    ...(input.sshTarget !== undefined ? { explicitTarget: input.sshTarget } : {}),
    ...(input.sshTarget === undefined && serverUrl !== undefined
      ? { serverUrl }
      : {}),
  });

  // The wizard's first question, asked rather than demanded. A first install
  // has nothing to resolve a target from — no mapping, no server URL — and
  // `install` is the one mode where that is the normal starting point instead
  // of an error; it is also the only way `cmpatch init` can hand off to the
  // wizard without asking a pairing question of its own. Anything that *can*
  // be resolved still wins, and a run that cannot ask keeps the deterministic
  // usage error below.
  if (resolution.kind === "unpaired" && mode === "install") {
    const asked = await askSshTarget(deps, input.parsed);
    if (asked !== null) {
      resolution = resolveSelfhostTarget({ config, explicitTarget: asked });
    }
  }

  // A recorded host is where the *known* server lives, and an install is the
  // one command whose whole point may be a different host. Resolving it
  // silently sent "install a second server" to the first one, which answered
  // that it was already installed. Only a target the records supplied is
  // questioned: one typed on the command line is the answer already.
  if (
    mode === "install" &&
    resolution.kind === "resolved" &&
    resolution.source !== "argument" &&
    input.recordedTarget !== undefined
  ) {
    const asked = await chooseInstallTarget(
      deps,
      input.parsed,
      resolution.target,
      input.recordedTarget,
    );
    if (asked !== null) {
      resolution = resolveSelfhostTarget({ config, explicitTarget: asked });
    }
  }

  if (resolution.kind === "ambiguous") {
    throw new UsageError(
      [
        `Several self-hosted servers are set up on this machine, so ${input.label} does not know which one you mean:`,
        ...resolution.serverUrls.map((url) => `  ${url}`),
        "",
        "Name one with `cmpatch config set server-url <url>`, or pass the server's address directly: cmpatch selfhost <command> user@vps",
      ].join("\n"),
    );
  }

  if (resolution.kind === "unpaired") {
    throw new UsageError(
      [
        serverUrl === undefined
          ? "No self-hosted server is set up on this machine yet."
          : `No self-hosted server is set up here for ${serverUrl}.`,
        "",
        mode === "install"
          ? "Pass the address of the server to install onto:"
          : "Pass the server's address to connect for the first time:",
        mode === "install"
          ? "  cmpatch selfhost install user@vps"
          : "  cmpatch selfhost <command> user@vps",
      ].join("\n"),
    );
  }

  const progress =
    input.progress ??
    createProgress({
      label: input.label,
      ...(deps.stderr !== undefined ? { stderr: deps.stderr } : {}),
    });

  // Until the session (and with it the progress display) is handed to the
  // caller, this function owns it: progress.ts's contract is that stop/fail is
  // reached on every exit path, and an error escaping here would otherwise
  // leave the spinner animating over the error message with nobody holding a
  // reference to stop it.
  try {
    const askRecovery = createRecoveryPrompt(deps, input.parsed);
    const pairing = await pairWithHost(
      {
        ...(askRecovery !== undefined ? { askRecovery } : {}),
        env: deps.env,
        now: deps.now,
        palette: paletteFor(deps),
        progress,
        runProcess: deps.runProcess,
        sleep: deps.sleep,
        writeNotice: (message) => {
          if (deps.stderr === undefined) {
            return;
          }

          // The guide line spaces its own paragraphs; the blank lines are for
          // a log, where a diagnosis would otherwise run into the step lines.
          if (isInteractiveWritable(deps.stderr)) {
            writeMessage(deps.stderr, message);
            return;
          }

          writeLine(deps.stderr, `\n${message}\n`);
        },
      },
      {
        ...(readStringFlag(input.parsed, "--ssh-key") !== undefined
          ? { bootstrapIdentityFile: readStringFlag(input.parsed, "--ssh-key") }
          : {}),
        sshTarget: resolution.target.sshTarget,
      },
    );

    progress.write("reading the server");
    // Pairing can end on a different address than it started on: its recovery
    // chooser corrects a mistyped `user@host` in place rather than making the
    // user restart the wizard. Everything resolved for the old address — a
    // recorded checkout path, the URL it was stored under — describes a host
    // this run never reached, so it is looked up again for the one that
    // actually connected.
    const pairedTarget =
      pairing.sshTarget === resolution.target.sshTarget
        ? resolution.target
        : knownTargetFor(config, pairing.sshTarget);

    const remotePathHint = input.remotePath ?? pairedTarget.remotePath;
    const facts = await probeRemoteHost({
      identityFile: pairing.identityFile,
      ...(remotePathHint !== undefined ? { remotePath: remotePathHint } : {}),
      runProcess: deps.runProcess,
      ...(mode === "install" ? { scope: "install" as const } : {}),
      sshTarget: pairing.sshTarget,
    });

    if (mode !== "install" && facts.checkoutPath === null) {
      throw new UsageError(
        [
          `${pairing.sshTarget} has no ${PRODUCT_NAME} installation: there is no checkout at ${
            pairedTarget.remotePath ?? `${facts.home}/codemagic-patch`
          }.`,
          "",
          "Install one first:",
          `  ${INSTALL_ONE_LINER}`,
        ].join("\n"),
      );
    }

    if (mode !== "install" && !facts.envFilePresent) {
      throw new UsageError(
        `${pairing.sshTarget} has a checkout at ${facts.checkoutPath} but no .env.selfhost, so nothing is installed there yet. Run the installer on the server first:\n  ${INSTALL_ONE_LINER}`,
      );
    }

    // The server's own SERVER_URL is what keys the mapping, so a command
    // invoked with a bare `user@vps` from a second machine still records its
    // pairing under the right URL instead of leaving the host unrecorded.
    const recordedUrl = facts.serverUrl ?? pairedTarget.serverUrl ?? null;
    // Only a checkout that exists is worth recording; an install still to
    // clone one would otherwise write a path nothing is at yet.
    if (recordedUrl !== null && facts.checkoutPath !== null) {
      // Re-read rather than mutating the snapshot this run resolved its target
      // from, the way every other save site does. Minutes can pass between the
      // two — pairing polls for a console paste — and a second CLI process's
      // write in that window (another install's `pendingInstall` record, most
      // of all) would be silently dropped by writing the old view back. What
      // was resolved from the snapshot is not re-derived: it describes the host
      // this run actually reached.
      const current = await loadCliConfig({ env: deps.env });
      const next = withSelfhostMapping(current, recordedUrl, {
        identityFile: pairing.identityFile,
        remotePath: facts.checkoutPath,
        sshTarget: pairing.sshTarget,
      });
      // Skipped when nothing changed — the common case for every run after the
      // first. The load normalizes the file, so an unconditional write-back
      // would also make every run re-materialize that normalized view.
      const key = selfhostMappingKey(recordedUrl);
      if (
        JSON.stringify(current.selfhost?.[key]) !==
        JSON.stringify(next.selfhost?.[key])
      ) {
        await saveCliConfig(next, { env: deps.env });
      }
    }

    return {
      coverage: describeBackupCoverage(facts),
      facts,
      identityFile: pairing.identityFile,
      progress,
      remotePath:
        facts.checkoutPath ??
        remotePathHint ??
        `${facts.home}/${DEFAULT_REMOTE_CHECKOUT}`,
      serverUrl: recordedUrl,
      sshTarget: pairing.sshTarget,
    };
  } catch (error) {
    progress.fail();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Running a remote script through the shared renderer
// ---------------------------------------------------------------------------

export async function runSelfhostScript(
  deps: CommandDeps,
  session: SelfhostSession,
  input: {
    args: readonly string[];
    env?: Record<string, string>;
    milestones: readonly RemoteMilestone[];
    name: string;
    script: string;
  },
): Promise<void> {
  await runRenderedScript(deps, {
    // The remote command is not touched on Ctrl+C: the ssh child is left to
    // the OS, and whether the script survives the disconnect is not something
    // this side can promise either way — hence "may".
    interruptNotice: (logPath) => [
      `${input.script} may still be running on ${session.sshTarget}.`,
      ...(logPath !== undefined ? [`Full log: ${logPath}`] : []),
      ...(input.name === "install"
        ? [
            "Run the same command again to continue from where this install stopped.",
          ]
        : []),
    ],
    launch: (onOutput) =>
      runRemoteScript({
        command: [
          `${session.remotePath}/scripts/selfhost/${input.script}`,
          ...input.args,
        ],
        connection: pairedSshInvocation(session.sshTarget, session.identityFile),
        cwd: session.remotePath,
        ...(input.env !== undefined ? { env: input.env } : {}),
        onOutput,
        runProcess: deps.runProcess,
      }),
    milestones: input.milestones,
    name: input.name,
    progress: session.progress,
  });
}

export function takeSingleTarget(
  parsed: ParsedArgs,
  subcommand: string,
): string | undefined {
  if (parsed.positionals.length > 1) {
    throw new UsageError(
      `Usage: cmpatch selfhost ${subcommand} [flags] [user@vps]`,
    );
  }

  return parsed.positionals[0];
}

/**
 * Prompts render on stderr, so a run whose stderr is redirected must not stop
 * on a question nobody can see — the same gate every other guided command uses.
 */
export function canAsk(deps: CommandDeps, parsed: ParsedArgs): boolean {
  return (
    canPromptOnStderr(deps, readBooleanFlag(parsed, "--non-interactive")) &&
    deps.confirm !== undefined
  );
}

/**
 * What the config already knows about an ssh address, or nothing but the
 * address itself. Total where `resolveSelfhostTarget` is a union: an explicit
 * address always resolves, and a host nothing has been recorded for is a
 * perfectly good answer rather than a case to handle.
 */
function knownTargetFor(config: CliConfig, sshTarget: string): SelfhostTarget {
  const resolved = resolveSelfhostTarget({ config, explicitTarget: sshTarget });
  return resolved.kind === "resolved" ? resolved.target : { sshTarget };
}

export type RecordedTargetPolicy = "ask-new" | "offer";

/**
 * The host to install onto when this machine already records one. Returns the
 * address to use instead, or null to keep the recorded host — which is also
 * the answer when nothing can be asked, so a scripted run keeps resolving as
 * it always did.
 */
async function chooseInstallTarget(
  deps: CommandDeps,
  parsed: ParsedArgs,
  recorded: SelfhostTarget,
  policy: RecordedTargetPolicy,
): Promise<string | null> {
  const prompt = deps.prompt;
  if (prompt === undefined || !canAsk(deps, parsed)) {
    return null;
  }

  // init's menu offered the known server on the row above "install", so a
  // user who reached here has already declined it; asking which host again
  // would be asking a question they just answered.
  if (policy === "ask-new") {
    return askSshTarget(deps, parsed);
  }

  const known =
    recorded.serverUrl === undefined
      ? recorded.sshTarget
      : `${recorded.sshTarget} (the server at ${recorded.serverUrl})`;
  const answer = await prompt({
    choices: [
      { title: `Continue on ${known}`, value: "known" },
      { title: "Install onto a different host", value: "new" },
    ],
    message: "Which host should this install target?",
    type: "select",
  });
  const value = Array.isArray(answer) ? answer[0] : answer;
  return value === "new" ? askSshTarget(deps, parsed) : null;
}

/**
 * The address of the host to install onto, when nothing on this machine knows
 * one yet. Asked as two questions — the address, then the account — because
 * the audience this wizard exists for finds them unequally hard: the address
 * is on the provider's console page, the account is not written anywhere and
 * has to be known. Each half is re-asked rather than rejected, and named per
 * problem: catching a mistake here costs one question, while the same mistake
 * found later costs a round of failed connections before the pairing chooser
 * can offer to correct it.
 *
 * A whole `user@host` typed into the address question is accepted as the
 * answer to both, so someone who already knows the form is not made to split
 * it.
 */
async function askSshTarget(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<string | null> {
  const prompt = deps.prompt;
  if (prompt === undefined || !canAsk(deps, parsed)) {
    return null;
  }

  writeNotice(deps, renderSshTargetIntro());

  let host: string;
  for (;;) {
    const answer = String(
      await prompt({
        message: "Server address (public IP or hostname)",
        type: "text",
      }),
    ).trim();

    if (answer.includes("@")) {
      const problem = sshTargetProblem(answer);
      if (problem === null) {
        return answer;
      }
      writeNotice(deps, problem);
      continue;
    }

    const problem = sshHostProblem(answer);
    if (problem === null) {
      host = answer;
      break;
    }
    writeNotice(deps, problem);
  }

  writeNotice(deps, renderSshUserHint());

  for (;;) {
    const answer = String(
      await prompt({ message: "SSH user", type: "text" }),
    ).trim();

    const problem = sshUserProblem(answer);
    if (problem === null) {
      return `${answer}@${host}`;
    }

    writeNotice(deps, problem);
  }
}

/**
 * What is wrong with a typed server address, or null when nothing is. The one
 * mistake worth catching is the whole `ssh …` command line pasted out of a
 * provider's console; a bare hostname is exactly what this question wants, and
 * a `~/.ssh/config` alias is a legitimate answer no grammar can tell from a
 * typo.
 */
function sshHostProblem(value: string): string | null {
  if (/\s/u.test(value)) {
    return "That looks like a whole command rather than an address. Paste just the server's IP address or hostname (for example 203.0.113.7), and use --ssh-key for a key file.";
  }

  return null;
}

/** What is wrong with a typed login account, or null when nothing is. */
function sshUserProblem(value: string): string | null {
  if (/[\s@]/u.test(value)) {
    return "Just the account name, without the server address — for example root or ubuntu.";
  }

  return null;
}

/**
 * What is wrong with a typed ssh target, or null when nothing is.
 *
 * Deliberately stricter than `looksLikeSshTarget`, which classifies
 * positionals for the maintenance commands and must keep accepting whatever
 * the user's own SSH setup accepts. This is a text prompt with one job, so the
 * two mistakes it can catch cheaply are worth catching: a half-typed address,
 * and the whole `ssh …` command line pasted out of a provider's console —
 * plausible for exactly the audience this wizard exists for. What it does not
 * do is validate the host itself: a `~/.ssh/config` alias is a legitimate
 * answer, and no grammar here can tell one from a typo.
 */
function sshTargetProblem(value: string): string | null {
  const example = "for example root@203.0.113.7 or ubuntu@my-server.example.com";

  if (/\s/u.test(value)) {
    return `That looks like a whole command rather than an address. Paste just the part after \`ssh\` (${example}), and use --ssh-key for a key file.`;
  }

  const separator = value.lastIndexOf("@");
  if (separator < 0) {
    return `${value} is missing the user it should connect as — ${example}.`;
  }

  if (separator === 0) {
    return `${value} is missing the user before the @ — ${example}.`;
  }

  if (separator === value.length - 1) {
    return `${value} is missing the server address after the @ — ${example}.`;
  }

  return null;
}

/**
 * The recovery chooser, offered once neither automatic attempt connects.
 *
 * The four entries are the four ways this step actually fails, and they are
 * offered together because the wizard cannot tell them apart: a key file never
 * wired into `~/.ssh`, a password the server was waiting for (or one mistyped),
 * no local credential at all, and an address that was simply typed wrong. Every
 * entry can be left again — a wrong key file, a refused password, an
 * uneventful console wait, even changing one's mind inside a question — because
 * the one outcome this chooser exists to prevent is a user who has to restart
 * the wizard to try the next idea.
 *
 * A password is never collected here. The probe behind "retry with a password"
 * is a real interactive ssh, so sshd asks for it itself wherever the server
 * allows one, and the secret never enters this process.
 */
function createRecoveryPrompt(
  deps: CommandDeps,
  parsed: ParsedArgs,
): ((context: { sshTarget: string }) => Promise<PairingRecovery>) | undefined {
  const prompt = deps.prompt;
  if (
    prompt === undefined ||
    !canPromptOnStderr(deps, readBooleanFlag(parsed, "--non-interactive"))
  ) {
    return undefined;
  }

  return async ({ sshTarget }) => {
    for (;;) {
      const choice = await prompt({
        choices: [
          {
            title: "Use a private key file (a .pem downloaded from AWS, for example)",
            value: "key-file",
          },
          { title: "Retry with an SSH password", value: "password-retry" },
          { title: "Use my provider's browser console", value: "console" },
          {
            title: "Change the SSH user or server address",
            value: "change-target",
          },
        ],
        message: "How would you like to connect?",
        type: "select",
      });

      if (choice === "password-retry") {
        return { kind: "password-retry" };
      }

      if (choice === "console") {
        return { kind: "console" };
      }

      if (choice === "key-file") {
        const path = await askKeyFilePath(deps, prompt);
        if (path !== null) {
          return { kind: "key-file", path };
        }

        continue;
      }

      const corrected = await askCorrectedTarget(deps, prompt, sshTarget);
      if (corrected !== null) {
        return { kind: "change-target", sshTarget: corrected };
      }
    }
  };
}

/**
 * A key file's path, or null to go back to the chooser — which an empty answer
 * means, because a user who picks this and then remembers the `.pem` is on
 * another machine must not be trapped in a question whose only other exit is
 * Ctrl+C.
 */
async function askKeyFilePath(
  deps: CommandDeps,
  prompt: PromptFn,
): Promise<string | null> {
  for (;;) {
    const answer = await prompt({
      message: "Path to the key file, or empty to go back",
      optional: true,
      type: "text",
    });

    const path = expandLeadingTilde(
      (typeof answer === "string" ? answer : (answer[0] ?? "")).trim(),
    );

    if (path.length === 0) {
      return null;
    }

    // Checked here rather than left to ssh: a typo'd path would otherwise
    // surface as "couldn't connect", steering the user away from a key that
    // would have worked.
    try {
      await stat(path);
      return path;
    } catch {
      writeNotice(deps, `There is no file at ${path}.`);
    }
  }
}

/**
 * A corrected address, or null to go back to the chooser.
 *
 * Prefilled with the address that failed, because the fix is usually one
 * character of it, and validated by the same rules the wizard's own target
 * question uses — a second typo here would cost another full round of failed
 * connections before the user could say so. An unchanged answer is a way back
 * rather than a restart: re-running the same two attempts against the same
 * address can only reach this same chooser again.
 */
async function askCorrectedTarget(
  deps: CommandDeps,
  prompt: PromptFn,
  current: string,
): Promise<string | null> {
  for (;;) {
    const answer = String(
      await prompt({
        initial: current,
        message: "VPS SSH target (user@host), or empty to go back",
        optional: true,
        type: "text",
      }),
    ).trim();

    if (answer.length === 0) {
      return null;
    }

    // Submitted unchanged — said out loud rather than silently reopening the
    // chooser, which would read as the question having been ignored.
    if (answer === current) {
      writeNotice(
        deps,
        `${answer} is the address that just failed; nothing was changed.`,
      );
      return null;
    }

    const problem = sshTargetProblem(answer);
    if (problem === null) {
      return answer;
    }

    writeNotice(deps, problem);
  }
}

function expandLeadingTilde(path: string): string {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(1))
    : path;
}

/**
 * The colours the copy may use on the values the user copies: on where the
 * box and the guide line are drawn, plain everywhere else — pipes, CI,
 * NO_COLOR, and the injected writers that only claim to be a terminal.
 */
export function paletteFor(deps: CommandDeps): Palette {
  return deps.stderr !== undefined && isInteractiveWritable(deps.stderr)
    ? createPalette(deps.stderr, deps.env)
    : PLAIN_PALETTE;
}

/**
 * One paragraph to the user, on the prompt tree's guide line in a terminal
 * and as plain lines everywhere else. A block of lines is one paragraph: pass
 * the array, not a line at a time.
 */
export function writeNotice(
  deps: CommandDeps,
  message: string | readonly string[],
): void {
  if (deps.stderr !== undefined) {
    writeMessage(deps.stderr, message);
  }
}

