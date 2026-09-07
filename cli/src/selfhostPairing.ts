/**
 * Pairing — the CLI-owned key, and the single credential model behind every
 * `selfhost` command.
 *
 * The CLI always generates its own ed25519 keypair for a host and installs the
 * public half there. The user's existing SSH setup is a *delivery channel* for
 * that key, never a runtime dependency: after pairing, `upgrade`, `backup`, and
 * `restore` authenticate with the CLI key alone, from a config entry, and the
 * user never deals with ssh again.
 *
 * Two channels, converging on the identical end state:
 *
 * 1. **Existing SSH works** (DigitalOcean/Hetzner root+key, anyone with a
 *    working `~/.ssh/config`): connect with the user's own setup, announce it,
 *    and append the CLI public key to `authorized_keys` over that connection.
 *    Zero extra action; the announcement plus proceeding is the consent.
 * 2. **Existing SSH fails**: a non-interactive run prints a one-liner for the
 *    provider's web console — every provider has one — and polls until the key
 *    lands. No vendor infrastructure is needed because the host address is
 *    already known, so a successful connection *is* the pairing signal, and
 *    the connecting username confirms the account.
 *
 * An interactive run does not guess which of those the user needs. The four
 * ways this connection actually fails are different problems with different
 * fixes, and a wizard that offers one of them treats the other three as the
 * end of the run: a key file never wired into `~/.ssh` (the EC2 `.pem` in
 * Downloads), a mistyped password or a server that wanted one, no local
 * credential at all (GCP metadata keys), and — the one that is not a
 * credential problem — a typo in the address itself. So the failure opens a
 * chooser offering exactly those four, each returning to the chooser when it
 * does not connect, and a corrected address restarting pairing against it.
 * Nothing here ends the wizard while a recovery is still untried.
 *
 * One failure is deliberately not in that chooser: a host key that changed
 * since this machine last connected. Rebuilding a VPS and keeping its address
 * is routine, and afterwards ssh refuses every connection to it — the key file
 * and password channels because their default `ask` checking turns a *changed*
 * key into a hard refusal rather than a question, and the console-paste poll
 * because `accept-new` trusts an unknown host and never a changed one. No
 * credential fixes that, so it is diagnosed from ssh's own words before the
 * chooser opens, and the poll that cannot succeed is abandoned rather than run
 * into its deadline.
 *
 * A password is deliberately never collected: the bootstrap probe is a real
 * interactive ssh, so where the server allows password authentication sshd
 * asks for it directly and the CLI never touches the secret. "Retry with a
 * password" is that same probe run again — a prompt of our own would move the
 * secret into this process for no gain.
 *
 * Because pairing lives here rather than inside the install wizard, a
 * maintenance command run against an unpaired host pairs on the spot instead of
 * erroring, and "my key is missing on a new laptop" is the same code path.
 */

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assembleSshArgs,
  bootstrapSshInvocation,
  pairedSshInvocation,
  quoteShellValue,
  runRemoteShell,
  type RunProcess,
  type SshInvocation,
} from "./remoteExec";
import { PLAIN_PALETTE, type Palette } from "./output";
import type { Progress } from "./progress";
import { resolveSelfhostKeyPath } from "./selfhostTarget";

/**
 * The comment on the installed key. Deliberately identifiable: the key is a
 * mutation of the user's host, and it must be findable and removable by hand in
 * `authorized_keys` without guessing which line the CLI added.
 */
const KEY_COMMENT = "cmpatch";

const POLL_INTERVAL_MILLISECONDS = 5_000;
const POLL_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;

export type SelfhostKeyPair = {
  path: string;
  publicKey: string;
  /** False when an existing key file was reused (abort-then-rerun). */
  created: boolean;
};

export type PairingChannel = "console-paste" | "existing-ssh";

export type PairingResult = {
  channel: PairingChannel;
  identityFile: string;
  sshTarget: string;
};

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/**
 * How the user chose to get past a connection that did not work.
 *
 * Typed rather than a string so the two halves of this flow cannot drift: the
 * prompt lives in the command layer (it owns the terminal), the transitions
 * live here, and every choice one side can offer is one the other handles.
 */
export type PairingRecovery =
  /** A different `user@host` — pairing restarts against it from the top. */
  | { kind: "change-target"; sshTarget: string }
  /** Print the one-liner for the provider's web console and poll. */
  | { kind: "console" }
  /** A key file the user already holds; becomes the bootstrap connection. */
  | { kind: "key-file"; path: string }
  /** Run the same interactive probe again, so sshd can ask for the password. */
  | { kind: "password-retry" };

