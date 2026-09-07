/**
 * `cmpatch selfhost upgrade | backup | restore`, and the namespace's dispatch.
 *
 * Every one of these is a thin wrapper: resolve the ssh target, pair if
 * needed, run the existing `scripts/selfhost/*.sh` over ssh, and render its
 * output. No script logic is reimplemented here. The interactive layers are
 * **selection and confirmation only**; every prompt has a flag equivalent, and
 * a non-interactive run behaves exactly like the flags-only command it was
 * before this namespace existed.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { PRODUCT_NAME, SOURCE_REPO_URL } from "../branding";
import type { SelfhostCommand } from "../commandTypes";
import { onInterruptCleanup } from "../progress";
import {
  assembleScpArgs,
  captureRemoteShell,
  formatScpRemotePath,
  pairedSshInvocation,
} from "../remoteExec";
import {
  BACKUP_MILESTONES,
  RESTORE_MILESTONES,
  UPGRADE_MILESTONES,
} from "../remoteOutput";
import {
  describeRestoredComponents,
  renderBackupIntro,
  renderRestoreConsequence,
  renderRestoreNoOp,
  renderRestoreScope,
} from "../selfhostCopy";
import { listRemoteBackups, type RemoteBackup } from "../selfhostRemote";
import { runLocalEval } from "./localEval";
import { runInstall } from "./selfhostInstall";
import {
  canAsk,
  COMMON_FLAGS,
  looksLikeSshTarget,
  openSession,
  parseArgs,
  readBooleanFlag,
  readStringFlag,
  RemoteScriptFailure,
  runSelfhostScript,
  takeSingleTarget,
  writeNotice,
  type FlagShape,
  type ParsedArgs,
  type SelfhostSession,
} from "./selfhostSession";
import { DeclinedError, UsageError, type CommandDeps } from "./shared";

const SUBCOMMANDS = [
  "backup",
  "install",
  "local-eval",
  "restore",
  "upgrade",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export async function executeSelfhostCommand(
  command: SelfhostCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const [subcommand, ...rest] = command.argv;

  if (subcommand === undefined || !isSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: cmpatch selfhost (${SUBCOMMANDS.join("|")}) [flags] [user@vps]`,
    );
  }

  switch (subcommand) {
    case "backup":
      return runBackup(deps, rest);
    case "install":
      // Only the summary: the server URL the outcome also carries is for
      // `cmpatch init`, which continues after the install.
      return (await runInstall(deps, rest)).summary;
    case "local-eval":
      // The one subcommand with no ssh target: the stack runs on this machine.
      return runLocalEval(deps, rest);
    case "restore":
      return runRestore(deps, rest);
    case "upgrade":
      return runUpgrade(deps, rest);
  }
}

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

const UPGRADE_FLAGS = {
  ...COMMON_FLAGS,
  "--i-have-a-backup": "boolean",
  "--image": "value",
  "--local-image": "boolean",
  "--skip-smoke": "boolean",
} as const satisfies FlagShape;

type SourceSync = {
  newRevision: string;
  oldRevision: string;
};

async function runUpgrade(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, UPGRADE_FLAGS);
  const sshTarget = takeSingleTarget(parsed, "upgrade");
  const session = await openSession(deps, {
    label: "cmpatch selfhost upgrade",
    parsed,
    ...(sshTarget !== undefined ? { sshTarget } : {}),
  });

  try {
    const sync = await syncRemoteSource(deps, session);

    const args: string[] = [];
    const image = readStringFlag(parsed, "--image");
    if (image !== undefined) {
      args.push("--image", image);
    }
    if (readBooleanFlag(parsed, "--local-image")) {
      args.push("--local-image");
    }
    if (readBooleanFlag(parsed, "--i-have-a-backup")) {
      args.push("--i-have-a-backup");
    }
    if (readBooleanFlag(parsed, "--skip-smoke")) {
      args.push("--skip-smoke");
    }

    await runSelfhostScript(deps, session, {
      args,
      // Pre-upgrade backups land under the CLI-managed root, so they show up
      // (labelled) in `restore`'s listing instead of under <repo>/backups
      // where nothing the user runs would ever find them.
      env: { SELFHOST_BACKUP_ROOT: session.facts.backupRoot },
      milestones: UPGRADE_MILESTONES,
      name: "upgrade",
      script: "upgrade.sh",
    });

    const summary = [
      `Upgrade complete on ${session.sshTarget}.`,
      `  Source: ${shortRevision(sync.oldRevision)} → ${shortRevision(sync.newRevision)}`,
      // Reported independently, because on --image they are no longer two
      // views of the same thing: the server image is pinned while the
      // dashboard is still built from the checkout.
      `  Server image: ${image ?? "rebuilt from the source above"}`,
    ].join("\n");
    session.progress.stop("Upgrade complete.");
    return summary;
  } catch (error) {
    session.progress.fail("Upgrade failed.");
    throw error;
  }
}

/**
 * Fast-forward the remote checkout before running the upgrade — on **every**
 * path, `--image` included.
 *
 * `--image` pins only the *server* image: on that branch `upgrade.sh` still
 * runs `compose build --pull caddy`, rebuilding the dashboard image from this
 * same checkout. Skipping the sync there would not avoid using the checkout —
 * it would only turn off the dirty/detached/diverged guard while continuing to
 * build from it, so a pinned server image could ship beside a dashboard built
 * from a stale or hand-edited tree, silently.
 */
