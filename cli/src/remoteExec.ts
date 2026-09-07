/**
 * The ssh layer for the `selfhost` command family.
 *
 * Everything here exists to drive `scripts/selfhost/*.sh` on a remote host
 * without reimplementing any of them locally: assemble an ssh invocation,
 * generate a small shell program that exports the answers and execs the
 * script, and pipe that program to `ssh <target> bash -s`.
 *
 * Two rules shape the whole file.
 *
 * 1. **Secrets never reach argv.** OAuth client secrets, API tokens, and access
 *    keys travel as env assignments inside the piped script, which lives only
 *    on the local process's stdin and the remote shell's memory. A remote argv
 *    is world-readable through `ps` on the VPS; a local one is world-readable
 *    on the developer's machine.
 * 2. **No connection multiplexing.** Every remote call is an independent `ssh`
 *    invocation on every platform (see the plan's Platform section): Win32
 *    OpenSSH has no ControlMaster, a persisted master would silently reuse the
 *    stale group set right after the docker-group fix, and a master whose TCP
 *    died during a long console step hangs the next call instead of
 *    reconnecting. `assembleSshArgs` therefore never emits a control option,
 *    and a test asserts that.
 */

import { spawn } from "node:child_process";

export type ProcessRunResult = {
  exitCode: number | null;
  signal: string | null;
};

export type ProcessRunOptions = {
  args: readonly string[];
  command: string;
  env?: Record<string, string | undefined>;
  /**
   * Hand the child the parent's stdio instead of capturing it. The bootstrap
   * ssh connection needs this: host-key confirmation and DigitalOcean's forced
   * first-login password change are interactive prompts from ssh itself, and a
   * captured stream would swallow them. Mutually exclusive with `stdin` and
   * `onOutput` — an inherited child writes straight to the terminal.
   */
  interactive?: boolean;
  /** Merged stdout+stderr, chunk by chunk, in arrival order. */
  onOutput?: (chunk: string) => void;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
};

/**
 * The process primitive, injectable so tests exercise the whole ssh layer
 * without launching a real `ssh`. `streamCommand` could not be reused: it
 * spawns with `stdio: ["ignore", ...]` and this layer's entire delivery
 * mechanism is stdin.
 */
export type RunProcess = (
  options: ProcessRunOptions,
) => Promise<ProcessRunResult>;

export class RemoteExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteExecError";
  }
}

export type SshInvocation = {
  /**
   * Host-key policy. `"yes"` verifies against known_hosts and fails on an
   * unknown host, so a batch-mode call can never be the one that records a
   * first-contact key — that confirmation belongs to an interactive channel
   * where the fingerprint reaches the user. `"accept-new"` trusts an unknown
   * host on first sight and is reserved for the console-paste pairing poll,
   * the one connection that is unavoidably first contact with nobody to ask
   * (the paste one-liner proves control of the host through the provider's
   * console instead). Unset leaves ssh's default "ask" for the interactive
   * bootstrap.
   */
  strictHostKeyChecking?: "accept-new" | "yes";
  /**
   * Never fall back to a password/keyboard-interactive prompt. Set on every
   * scripted call: without it a rejected key drops the pairing poll into a
   * password prompt against a captured stdin and the run hangs forever.
   */
  batchMode?: boolean;
  /** Fail fast on an unreachable host instead of waiting out the TCP default. */
  connectTimeoutSeconds?: number;
  /** The CLI-owned private key. Absent only on the bootstrap connection. */
  identityFile?: string;
  target: string;
  /**
   * Allocate a remote TTY. Only the first, interactive bootstrap connection
   * does; every scripted `bash -s` call runs without one so no script can block
   * on a prompt the user never sees.
   */
  tty?: boolean;
};

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 15;

const SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SERVER_ALIVE_COUNT_MAX = 8;

/**
 * Valid shell identifier. Anything else is a bug in the caller, not user input:
 * env names are literals in this codebase, so rejecting is always right.
 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The bootstrap connection: the user's own SSH setup is the delivery channel
 * for the CLI's public key, so no identity is pinned and no batch mode is
 * imposed — the user must be able to answer ssh's own questions.
 */
export function bootstrapSshInvocation(
  target: string,
  identityFile?: string,
): SshInvocation {
  return {
    connectTimeoutSeconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
    ...(identityFile !== undefined ? { identityFile } : {}),
    target,
    tty: true,
  };
}