export type PairingDeps = {
  /**
   * Asked when neither automatic attempt connects: how the user wants to
   * recover. Called again after every choice that does not end in a working
   * connection, so no single failed attempt ends the run. Absent on
   * non-interactive runs, where `--ssh-key` and the console one-liner remain
   * the only paths.
   */
  askRecovery?: (context: { sshTarget: string }) => Promise<PairingRecovery>;
  env: Record<string, string | undefined>;
  now: () => number;
  /** Colours the line the user pastes; plain when absent. */
  palette?: Palette;
  progress: Progress;
  runProcess: RunProcess;
  sleep: (milliseconds: number) => Promise<void>;
  /** Printed for the user to paste into the provider's web console. */
  writeNotice: (message: string) => void;
};

export type PairingOptions = {
  /**
   * `--ssh-key <path>`. Affects the **bootstrap connection only** — a known
   * `.pem` the user already has. It never becomes the durable credential, and
   * no per-provider key heuristics exist beyond it.
   */
  bootstrapIdentityFile?: string;
  pollIntervalMilliseconds?: number;
  pollTimeoutMilliseconds?: number;
  sshTarget: string;
};

/**
 * Generates the CLI's key for a host, or reuses the one already there.
 *
 * Keyed by ssh host rather than by server URL: pairing runs before any server
 * exists, so there is no URL to key on, and a rerun after a mid-wizard abort
 * must find the same file instead of minting a second key the host has never
 * seen.
 */
export async function ensureSelfhostKeyPair(
  deps: Pick<PairingDeps, "env" | "runProcess">,
  sshTarget: string,
): Promise<SelfhostKeyPair> {
  const path = resolveSelfhostKeyPath(deps.env, sshTarget);
  const existing = await readExistingKeyPair(deps, path);
  if (existing !== null) {
    return { created: false, path, publicKey: existing };
  }

  await mkdir(dirname(path), { mode: 0o700, recursive: true });

  const result = await deps.runProcess({
    args: [
      "-t",
      "ed25519",
      // No passphrase: the key exists so unattended commands can run, and a
      // passphrase would only move the secret into an agent the CLI does not
      // control. The file mode is the protection, as it is for ~/.ssh keys.
      "-N",
      "",
      "-C",
      KEY_COMMENT,
      "-f",
      path,
      "-q",
    ],
    command: "ssh-keygen",
  });

  if (result.exitCode !== 0) {
    throw new PairingError(
      `could not generate an ssh key at ${path} (ssh-keygen exited with status ${String(
        result.exitCode ?? 1,
      )}). ssh-keygen ships with OpenSSH — install it, or pass --ssh-key to use a key you already have.`,
    );
  }

  // ssh-keygen already writes 0600, but a restrictive umask is not guaranteed
  // on every platform and ssh refuses a group-readable private key outright.
  await chmod(path, 0o600);

  const publicKey = await readExistingKeyPair(deps, path);
  if (publicKey === null) {
    throw new PairingError(`ssh-keygen did not write ${path}.pub`);
  }

  return { created: true, path, publicKey };
}

async function readExistingKeyPair(
  deps: Pick<PairingDeps, "runProcess">,
  path: string,
): Promise<string | null> {
  try {
    await stat(path);
  } catch {
    return null;
  }

  try {
    const publicKey = await readFile(`${path}.pub`, "utf8");
    return publicKey.trim();
  } catch {
    // A private key without its .pub (a crash inside ssh-keygen, a partially
    // copied state directory). Regenerating the private half would invalidate
    // a key the host may already trust — and rerunning ssh-keygen against the
    // existing file would only hit its "Overwrite (y/n)?" prompt on a closed
    // stdin — so the public half is rederived from the private one instead.
    return rederivePublicKey(deps, path);
  }
}

/** `ssh-keygen -y` recomputes the public half from the private key file. */
async function rederivePublicKey(
  deps: Pick<PairingDeps, "runProcess">,
  path: string,
): Promise<string> {
  const chunks: string[] = [];
  const result = await deps.runProcess({
    args: ["-y", "-f", path],
    command: "ssh-keygen",
    onOutput: (chunk) => {
      chunks.push(chunk);
    },
  });

  // The merged stream may carry warnings; the key line is the one that starts
  // with a key type.
  const publicKey = chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^(ssh|ecdsa)-/u.test(line));

  if (result.exitCode !== 0 || publicKey === undefined) {
    throw new PairingError(
      `${path} exists but its public half (${path}.pub) is missing and could not be rederived (ssh-keygen -y exited with status ${String(
        result.exitCode ?? 1,
      )}). The key file may be corrupt: delete it to pair with a fresh key, or pass --ssh-key to use one you already have.`,
    );
  }

  await writeFile(`${path}.pub`, `${publicKey}\n`);
  return publicKey;
}