async function syncRemoteSource(
  deps: CommandDeps,
  session: SelfhostSession,
): Promise<SourceSync> {
  session.progress.write("updating the server's copy of the source");

  const result = await captureRemoteShell({
    body: [
      'cd "$CMPATCH_REMOTE_PATH"',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  printf "sync_error=not-a-checkout\\n"; exit 3',
      "fi",
      'remote_url="$(git config --get remote.origin.url || true)"',
      'case "$remote_url" in',
      "  *codemagic-patch*) ;;",
      '  *) printf "sync_error=unexpected-remote\\nremote=%s\\n" "$remote_url"; exit 3 ;;',
      "esac",
      'branch="$(git symbolic-ref --quiet --short HEAD || true)"',
      'if [ -z "$branch" ]; then printf "sync_error=detached\\n"; exit 3; fi',
      'if [ -n "$(git status --porcelain)" ]; then printf "sync_error=dirty\\n"; exit 3; fi',
      'old="$(git rev-parse HEAD)"',
      'default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed "s#^origin/##" || true)"',
      'default_branch="${default_branch:-main}"',
      'if [ "$branch" != "$default_branch" ]; then',
      '  printf "sync_error=not-default-branch\\nbranch=%s\\ndefault_branch=%s\\n" "$branch" "$default_branch"; exit 3',
      "fi",
      'git fetch --quiet origin "$default_branch"',
      '# --ff-only is the guard: a diverged checkout fails here rather than',
      '# being merged into something nobody reviewed.',
      'if ! git merge --ff-only "origin/${default_branch}" >/dev/null 2>&1; then',
      '  printf "sync_error=diverged\\nbranch=%s\\n" "$branch"; exit 3',
      "fi",
      'printf "old_revision=%s\\nnew_revision=%s\\n" "$old" "$(git rev-parse HEAD)"',
    ].join("\n"),
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    env: { CMPATCH_REMOTE_PATH: session.remotePath },
    runProcess: deps.runProcess,
  });

  const values: Record<string, string> = {};
  for (const line of result.output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }

  if (result.exitCode !== 0) {
    throw new UsageError(
      describeSyncFailure(values, session.remotePath, result.output),
    );
  }

  const oldRevision = values.old_revision ?? "";
  const newRevision = values.new_revision ?? "";
  session.progress.write(
    oldRevision === newRevision
      ? "the server's source is already up to date"
      : `updated the source (${shortRevision(oldRevision)} → ${shortRevision(newRevision)})`,
  );

  return { newRevision, oldRevision };
}