/**
 * Every call after pairing: the CLI's key, no prompts, no password fallback,
 * and strict host-key verification. `trustNewHostKey` relaxes that to
 * accept-new for the console-paste pairing poll only — see the policy note on
 * `SshInvocation.strictHostKeyChecking`.
 */
export function pairedSshInvocation(
  target: string,
  identityFile: string,
  options?: { trustNewHostKey?: boolean },
): SshInvocation {
  return {
    batchMode: true,
    connectTimeoutSeconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
    identityFile,
    strictHostKeyChecking:
      options?.trustNewHostKey === true ? "accept-new" : "yes",
    target,
  };
}

/**
 * The connection options shared by ssh and scp. One assembler, so the two
 * programs can never drift apart on the invariants they both carry (no
 * multiplexing, the CLI key, batch mode, host-key policy) — it is the same
 * connection under a different program.
 */
function assembleConnectionOptions(invocation: SshInvocation): string[] {
  const args: string[] = [
    "-o",
    `ConnectTimeout=${String(
      invocation.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS,
    )}`,
    // ConnectTimeout only covers dialling; nothing bounds an established
    // connection that stops answering. The build call runs ~20 minutes and the
    // backup scp moves gigabytes, long enough for a NAT mapping to expire or a
    // laptop to change networks, and kernel TCP keepalive would not notice for
    // ~2 hours — the run would sit on a dead socket with the spinner still
    // animating, since completion is judged by exit code. 15s x 8 probes fails
    // a dead path in ~2 minutes. The counter resets on any packet received, so
    // an active transfer never trips it; the slack is for a host too busy to
    // schedule sshd — the documented 2 GB first-install build can thrash swap
    // long enough that a tighter budget would abort a build that finishes.
    "-o",
    `ServerAliveInterval=${String(SERVER_ALIVE_INTERVAL_SECONDS)}`,
    "-o",
    `ServerAliveCountMax=${String(SERVER_ALIVE_COUNT_MAX)}`,
  ];

  if (invocation.batchMode === true) {
    args.push("-o", "BatchMode=yes");
  }

  if (invocation.strictHostKeyChecking !== undefined) {
    args.push("-o", `StrictHostKeyChecking=${invocation.strictHostKeyChecking}`);
  }

  if (invocation.identityFile !== undefined) {
    const identityFile = validateIdentityFile(invocation.identityFile);
    // IdentitiesOnly keeps a loaded ssh-agent from offering a different key
    // first: the server may accept it, and then a later run from a machine
    // without that agent would fail while the CLI believed it was paired.
    args.push("-o", "IdentitiesOnly=yes", "-i", identityFile);
  }

  return args;
}

export function assembleSshArgs(
  invocation: SshInvocation,
  remoteArgs: readonly string[] = [],
): string[] {
  const target = validateSshTarget(invocation.target);
  const args = assembleConnectionOptions(invocation);

  // -T on scripted calls: a TTY would make the remote scripts think they can
  // prompt (install.sh's `[ -t 0 ]` checks), and clack owns the local terminal.
  args.push(invocation.tty === true ? "-tt" : "-T");
  args.push(target);
  args.push(...remoteArgs);

  return args;
}

/** `scp` for the backup download and the local-backup upload. */
export function assembleScpArgs(
  invocation: SshInvocation,
  paths: readonly string[],
): string[] {
  const args = assembleConnectionOptions(invocation);

  // -r for directories, -p to keep timestamps so a downloaded backup still
  // looks like what it is. `--` closes the option list: a path is data.
  args.push("-r", "-p", "--", ...paths);

  return args;
}

/**
 * `user@host:/path`.
 *
 * Deliberately NOT quoted. scp's two transports disagree about quoting: the
 * legacy rcp protocol expands the remote path through a shell, while OpenSSH 9's
 * default SFTP transport takes it literally — so a quoted path would either be
 * unquoted or arrive with the quote characters in the filename, depending on
 * the scp on the user's machine. Every path this is called with is
 * CLI-generated or came back from `pwd -P`, so the safe rule is to require a
 * plain path and refuse anything a shell would have reinterpreted.
 */