export async function pairWithHost(
  deps: PairingDeps,
  options: PairingOptions,
): Promise<PairingResult> {
  let sshTarget = options.sshTarget.trim();

  // One pass per address. A corrected target restarts from the top rather than
  // retrying in place: the CLI key is keyed by host, so a new address needs its
  // own key and deserves the same automatic attempts the first one got — the
  // corrected address is usually the one that simply works.
  for (;;) {
    const attempt = await pairWithTarget(deps, options, sshTarget);
    if (attempt.kind === "paired") {
      return attempt.result;
    }

    sshTarget = attempt.sshTarget;
  }
}

type PairingAttempt =
  | { kind: "paired"; result: PairingResult }
  | { kind: "retarget"; sshTarget: string };

async function pairWithTarget(
  deps: PairingDeps,
  options: PairingOptions,
  sshTarget: string,
): Promise<PairingAttempt> {
  const keyPair = await ensureSelfhostKeyPair(deps, sshTarget);

  deps.progress.write(
    keyPair.created
      ? `generated a dedicated key for this server (${keyPair.path})`
      : `reusing this server's key (${keyPair.path})`,
  );

  // Already paired? Then nothing needs to be installed and neither channel
  // runs. This is also the fast path for every command after the first.
  const preProbe = await probeWithKey(deps, sshTarget, keyPair.path);
  if (preProbe.connected) {
    deps.progress.write(`connected to ${sshTarget}`);
    return {
      kind: "paired",
      result: {
        channel: "existing-ssh",
        identityFile: keyPair.path,
        sshTarget,
      },
    };
  }

  const bootstrap = bootstrapSshInvocation(
    sshTarget,
    options.bootstrapIdentityFile,
  );
  const askRecovery = deps.askRecovery;

  // Latched for the rest of this target: every later failure has to be read
  // against it, because a chooser pick made before the recorded key is cleared
  // fails inside ssh for this reason and no other.
  let changedHostKey = readsAsChangedHostKey(preProbe.output);

  if (changedHostKey !== null) {
    // Nothing is attempted against this address until the recorded key is
    // dealt with: ssh stops every channel before the server hears any of them,
    // so trying them would only bury the one thing that fixes it under a wall
    // of ssh's own capitals.
    const diagnosis = renderChangedHostKey(sshTarget, changedHostKey, {
      chooserFollows: askRecovery !== undefined,
    });

    if (askRecovery === undefined) {
      throw new PairingError(diagnosis);
    }

    // `warn` settles the step in flight itself, so the notice below lands on a
    // clean line without a settle of its own.
    deps.progress.warn(
      `${hostToForget(sshTarget, changedHostKey)} is answering with a different host key than the one your machine recorded`,
    );
    deps.writeNotice(diagnosis);
  } else {
    deps.progress.write("connecting with your existing SSH setup");

    if (await canConnectInteractively(deps, bootstrap)) {
      return {
        kind: "paired",
        result: await pairOverBootstrap(deps, bootstrap, sshTarget, keyPair),
      };
    }

    if (askRecovery === undefined) {
      // Nobody to ask: the console one-liner is the only path left, and a poll
      // that runs out there is the end of the run.
      await pairThroughConsolePaste(deps, options, sshTarget, keyPair, {
        recoverable: false,
      });

      return {
        kind: "paired",
        result: {
          channel: "console-paste",
          identityFile: keyPair.path,
          sshTarget,
        },
      };
    }

    deps.progress.warn("couldn't connect with your existing SSH setup");
  }

  for (;;) {
    const recovery = await askRecovery({ sshTarget });

    if (recovery.kind === "change-target") {
      return { kind: "retarget", sshTarget: recovery.sshTarget.trim() };
    }

    if (recovery.kind === "console") {
      const attempt = await pairThroughConsolePaste(
        deps,
        options,
        sshTarget,
        keyPair,
        { recoverable: true },
      );

      // The poll is itself a probe, so its verdict replaces the latch either
      // way: it saw the key change, or it ran without ssh ever saying so.
      changedHostKey = attempt.changedHostKey;

      if (attempt.paired) {
        return {
          kind: "paired",
          result: {
            channel: "console-paste",
            identityFile: keyPair.path,
            sshTarget,
          },
        };
      }

      continue;
    }

    // The remaining two are the same move under different names: hand the
    // terminal to a real ssh and let it ask for whatever it needs. A key file
    // pins an identity exactly as `--ssh-key` does; a password retry is the
    // automatic attempt run again, unchanged, because a mistyped password (or
    // DigitalOcean's forced first-login change) is the failure it recovers.
    const retry =
      recovery.kind === "key-file"
        ? bootstrapSshInvocation(sshTarget, recovery.path)
        : bootstrap;

    deps.progress.write(
      recovery.kind === "key-file"
        ? `connecting with ${recovery.path}`
        : `connecting to ${sshTarget} — ssh asks for the password itself, so cmpatch never sees it`,
    );

    if (await canConnectInteractively(deps, retry)) {
      return {
        kind: "paired",
        result: await pairOverBootstrap(deps, retry, sshTarget, keyPair),
      };
    }

    // A pick made before the recorded key was cleared fails inside ssh with the
    // same wall of capitals, and the credential verdicts below would then be
    // the wrong second diagnosis — scrolling the right one away. The strict
    // probe is non-interactive and returns at once, so it is re-run to see
    // whether that is still the state, and it also clears the latch once the
    // user has run `ssh-keygen -R`.
    if (changedHostKey !== null) {
      const recheck = await probeWithKey(deps, sshTarget, keyPair.path);
      changedHostKey = readsAsChangedHostKey(recheck.output);

      if (changedHostKey !== null) {
        deps.progress.settle();
        deps.writeNotice(
          renderChangedHostKey(sshTarget, changedHostKey, {
            chooserFollows: true,
          }),
        );
        continue;
      }
    }

    deps.progress.warn(
      recovery.kind === "key-file"
        ? `couldn't connect to ${sshTarget} with ${recovery.path}`
        : `couldn't connect to ${sshTarget} with a password — the server may not allow password sign-in at all`,
    );
  }
}