function describeSyncFailure(
  values: Record<string, string>,
  remotePath: string,
  rawOutput: string,
): string {
  const fixByHand = `Fix it on the server (in ${remotePath}), then run the upgrade again.`;

  switch (values.sync_error) {
    case "not-a-checkout":
      return `${remotePath} on the server is not a git checkout, so the upgrade cannot tell which version it would build. Reinstall from a clone of ${SOURCE_REPO_URL}.`;
    case "unexpected-remote":
      return `${remotePath} on the server tracks ${values.remote ?? "an unknown repository"}, not ${SOURCE_REPO_URL}. ${fixByHand}`;
    case "detached":
      return `${remotePath} on the server is not on a branch (detached HEAD), so there is nothing to fast-forward. ${fixByHand}`;
    case "dirty":
      return `${remotePath} on the server has uncommitted changes. The upgrade builds the dashboard from this checkout, so it will not update a tree with edits it cannot account for. ${fixByHand}`;
    case "not-default-branch":
      return `${remotePath} on the server is on ${values.branch ?? "another branch"}, not ${values.default_branch ?? "the default branch"}. Upgrades only fast-forward the default branch. ${fixByHand}`;
    case "diverged":
      return `${remotePath} on the server has commits that are not in ${SOURCE_REPO_URL}, so it cannot be fast-forwarded. ${fixByHand}`;
    default:
      return `could not update the server's copy of the source in ${remotePath}.\n\n${rawOutput.trim()}`;
  }
}

function shortRevision(revision: string): string {
  return revision.length >= 7 ? revision.slice(0, 7) : revision || "unknown";
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

const BACKUP_FLAGS = {
  ...COMMON_FLAGS,
  "--download": "boolean",
  "--yes": "boolean",
} as const satisfies FlagShape;

async function runBackup(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, BACKUP_FLAGS);
  const sshTarget = takeSingleTarget(parsed, "backup");
  const session = await openSession(deps, {
    label: "cmpatch selfhost backup",
    parsed,
    ...(sshTarget !== undefined ? { sshTarget } : {}),
  });

  try {
    // Before the warning, before the confirmation, before anything runs on the
    // server: an older checkout cannot take this backup at all, and the user
    // must not be asked to approve a pause that is going to fail.
    requireDirectoryCapableBackupScript(session);

    const interactive = canAsk(deps, parsed);

    if (interactive && !readBooleanFlag(parsed, "--yes")) {
      session.progress.settle();
      writeNotice(deps, renderBackupIntro(session.coverage));

      const confirmed = await (deps.confirm?.({
        initial: true,
        message: "Continue?",
      }) ?? Promise.resolve(true));
      if (!confirmed) {
        // Declined before anything ran remotely: the pause the user was
        // warned about never happens.
        throw new DeclinedError("Backup cancelled.");
      }
    }

    const directory = `${session.facts.backupRoot}/${backupDirectoryName(deps.now())}`;

    await runSelfhostScript(deps, session, {
      args: ["--directory", directory],
      env: { SELFHOST_BACKUP_ROOT: session.facts.backupRoot },
      milestones: BACKUP_MILESTONES,
      name: "backup",
      script: "backup.sh",
    });

    const lines = [
      `Backup saved on the server:`,
      `  ${directory}`,
    ];

    // --yes means "ask me nothing", so it takes the flags-only answer here too:
    // a download happens because --download said so, never because a run that
    // was told not to ask asked anyway.
    let download = readBooleanFlag(parsed, "--download");
    if (!download && interactive && !readBooleanFlag(parsed, "--yes")) {
      // The script's last milestone is still animating; a prompt over a live
      // spinner corrupts both.
      session.progress.settle();
      download =
        (await deps.confirm?.({
          initial: true,
          message: "Also download a copy to this machine?",
        })) ?? false;
    }

    if (download) {
      const localPath = await downloadBackup(deps, session, directory);
      lines.push("", "Downloaded to:", `  ${localPath}`);
    }

    lines.push(
      "",
      "Restore any time with: cmpatch selfhost restore",
    );
    session.progress.stop("Backup complete.");
    return lines.join("\n");
  } catch (error) {
    session.progress.fail("Backup failed.");
    throw error;
  }
}