export function formatScpRemotePath(target: string, path: string): string {
  if (!path.startsWith("/")) {
    throw new RemoteExecError(
      `remote path for scp must be absolute (got ${path})`,
    );
  }

  if (/[\s"'$`\\*?[\];&|<>()!#~]/u.test(path) || containsControlCharacter(path)) {
    throw new RemoteExecError(
      `remote path for scp must not contain shell or glob characters (got ${path}); copy it by hand instead`,
    );
  }

  return `${validateSshTarget(target)}:${path}`;
}

export type RemoteShellRequest = {
  /**
   * A shell body written by the CLI, never assembled from user input: values
   * the user supplied reach it through `env` and are referenced as `"$VAR"`.
   * That is the whole injection boundary — a literal body plus quoted exports.
   */
  body: string;
  env?: Readonly<Record<string, string>>;
  /**
   * Merge the remote stderr into stdout at the source. On by default: the
   * scripts split their own narration across both channels (`log_selfhost` to
   * stdout, `warn_selfhost`/`fail_selfhost` to stderr, common.sh) and ssh gives
   * the two no ordering guarantee, so merging is what keeps the log and the
   * rendered view in the order the script actually produced.
   */
  mergeStderr?: boolean;
};

export type RemoteScriptRequest = {
  /** argv of the remote program; element 0 is the executable. */
  command: readonly string[];
  /** Absolute remote directory to run in. Never a tilde — see below. */
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  mergeStderr?: boolean;
};

/** The generated program handed to `bash -s`. */
export function buildRemoteShellScript(request: RemoteShellRequest): string {
  const lines = ["set -eu"];

  if (request.mergeStderr !== false) {
    lines.push("exec 2>&1");
  }

  for (const [name, value] of Object.entries(request.env ?? {})) {
    lines.push(`export ${serializeEnvAssignment(name, value)}`);
  }

  lines.push(request.body);

  return `${lines.join("\n")}\n`;
}

export function buildRemoteScript(request: RemoteScriptRequest): string {
  if (request.command.length === 0) {
    throw new RemoteExecError("a remote command is required");
  }

  const body: string[] = [];
  if (request.cwd !== undefined) {
    body.push(`cd ${quoteShellValue("cwd", request.cwd)}`);
  }

  const command = request.command
    .map((argument, index) =>
      quoteShellValue(`command argument ${String(index)}`, argument),
    )
    .join(" ");
  body.push(`exec ${command}`);

  return buildRemoteShellScript({
    body: body.join("\n"),
    ...(request.env !== undefined ? { env: request.env } : {}),
    ...(request.mergeStderr !== undefined
      ? { mergeStderr: request.mergeStderr }
      : {}),
  });
}

export function serializeEnvAssignment(name: string, value: string): string {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new RemoteExecError(
      `invalid environment variable name for the remote script: ${name}`,
    );
  }

  return `${name}=${quoteShellValue(name, value)}`;
}

/**
 * The one shell serializer. Single quotes are the only form that survives every
 * value the wizard collects — `$`, backticks, spaces, double quotes, and `!`
 * are all literal inside them — with `'\''` for an embedded single quote.
 *
 * The rejected shapes are rejected because they cannot be represented, not
 * because they are suspicious: a newline would split the assignment into two
 * shell words and a NUL cannot cross the process boundary at all. The error
 * deliberately names the variable and never echoes the value, so a rejected
 * secret does not land in a terminal or a log.
 */