async function pairOverBootstrap(
  deps: PairingDeps,
  bootstrap: SshInvocation,
  sshTarget: string,
  keyPair: SelfhostKeyPair,
): Promise<PairingResult> {
  deps.progress.write(
    "installing the cmpatch key on the server, so future commands won't depend on your local SSH setup",
  );
  await installPublicKey(deps, bootstrap, keyPair.publicKey);

  // Prove the installed key actually works before reporting success: an
  // append that landed in the wrong home directory (a sudo-ed shell, an
  // unusual ~) would otherwise be reported as paired and fail on the next
  // command, when the bootstrap channel is no longer on screen.
  if (!(await probeWithKey(deps, sshTarget, keyPair.path)).connected) {
    throw new PairingError(
      `the cmpatch key was installed on ${sshTarget} but the server did not accept it. Check that ~/.ssh/authorized_keys is writable by ${sshTarget} and that sshd allows public-key authentication.`,
    );
  }

  deps.progress.write(`paired with ${sshTarget}`);
  return { channel: "existing-ssh", identityFile: keyPair.path, sshTarget };
}

type ConsolePasteOutcome = {
  /**
   * What ssh reported about the recorded host key on the last poll — `null`
   * when it never said the key changed. Carried back so the chooser this was
   * picked from keeps an accurate reading of the state.
   */
  changedHostKey: ChangedHostKey | null;
  paired: boolean;
};

/**
 * Returns `paired: false` only when a `recoverable` poll ends — the interactive
 * case, where the chooser this was picked from is still there and the paste may
 * simply not have happened yet. A non-recoverable run throws instead: there is
 * nothing else left to offer.
 */