/**
 * Refuses a backup the server's own scripts cannot take.
 *
 * `backup` names the exact output directory (`--directory`), and every
 * deployment installed before that flag existed has a `backup.sh` that reads
 * it as the positional backup root and dies inside `mkdir`. The alternative —
 * falling back to a bare positional run — would put the CLI back to guessing
 * which of the directories the script created is the one it just made, which
 * is the newest-directory guess this design exists to avoid. So the skew is
 * named instead, with both routes out of it — the upgrade, and the by-hand run
 * for the dirty or diverged checkout the upgrade itself refuses — and nothing
 * runs.
 *
 * Only a definite "no" refuses: a checkout whose `backup.sh` the probe could
 * not read, or that has none at all, reports null, and its own failure says
 * more than a version-skew message would.
 */
function requireDirectoryCapableBackupScript(session: SelfhostSession): void {
  if (session.facts.backupScriptSupportsDirectory !== false) {
    return;
  }

  throw new UsageError(
    [
      `The scripts on ${session.sshTarget} are older than this copy of cmpatch, so they cannot take this backup: ${session.remotePath}/scripts/selfhost/backup.sh does not understand the --directory option this command uses to name the backup's exact location.`,
      "",
      "Update the server first, then take the backup:",
      "  cmpatch selfhost upgrade",
      "  cmpatch selfhost backup",
      "",
      "The upgrade takes its own backup before it changes anything, so nothing is at risk.",
      "",
      `If the upgrade cannot run — it refuses a checkout with local changes — ssh to ${session.sshTarget} and run the old script by hand: ${session.remotePath}/scripts/selfhost/backup.sh ${session.facts.backupRoot}`,
    ].join("\n"),
  );
}

/** `2026-08-27T14-02-11` — sorts chronologically and needs no shell quoting. */
function backupDirectoryName(now: number): string {
  return new Date(now).toISOString().replace(/:/gu, "-").replace(/\..*$/u, "");
}

async function downloadBackup(
  deps: CommandDeps,
  session: SelfhostSession,
  remoteDirectory: string,
): Promise<string> {
  const host = session.sshTarget.slice(session.sshTarget.lastIndexOf("@") + 1);
  const localRoot = resolve(process.cwd(), "codemagic-patch-backups", host);
  const localPath = join(localRoot, remoteDirectory.slice(remoteDirectory.lastIndexOf("/") + 1));

  session.progress.write("downloading");
  // 0700 all the way down: a backup holds the deployment's env file, and that
  // holds every generated secret.
  await mkdir(localRoot, { mode: 0o700, recursive: true });

  const result = await deps.runProcess({
    args: assembleScpArgs(
      pairedSshInvocation(session.sshTarget, session.identityFile),
      [
        formatScpRemotePath(session.sshTarget, remoteDirectory),
        localPath,
      ],
    ),
    command: "scp",
    onOutput: (chunk) => session.progress.detail(chunk.trim()),
  });

  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `the backup was created on the server but could not be downloaded (scp exited with status ${String(
        result.exitCode ?? 1,
      )}). The server-side copy is intact at ${remoteDirectory}.`,
    );
  }

  // Reported only after a verified transfer: an empty directory reported as a
  // downloaded backup is worse than no download at all.
  try {
    await stat(join(localPath, "env.selfhost"));
  } catch {
    throw new RemoteScriptFailure(
      `the download finished but ${localPath} does not contain a backup. The server-side copy is intact at ${remoteDirectory}.`,
    );
  }

  return localPath;
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const RESTORE_FLAGS = {
  ...COMMON_FLAGS,
  "--restore-env": "boolean",
  // Accepted for parity with restore.sh (the plan says the script's flags pass
  // through), though it is also the default: an operator carrying flags over
  // from a direct restore.sh run must not hit an unknown-flag error.
  "--skip-smoke": "boolean",
  "--smoke": "boolean",
  "--yes": "boolean",
} as const satisfies FlagShape;