export function quoteShellValue(label: string, value: string): string {
  if (value.includes("\0")) {
    throw new RemoteExecError(
      `${label} must not contain a NUL byte (it cannot be passed to the remote shell)`,
    );
  }

  if (/[\n\r]/u.test(value)) {
    throw new RemoteExecError(
      `${label} must not contain a newline (the remote script is line-oriented)`,
    );
  }

  if (containsControlCharacter(value)) {
    throw new RemoteExecError(`${label} must not contain control characters`);
  }

  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Control characters cannot be represented safely in the generated script (and
 * would corrupt the line-oriented renderer downstream). Checked by codepoint
 * rather than by regex so the source file stays free of literal control bytes.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * ssh reads a leading dash as an option, so a target or identity path that
 * starts with one turns a value into a flag. Both are rejected rather than
 * escaped: `--` placement differs between ssh versions, and neither shape is
 * ever legitimate here.
 */
function validateSshTarget(target: string): string {
  const trimmed = target.trim();

  if (trimmed.length === 0) {
    throw new RemoteExecError("an ssh target (user@host) is required");
  }

  if (trimmed.startsWith("-")) {
    throw new RemoteExecError(
      `ssh target must not start with "-" (it would be read as an option): ${trimmed}`,
    );
  }

  if (/[\s\0]/u.test(trimmed)) {
    throw new RemoteExecError(
      `ssh target must not contain whitespace: ${trimmed}`,
    );
  }

  const host = trimmed.includes("@")
    ? trimmed.slice(trimmed.lastIndexOf("@") + 1)
    : trimmed;
  if (host.length === 0) {
    throw new RemoteExecError(
      `ssh target must name a host after "@": ${trimmed}`,
    );
  }

  return trimmed;
}

function validateIdentityFile(path: string): string {
  if (path.trim().length === 0) {
    throw new RemoteExecError("identity file path must not be empty");
  }

  if (path.startsWith("-")) {
    throw new RemoteExecError(
      `identity file path must not start with "-" (it would be read as an option): ${path}`,
    );
  }

  if (/[\n\r\0]/u.test(path)) {
    throw new RemoteExecError(
      "identity file path must not contain newlines or NUL bytes",
    );
  }

  return path;
}

export type RunRemoteScriptOptions = RemoteScriptRequest & {
  connection: SshInvocation;
  onOutput?: (chunk: string) => void;
  runProcess: RunProcess;
};

/**
 * Runs one selfhost script on the remote host. Completion is the caller's to
 * judge from the exit code — never from a final log line, because install.sh's
 * closing summary is a bare printf with no `[selfhost]` prefix.
 */
export async function runRemoteScript(
  options: RunRemoteScriptOptions,
): Promise<ProcessRunResult> {
  const { connection, onOutput, runProcess, ...request } = options;

  return runRemoteShell({
    body: buildRemoteScript(request),
    connection,
    ...(onOutput !== undefined ? { onOutput } : {}),
    runProcess,
    verbatim: true,
  });
}

export type RunRemoteShellOptions = RemoteShellRequest & {
  connection: SshInvocation;
  onOutput?: (chunk: string) => void;
  runProcess: RunProcess;
  /** Internal: `body` is already a complete generated script. */
  verbatim?: boolean;
};

/** Runs a CLI-authored shell body on the remote host. */
export async function runRemoteShell(
  options: RunRemoteShellOptions,
): Promise<ProcessRunResult> {
  const { connection, onOutput, runProcess, verbatim, ...request } = options;
  const script =
    verbatim === true ? request.body : buildRemoteShellScript(request);

  return runProcess({
    args: assembleSshArgs(connection, ["bash", "-s"]),
    command: "ssh",
    ...(onOutput !== undefined ? { onOutput } : {}),
    stdin: script,
  });
}

export type RemoteCaptureResult = ProcessRunResult & {
  output: string;
};

/**
 * The same call, with the merged output buffered instead of streamed. Used for
 * the short probes (host facts, backup listing) whose output is parsed rather
 * than shown.
 */
export async function captureRemoteShell(
  options: Omit<RunRemoteShellOptions, "onOutput">,
): Promise<RemoteCaptureResult> {
  const chunks: string[] = [];
  const result = await runRemoteShell({
    ...options,
    onOutput: (chunk) => {
      chunks.push(chunk);
    },
  });

  return { ...result, output: chunks.join("") };
}

/** The default `RunProcess`, wired in runCli. Kept out of every test path. */
export function runProcessWithSpawn(
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: options.interactive === true
        ? "inherit"
        : ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      outcome();
    };

    const forward = (chunk: Buffer) => {
      options.onOutput?.(chunk.toString("utf8"));
    };

    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);

    // A spawn failure (ssh missing from PATH) and a write failure (the remote
    // shell exited before the script finished arriving) both surface here.
    // EPIPE on stdin is expected in the second case and must not mask the exit
    // code the child is about to report.
    child.on("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.on("close", (exitCode, signal) => {
      settle(() => {
        resolve({ exitCode, signal });
      });
    });

    if (child.stdin !== null) {
      child.stdin.on("error", () => {
        // Swallowed deliberately: `close` reports what actually happened.
      });
      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin);
      }
      child.stdin.end();
    }
  });
}