async function pairThroughConsolePaste(
  deps: PairingDeps,
  options: PairingOptions,
  sshTarget: string,
  keyPair: SelfhostKeyPair,
  mode: { recoverable: boolean },
): Promise<ConsolePasteOutcome> {
  deps.progress.settle();
  deps.writeNotice(
    renderConsolePasteInstructions(sshTarget, keyPair.publicKey, {
      // Picked from a chooser that already announced the failure and lists
      // "use a key file" as its own entry — repeating either is noise.
      afterRecoveryChoice: mode.recoverable,
      ...(deps.palette !== undefined ? { palette: deps.palette } : {}),
    }),
  );

  const interval = options.pollIntervalMilliseconds ?? POLL_INTERVAL_MILLISECONDS;
  const timeout = options.pollTimeoutMilliseconds ?? POLL_TIMEOUT_MILLISECONDS;
  const deadline = deps.now() + timeout;

  // The paste is the user's move, and nothing happens until they make it — so
  // the spinner says so, instead of reading as the wizard connecting on its
  // own.
  deps.progress.write(
    `waiting for you to paste the line above into your provider's web console — checking again every ${String(Math.round(interval / 1_000))} seconds`,
  );

  for (;;) {
    // The one accept-new connection: this poll is unavoidably first contact
    // (no channel that shows a fingerprint exists — that is why the paste
    // one-liner is on screen), so trust-on-first-use is the documented trade.
    const probe = await probeWithKey(deps, sshTarget, keyPair.path, {
      trustNewHostKey: true,
    });

    if (probe.connected) {
      deps.progress.write(`connected as ${sshTarget} — paired`);
      return { changedHostKey: null, paired: true };
    }

    // accept-new trusts an unknown host, never a changed one — so once ssh
    // says the key changed, this poll has no outcome but its deadline, and
    // waiting it out would answer a rebuilt server with firewall advice.
    const changedHostKey = readsAsChangedHostKey(probe.output);
    if (changedHostKey !== null) {
      const diagnosis = renderChangedHostKey(sshTarget, changedHostKey, {
        chooserFollows: mode.recoverable,
      });

      if (!mode.recoverable) {
        throw new PairingError(diagnosis);
      }

      deps.progress.settle();
      deps.writeNotice(diagnosis);
      return { changedHostKey, paired: false };
    }

    if (deps.now() >= deadline) {
      const message = renderPollTimeout(sshTarget, timeout);
      if (!mode.recoverable) {
        throw new PairingError(message);
      }

      deps.progress.settle();
      deps.writeNotice(message);
      return { changedHostKey: null, paired: false };
    }

    await deps.sleep(interval);
  }
}

type ChangedHostKey = {
  /**
   * The host ssh itself named as the one whose key changed, when the output
   * named one in a shape safe to echo.
   *
   * Not derivable from the typed target: `known_hosts` is keyed by the resolved
   * `HostName` (or `HostKeyAlias`), and by `[host]:port` on any port but 22 —
   * so for a `~/.ssh/config` alias, which this CLI accepts as a target, the
   * typed half names no entry at all and `ssh-keygen -R` would exit 0, say "not
   * found", remove nothing, and leave the user exactly where they were.
   */
  host: string | null;
  /**
   * The `known_hosts` file ssh named as holding the old key, when it named one
   * (the line number ssh appends is dropped — `-f` takes a file). Worth
   * carrying because `ssh-keygen -R` edits the default file only: a key
   * recorded in some other `UserKnownHostsFile` survives it, and the advice
   * would look like it did nothing.
   */
  recordedIn: string | null;
};

/**
 * ssh's own diagnosis, read back out of the probe output.
 *
 * Matched on the sentences OpenSSH only ever prints for a *changed* key — never
 * on "Host key verification failed", which is also what an ordinary unknown
 * host produces under `StrictHostKeyChecking=yes`, i.e. every first-ever
 * pairing this CLI does.
 *
 * The two tokens read out of here are echoed into a command the user will run,
 * from a stream a hostile server can write to (an sshd `Banner` is printed
 * before authentication), so each is taken only in the shape it must have.
 */
function readsAsChangedHostKey(output: string): ChangedHostKey | null {
  const plain = stripAnsi(output);
  const named = /host key for ([^\n]*?) has changed/iu.exec(plain);

  if (named === null && !/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(plain)) {
    return null;
  }

  // "Add correct host key in <file>" is truncated by ssh when the path is long;
  // the Offending line is not, so the file is taken from there alone.
  const offending = /^Offending [^\n]*? key in ([^\n]+)$/mu.exec(plain);

  return {
    host: hostToken(named?.[1]),
    recordedIn: knownHostsPath(offending?.[1]),
  };
}

/** Longest token this file will echo back into a command it prints. */
const MAX_ECHOED_LENGTH = 256;

/**
 * A `known_hosts` entry key: a hostname, an address, or either wrapped as
 * `[host]:port` off port 22 — nothing that could carry shell syntax or control
 * characters out of a server's banner and into printed copy.
 */
function hostToken(candidate: string | undefined): string | null {
  const token = candidate?.trim() ?? "";
  // Anchored on an alphanumeric or the bracket form so no token can arrive
  // looking like an option to the command it is pasted into.
  return token.length <= MAX_ECHOED_LENGTH &&
    /^(?:\[[A-Za-z0-9][A-Za-z0-9.:_-]*\]:\d{1,5}|[A-Za-z0-9][A-Za-z0-9.:_-]*)$/u.test(
      token,
    )
    ? token
    : null;
}