/** Mirrors the server's API_TOKEN_PREFIX; a PAT is the only credential --smoke can use. */
const API_TOKEN_PREFIX = "cm_pat_";

/** Cannot collide with a real path: a NUL never survives a filesystem. */
const LOCAL_BACKUP_CHOICE = "\0local";

async function runRestore(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, RESTORE_FLAGS);
  const { backup, sshTarget } = splitRestorePositionals(parsed);
  const interactive = canAsk(deps, parsed);

  // Checked before anything connects: a run that cannot possibly proceed must
  // not first pair with a host and probe it.
  if (!interactive && backup === undefined) {
    throw new UsageError(
      "Which backup? Pass its directory on the server: cmpatch selfhost restore <backup> --yes",
    );
  }

  if (!interactive && !readBooleanFlag(parsed, "--yes")) {
    throw new UsageError(
      "cmpatch selfhost restore replaces the server's data. Pass --yes to confirm in a non-interactive run.",
    );
  }

  if (
    readBooleanFlag(parsed, "--smoke") &&
    readBooleanFlag(parsed, "--skip-smoke")
  ) {
    throw new UsageError("--smoke and --skip-smoke are mutually exclusive.");
  }

  const session = await openSession(deps, {
    label: "cmpatch selfhost restore",
    parsed,
    ...(sshTarget !== undefined ? { sshTarget } : {}),
  });

  let staged: string | null = null;
  // The staged copy is removed on success, failure, AND interruption (the
  // plan's 1e promise): the finally below covers the first two, and this hook
  // covers Ctrl-C / SIGTERM during the upload or the remote run, where Node's
  // default handler would exit without unwinding the stack — leaving a full
  // backup, secrets included, in the server's /tmp. A cleanup hook rather
  // than a signal listener because the run animates a spinner for both, and
  // under one the press never becomes a signal.
  const removeInterruptHook = onInterruptCleanup(async () => {
    if (staged !== null) {
      await cleanUpStagedBackup(deps, session, staged);
    }
  });

  try {
    let selected = backup ?? null;

    // The picker titles and `backup`'s own summary surface bare directory
    // names, and restore.sh resolves a relative path against its cwd (the
    // checkout) — so a name is anchored to the root the backups actually
    // live under.
    if (selected !== null && !selected.startsWith("/")) {
      selected = `${session.facts.backupRoot}/${selected}`;
    }
    let selectedBackup: RemoteBackup | null = null;

    if (selected === null) {
      const backups = await listRemoteBackups({
        backupRoot: session.facts.backupRoot,
        identityFile: session.identityFile,
        runProcess: deps.runProcess,
        sshTarget: session.sshTarget,
      });

      session.progress.settle();
      const choice = await promptBackupChoice(deps, backups);
      if (choice === LOCAL_BACKUP_CHOICE) {
        selected = await stageLocalBackup(deps, session, (path) => {
          staged = path;
        });
      } else {
        selected = choice;
        selectedBackup = backups.find((entry) => entry.path === choice) ?? null;
      }
    }

    const guided = interactive && !readBooleanFlag(parsed, "--yes");
    let restoreEnv = readBooleanFlag(parsed, "--restore-env");

    if (guided) {
      session.progress.settle();
      writeNotice(
        deps,
        renderRestoreConsequence({
          coverage: session.coverage,
          createdAt: selectedBackup?.createdAt ?? null,
        }),
      );

      // The settings question runs *before* the typed gate, never after it:
      // the gate is the strongest confirmation this command family has, and a
      // yes taken afterwards would replace this server's domains and keys with
      // the backup's without anything left to approve that. The flag form
      // answers it already, so it is only asked when it is still open.
      if (!restoreEnv) {
        restoreEnv =
          (await deps.confirm?.({
            initial: false,
            message:
              "Also restore the settings file? Usually no — this keeps your current domains and keys.",
          })) ?? false;
      }
    }

    // A restore with nothing left in its scope is refused rather than run — and
    // refused *before* the typed gate, which exists to approve a destructive
    // change and must never be asked for a no-op. On a fully external
    // deployment the backup holds only the settings file, so without
    // --restore-env `restore.sh` puts nothing back, yet it would still stop the
    // stack, take a safety backup, and let the CLI report "your data is
    // restored". The settings answer is the only thing that can fill the scope,
    // so this sits directly after it and covers the flags-only path too. It is
    // a usage problem because the remedy is a flag or the provider's own
    // tooling, like this command's other refusals.
    if (describeRestoredComponents(session.coverage, restoreEnv).length === 0) {
      throw new UsageError(renderRestoreNoOp(session.coverage));
    }

    if (guided) {
      // The gate states the scope it is approving.
      writeNotice(deps, renderRestoreScope(restoreEnv));
      await confirmTypedRestore(deps);
    }

    const args = ["-y", selected];
    if (restoreEnv) {
      args.push("--restore-env");
    }

    // The publish smoke is skipped by default, and no token is refreshed.
    // `restore.sh` documents a PAT; what the CLI holds is an OAuth access
    // token whose row lives in the very database this restore replaces, so it
    // cannot survive the restore AND still be inside its 900-second TTL when
    // the smoke runs. `--smoke` is the opt-in for the one credential that can
    // work: a PAT that already existed when the backup was taken.
    const smoke = readBooleanFlag(parsed, "--smoke");
    // The operator's own PAT, from the environment, travelling as an env
    // assignment on stdin like every other secret. Without it `smoke.sh`
    // silently degrades to unauthenticated checks and tells the user to sign in
    // and rerun, which would make --smoke claim a publish check it never ran.
    const smokeToken = smoke ? readSmokeToken(deps) : undefined;
    if (!smoke) {
      args.push("--skip-smoke");
    } else {
      // Printed on every --smoke run, interactive or not. This is information,
      // not a prompt, and the run that needs it most is the scripted one: when
      // the smoke fails, restore.sh prints its own rollback command for a
      // restore that has in fact completed, and this line is the only thing
      // standing between the operator and undoing good data. On the --yes
      // path nothing has settled the survey spinner yet, and its redraw would
      // erase exactly this line.
      session.progress.settle();
      writeNotice(
        deps,
        "the publish check only works with a token that already existed when this backup was taken. If it fails, the restore itself may still have completed: open the dashboard before running any rollback command.",
      );
    }

    await runSelfhostScript(deps, session, {
      args,
      env: {
        SELFHOST_BACKUP_ROOT: session.facts.backupRoot,
        ...(smokeToken !== undefined
          ? { CODEMAGIC_PATCH_TOKEN: smokeToken }
          : {}),
      },
      milestones: RESTORE_MILESTONES,
      name: "restore",
      script: "restore.sh",
    });

    const anchor = selectedBackup?.createdAt ?? null;
    const lines = [
      session.serverUrl === null
        ? "Restore complete."
        : `Restore complete — ${session.serverUrl}${
            anchor === null ? "" : ` is now at the state of ${anchor}`
          }.`,
    ];

    if (!smoke) {
      // Named as a deferred step rather than shown as a green check the CLI
      // could not earn.
      lines.push(
        "",
        "Your data is restored. Sign in again with `cmpatch login`, then publish a release to confirm end to end.",
      );
    }

    session.progress.stop("Restore complete.");
    return lines.join("\n");
  } catch (error) {
    session.progress.fail("Restore failed.");
    throw error;
  } finally {
    removeInterruptHook();
    if (staged !== null) {
      await cleanUpStagedBackup(deps, session, staged);
    }
  }
}