/**
 * The file half of ssh's `Offending <type> key in <file>:<line>`, kept only when
 * it still looks like a path after the line number is taken off.
 */
function knownHostsPath(candidate: string | undefined): string | null {
  const path = (candidate?.trim() ?? "").replace(/:\d+$/u, "");
  // No backslash and nothing quote-like: the result is pasted inside double
  // quotes, where an escape would be the one character able to end them.
  return path.length <= MAX_ECHOED_LENGTH && /^[A-Za-z0-9._~/ -]+$/u.test(path)
    ? path
    : null;
}

/** CSI sequences, in case a server's banner colours the lines matched above. */
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  "gu",
);

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * The host `ssh-keygen -R` has to be given: ssh's own word for it where the
 * output named one, and the typed target's host half only as a fallback.
 */
function hostToForget(sshTarget: string, changed: ChangedHostKey): string {
  return changed.host ?? sshHostOf(sshTarget);
}

/**
 * What a changed host key means, in the two ways it can mean it.
 *
 * Rebuilding an instance and keeping its address is the ordinary reason and the
 * likely one — but it is not the only one, and a CLI that says "just clear it"
 * would be talking a user through the exact motion an interception needs. So
 * both readings are on screen, and the command that clears the key is offered
 * only after the user decides which one they are in.
 */
function renderChangedHostKey(
  sshTarget: string,
  changed: ChangedHostKey,
  options: { chooserFollows: boolean },
): string {
  const host = hostToForget(sshTarget, changed);
  // Quoted because a `[host]:port` entry is glob syntax to the shell that will
  // run this, and `-f` because the default file is not always the one holding
  // the entry — naming the file ssh named turns a location the user would have
  // had to act on themselves into part of the command.
  const remedy =
    changed.recordedIn === null
      ? `ssh-keygen -R "${host}"`
      : `ssh-keygen -f "${changed.recordedIn}" -R "${host}"`;

  return [
    `${host} is answering with a different host key than the one your machine`,
    "recorded for it, so ssh is refusing to connect at all.",
    "",
    "If you rebuilt or replaced this server and kept its address, that is",
    "expected: the new machine generated its own key. If you did not, take it",
    "seriously — a changed key is also what something answering in place of",
    "your server looks like.",
    "",
    // The wizard owns this terminal until it is answered, so the command has to
    // be placed somewhere the user can actually run it from.
    "Once you are satisfied it is your server, run this in another terminal",
    "window to forget the old key:",
    "",
    `  ${remedy}`,
    "",
    // No entry in the chooser fixes this, so the way back in has to be named —
    // both of the entries that simply make this connection again, since which
    // one applies depends on how the server takes credentials.
    ...(options.chooserFollows
      ? [
          'Then pick "Retry with an SSH password" below to make this connection',
          "again — ssh asks for a password only if the server wants one. If this",
          'server takes a key file instead, pick "Use a private key file".',
        ]
      : ["Then run this command again."]),
  ].join("\n");
}

function renderPollTimeout(sshTarget: string, timeout: number): string {
  return [
    `Still could not connect to ${sshTarget} after ${String(
      Math.round(timeout / 60_000),
    )} minutes.`,
    "",
    // The poll cannot tell "not pasted yet" from "host unreachable", so the
    // message stays honest about both rather than picking one.
    "Either the line has not been pasted yet, or this machine cannot reach the server at all.",
    // Named rather than detected: on GCE with OS Login on, the paste succeeds
    // and the poll still never authenticates, which reads exactly like "not
    // pasted yet" until the user has the term to search for.
    "On Google Cloud there is a third possibility: an instance with OS Login turned",
    "on (an enable-oslogin metadata entry set to TRUE) ignores the key the pasted",
    "line added. Turn OS Login off for that instance, or add the key through Google",
    "Cloud's own SSH key screen.",
    "If the server is behind a cloud firewall, allow inbound TCP 22 from your network:",
    "  AWS — the instance's Security Group inbound rules",
    "  GCP — a VPC firewall rule allowing tcp:22",
    "and check the host's own firewall (ufw / firewalld).",
  ].join("\n");
}