/**
 * `--smoke` needs a credential the CLI cannot mint.
 *
 * The one credential that can authenticate a post-restore publish check is a
 * personal access token that already existed when the backup was taken, so it
 * survives the restore as a row in the restored database. The CLI cannot prove
 * that (api_token rows are in that same database and the stored value carries
 * no creation time), which is why the flag warns about the condition instead of
 * checking it. What it can do is refuse the two cases that are certainly wrong:
 * no token at all, and a token that is not a PAT.
 */
function readSmokeToken(deps: CommandDeps): string {
  const token = deps.env.CODEMAGIC_PATCH_TOKEN?.trim();

  if (token === undefined || token.length === 0) {
    throw new UsageError(
      [
        "--smoke needs a personal access token that already existed when this backup was taken.",
        "",
        "Supply it as CODEMAGIC_PATCH_TOKEN:",
        "  CODEMAGIC_PATCH_TOKEN=cm_pat_... cmpatch selfhost restore --smoke",
        "",
        "A token created after the backup cannot work: the restore replaces the database its row lives in. Without --smoke the restore still completes, and the publish check becomes a next step.",
      ].join("\n"),
    );
  }

  if (!token.startsWith(API_TOKEN_PREFIX)) {
    throw new UsageError(
      `CODEMAGIC_PATCH_TOKEN does not look like a personal access token (it should start with ${API_TOKEN_PREFIX}). A browser sign-in token cannot authenticate a post-restore check: its row lives in the database the restore replaces.`,
    );
  }

  return token;
}