export function renderConsolePasteInstructions(
  sshTarget: string,
  publicKey: string,
  options?: { afterRecoveryChoice?: boolean; palette?: Palette },
): string {
  const afterRecoveryChoice = options?.afterRecoveryChoice === true;
  const palette = options?.palette ?? PLAIN_PALETTE;
  const remoteUser = sshUserOf(sshTarget);

  return [
    ...(afterRecoveryChoice
      ? []
      : [`Couldn't connect to ${sshTarget} with your existing SSH setup.`, ""]),
    "Open your cloud provider's web console (browser SSH — EC2 Instance",
    'Connect, GCP "SSH" button, DigitalOcean Console...) and paste:',
    "",
    // The one line the user copies, marked the way every other copied value
    // in the wizard is.
    `  ${palette.value(renderConsolePasteCommand(publicKey, remoteUser))}`,
    ...(remoteUser === null
      ? []
      : [
          "",
          `The console has to be signed in as ${remoteUser} — that is the account`,
          `${sshTarget} connects as, and a key added to any other account here`,
          "would never be seen. The line checks that first and changes nothing",
          "if it does not match.",
        ]),
    // GCP-only, and said only here: OS Login makes the paste a no-op (and can
    // remove the key later), which otherwise looks like a paste that never
    // happened. Naming it gives the user the term to search for.
    "",
    "On Google Cloud, check whether the instance has OS Login turned on (an",
    "enable-oslogin metadata entry set to TRUE): with OS Login on, keys added",
    "this way are ignored, and can be removed later. Turn it off for that",
    "instance, or add the key through Google Cloud's own SSH key screen instead.",
    ...(afterRecoveryChoice
      ? []
      : ["", "(have a key file instead? rerun with --ssh-key <path>)"]),
  ].join("\n");
}

/**
 * The account a target connects as, or null when the address does not name one
 * (a `~/.ssh/config` alias, whose user only that config knows). Null means the
 * pasted line cannot check the account and does not try — a check that guesses
 * would block the paste on a host where nothing was wrong.
 */
function sshUserOf(sshTarget: string): string | null {
  const separator = sshTarget.lastIndexOf("@");
  return separator > 0 ? sshTarget.slice(0, separator) : null;
}

/**
 * The host half of a target — what `known_hosts` is keyed by, and therefore
 * what `ssh-keygen -R` takes. The account never appears in a host key entry.
 */
function sshHostOf(sshTarget: string): string {
  const separator = sshTarget.lastIndexOf("@");
  return separator > 0 ? sshTarget.slice(separator + 1) : sshTarget;
}

/**
 * The line the user pastes into a browser console — the one mutation of their
 * host this CLI cannot perform itself, so it has to be as safe by hand as
 * `installPublicKey` is over ssh, and survive being pasted twice.
 *
 * The account guard is not ceremony: a provider console signs the user in as
 * whoever that console decides (GCP derives it from the Google account, EC2
 * Instance Connect from the AMI), which routinely is not the user in the
 * address the CLI is polling. Without the check the key lands in a real
 * `authorized_keys` that the poll will never authenticate against, and the
 * failure looks identical to "not pasted yet" for fifteen minutes.
 */
function renderConsolePasteCommand(
  publicKey: string,
  remoteUser: string | null,
): string {
  const install = [
    "mkdir -p ~/.ssh",
    "chmod 700 ~/.ssh",
    "touch ~/.ssh/authorized_keys",
    "chmod 600 ~/.ssh/authorized_keys",
    // Braced so the `||` binds to the grep alone: without the group a failed
    // chmod would fall through to appending anyway.
    `{ grep -qxF '${publicKey}' ~/.ssh/authorized_keys || printf '%s\\n' '${publicKey}' >> ~/.ssh/authorized_keys; }`,
  ].join(" && ");

  if (remoteUser === null) {
    return install;
  }

  // `if`/`else` rather than a guard that exits: in a browser console `exit 1`
  // closes the session the user just opened, taking the explanation with it.
  return [
    `if [ "$(id -un)" = '${remoteUser}' ]; then ${install};`,
    `else echo "This console is signed in as $(id -un), not ${remoteUser} — nothing was changed.";`,
    "fi",
  ].join(" ");
}

/**
 * Strict host-key checking by default: on a first-ever pairing this probe runs
 * BEFORE the interactive bootstrap, and with accept-new it would silently
 * record the unknown host key — after which the bootstrap, finding the host
 * already known, would never show the user a fingerprint on any channel. An
 * unknown host simply fails the probe here, handing first contact to the
 * bootstrap connection where ssh's own confirmation reaches the user.
 */
async function probeWithKey(
  deps: Pick<PairingDeps, "runProcess">,
  sshTarget: string,
  identityFile: string,
  options?: { trustNewHostKey?: boolean },
): Promise<KeyProbe> {
  const chunks: string[] = [];
  const result = await runRemoteShell({
    body: "exit 0",
    connection: pairedSshInvocation(sshTarget, identityFile, options),
    // Kept off the terminal, not thrown away: a failed probe is an expected
    // outcome here and ssh's own "Permission denied" noise would read as a
    // fault — but the same stream is where ssh says a host key changed, which
    // no other channel of this flow can work out.
    onOutput: (chunk) => {
      chunks.push(chunk);
    },
    runProcess: deps.runProcess,
  });

  return { connected: result.exitCode === 0, output: chunks.join("") };
}

type KeyProbe = {
  connected: boolean;
  /** ssh's merged output, read for diagnosis only — never printed as-is. */
  output: string;
};

/**
 * The one connection that gets the parent's stdio.
 *
 * ssh's own questions — host-key confirmation, a key passphrase — and the
 * server's own (DigitalOcean forces a password change on the first root login)
 * all have to reach the user, and a captured stream would swallow them with no
 * way to answer.
 */
async function canConnectInteractively(
  deps: Pick<PairingDeps, "progress" | "runProcess">,
  connection: SshInvocation,
): Promise<boolean> {
  // The spinner must stop before the child gets the terminal: ssh prints its
  // questions at the cursor without a trailing newline, and the next spinner
  // frame's line-clearing redraw erases exactly that line — leaving the user
  // at an invisible host-key prompt.
  deps.progress.settle();
  const result = await deps.runProcess({
    args: assembleInteractiveProbe(connection),
    command: "ssh",
    interactive: true,
  });

  return result.exitCode === 0;
}

function assembleInteractiveProbe(connection: SshInvocation): string[] {
  // `true` rather than a script: this call exists only to establish that the
  // user's own setup reaches the host, and to let ssh ask whatever it needs to.
  return assembleSshArgs(connection, ["true"]);
}

/**
 * The second connection that gets the parent's stdio.
 *
 * The probe just before this one proved the user's setup reaches the host,
 * but it proved nothing about how: a password-only host (a Hetzner root
 * password, DigitalOcean's password option) or a passphrase-protected key
 * with no agent loaded asks again on every new ssh, and the install is a new
 * ssh. A captured-stdio call here would leave that second question on
 * /dev/tty behind an animating spinner, with clack's raw-mode readline
 * eating the answer — the run hung forever at "installing the cmpatch key"
 * (found under a pty, 2026-09-02). So the install is the same shape as the
 * probe, and the user may be asked twice; a prompt of our own would only move
 * the secret into this process.
 *
 * With the terminal inherited there is no stdin to pipe a script through, so
 * the append travels as the remote command. The ssh layer's rule is that
 * secrets never reach argv, and this is the one value in the flow that is
 * designed to be world-readable. It is wrapped in `sh -c` because the remote
 * command runs under the account's login shell, and a fish shell would not
 * parse the `if … fi` of the script — the wrapper is the `bash -s` the piped
 * version used to bring along.
 */
async function installPublicKey(
  deps: Pick<PairingDeps, "progress" | "runProcess">,
  connection: SshInvocation,
  publicKey: string,
): Promise<void> {
  // Same reason as the probe: ssh's password prompt has no trailing newline,
  // and the next spinner frame would redraw exactly that line.
  deps.progress.settle();
  const result = await deps.runProcess({
    args: assembleSshArgs(connection, [
      "sh",
      "-c",
      quoteShellValue("key install script", renderKeyInstallCommand(publicKey)),
    ]),
    command: "ssh",
    interactive: true,
  });

  if (result.exitCode !== 0) {
    throw new PairingError(
      `could not install the cmpatch key on ${connection.target} (ssh exited with status ${String(
        result.exitCode ?? 1,
      )}).`,
    );
  }
}

/**
 * Idempotent by exact line, and append-only: the CLI adds one identifiable
 * line and never rewrites a file that may hold the user's own keys. One line
 * of POSIX sh, so it survives being quoted once more for the `sh -c` wrapper.
 */
function renderKeyInstallCommand(publicKey: string): string {
  const key = quoteShellValue("public key", publicKey);
  const file = '"$HOME/.ssh/authorized_keys"';

  return [
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    `touch ${file}`,
    `chmod 600 ${file}`,
    [
      `if ! grep -qxF ${key} ${file}; then`,
      // A hand-edited file whose last line has no newline would otherwise
      // have the key glued onto it, and sshd would read neither key. Only a
      // non-empty file can end mid-line; `tail -c 1` of one that ends in a
      // newline substitutes to the empty string.
      `[ ! -s ${file} ] || [ -z "$(tail -c 1 ${file})" ] || printf '\\n' >>${file};`,
      `printf '%s\\n' ${key} >>${file};`,
      "fi",
    ].join(" "),
  ].join(" && ");
}