function splitRestorePositionals(parsed: ParsedArgs): {
  backup?: string;
  sshTarget?: string;
} {
  const positionals = parsed.positionals;
  if (positionals.length > 2) {
    throw new UsageError(
      "Usage: cmpatch selfhost restore [backup] [user@vps]",
    );
  }

  const targets = positionals.filter((value) => looksLikeSshTarget(value));
  const others = positionals.filter((value) => !looksLikeSshTarget(value));

  if (targets.length > 1) {
    throw new UsageError("Only one server address may be given");
  }

  if (positionals.length === 2 && targets.length === 0) {
    throw new UsageError(
      "The server address must include the login user, as in ubuntu@203.0.113.7, so it can be told apart from the backup directory",
    );
  }

  return {
    ...(others[0] !== undefined ? { backup: others[0] } : {}),
    ...(targets[0] !== undefined ? { sshTarget: targets[0] } : {}),
  };
}

async function promptBackupChoice(
  deps: CommandDeps,
  backups: readonly RemoteBackup[],
): Promise<string> {
  if (deps.prompt === undefined) {
    throw new UsageError(
      "Which backup? Pass its directory on the server: cmpatch selfhost restore <backup>",
    );
  }

  const choices = backups.map((backup) => ({
    title: `${backup.name}  (${formatSize(backup.sizeBytes)}, ${describeBackupOrigin(backup)})`,
    value: backup.path,
  }));
  choices.push({
    title: "a backup folder on this machine…",
    value: LOCAL_BACKUP_CHOICE,
  });

  const answer = await deps.prompt({
    choices,
    message: "Which backup do you want to restore?",
    type: "select",
  });

  return typeof answer === "string" ? answer : (answer[0] ?? "");
}

/**
 * Which family a listed backup belongs to. The scripts' safety backups share
 * one naming scheme and land in subdirectories of the same root, so without
 * this a pre-upgrade and a pre-restore backup taken the same second would be
 * indistinguishable in the picker.
 */
function describeBackupOrigin(backup: RemoteBackup): string {
  switch (backup.category) {
    case null:
      return "on the server";
    case "pre-upgrade":
      return "safety backup taken before an upgrade";
    case "pre-restore":
      return "safety backup taken before a restore";
    default:
      return `in ${backup.category}/ on the server`;
  }
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) {
    return "size unknown";
  }

  const megabytes = sizeBytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

/**
 * Copies a local backup folder to a remote `mktemp -d` so `restore.sh` — which
 * only ever reads a directory on its own host — can use it. Removed again on
 * success, failure, and interruption alike: `onStaged` hands the path to the
 * caller the moment the remote directory exists — before the upload, which is
 * exactly the long phase an interruption is most likely to land in — and the
 * caller's finally / interrupt hook own the cleanup from then on.
 */
async function stageLocalBackup(
  deps: CommandDeps,
  session: SelfhostSession,
  onStaged: (path: string) => void,
): Promise<string> {
  if (deps.prompt === undefined) {
    throw new UsageError("Pass the backup folder as an argument");
  }

  const answer = await deps.prompt({
    message: "Path to the backup folder on this machine",
    type: "text",
  });
  const localPath = resolve(
    process.cwd(),
    typeof answer === "string" ? answer : (answer[0] ?? ""),
  );

  // Validated before anything is uploaded: a folder that is not a backup would
  // otherwise be rejected by restore.sh minutes later, after a slow transfer.
  try {
    await stat(join(localPath, "env.selfhost"));
  } catch {
    throw new UsageError(
      `${localPath} does not look like a ${PRODUCT_NAME} backup (it has no env.selfhost).`,
    );
  }

  const entries = await readdir(localPath);
  if (entries.length === 0) {
    throw new UsageError(`${localPath} is empty.`);
  }

  session.progress.write("uploading the backup to the server");
  const staging = await captureRemoteShell({
    body: 'mktemp -d "${TMPDIR:-/tmp}/cmpatch-restore.XXXXXX"',
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });

  const stagingRoot = staging.output.trim().split("\n").pop()?.trim() ?? "";
  if (staging.exitCode !== 0 || !isAbsolute(stagingRoot)) {
    throw new RemoteScriptFailure(
      `could not create a staging directory on ${session.sshTarget}.`,
    );
  }

  const remotePath = `${stagingRoot}/backup`;
  onStaged(remotePath);

  const result = await deps.runProcess({
    args: assembleScpArgs(
      pairedSshInvocation(session.sshTarget, session.identityFile),
      [localPath, formatScpRemotePath(session.sshTarget, remotePath)],
    ),
    command: "scp",
    onOutput: (chunk) => session.progress.detail(chunk.trim()),
  });

  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `could not upload ${localPath} to ${session.sshTarget} (scp exited with status ${String(
        result.exitCode ?? 1,
      )}).`,
    );
  }

  return remotePath;
}

async function cleanUpStagedBackup(
  deps: CommandDeps,
  session: SelfhostSession,
  stagedPath: string,
): Promise<void> {
  try {
    await captureRemoteShell({
      // The parent is the mktemp -d directory this CLI created; nothing else
      // ever lives there, and the guard keeps a malformed path from widening
      // the delete.
      body: [
        'case "$CMPATCH_STAGED" in',
        "  */cmpatch-restore.*/backup) rm -rf \"$CMPATCH_STAGED\" \"${CMPATCH_STAGED%/backup}\" ;;",
        "esac",
      ].join("\n"),
      connection: pairedSshInvocation(session.sshTarget, session.identityFile),
      env: { CMPATCH_STAGED: stagedPath },
      runProcess: deps.runProcess,
    });
  } catch {
    // Best effort: a leftover temp directory is not worth failing a completed
    // restore over, and the message would land after the outcome anyway.
  }
}

async function confirmTypedRestore(deps: CommandDeps): Promise<void> {
  if (deps.prompt === undefined) {
    throw new UsageError(
      "cmpatch selfhost restore replaces the server's data. Pass --yes to confirm.",
    );
  }

  const answer = await deps.prompt({
    message: 'Type "restore" to continue',
    type: "text",
  });
  const typed = (typeof answer === "string" ? answer : (answer[0] ?? "")).trim();

  // One level stronger than [y/N], as the family's only destructive command.
  if (typed.toLowerCase() !== "restore") {
    throw new DeclinedError("Restore cancelled.");
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}
