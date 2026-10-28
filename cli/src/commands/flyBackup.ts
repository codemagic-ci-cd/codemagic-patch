/**
 * `cmpatch selfhost backup` and `restore` on a Fly install. Postgres runs
 * inside the database machine as `-U postgres`, so no secret is read (D5);
 * see wiki/discussions/fly-setup-wizard.md, "Backup flow" and "Restore flow".
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  autostopArgs,
  compareServerTags,
  describeRestorePhase,
  DROP_CREATE_SQL,
  FLY_BACKUP_DUMP,
  FLY_BACKUP_FORMAT,
  FLY_BACKUP_MANIFEST,
  MIGRATION_COUNT_SQL,
  parseBackupManifest,
  parseFlyMachines,
  parseMigrationCount,
  parsePostgresVersion,
  parseRemoteSha256,
  pgDumpCommand,
  pgRestoreCommand,
  POSTGRES_VERSION_SQL,
  renderBackupManifest,
  renderRestoreRecordMd,
  renderStepsPlain,
  restoreRecipes,
  snapshotExpiry,
  type FlyBackupManifest,
  type RestoreRecordInput,
} from "../flySetup";
import { onInterruptCleanup } from "../progress";
import { quoteShellValue } from "../remoteExec";
import {
  describeBackupCoverage,
  renderBackupExclusions,
  renderFlyRestoreConsequence,
} from "../selfhostCopy";
import { utcStamp } from "../selfhostRemote";
import type { SelfhostFlyTarget } from "../selfhostTarget";
import {
  checkReleaseConfig,
  consoleArgs,
  exists,
  flyPreflight,
  listSnapshots,
  openFlyCommand,
  pinDatabaseMachine,
  POLL_CALL_TIMEOUT_MS,
  refuseSnapshotInProgress,
  saveReleaseConfig,
  setAutostop,
  takeSnapshot,
} from "./flyMaintenance";
import {
  errorMessage,
  firstLine,
  flyServerUrl,
  FlyInterrupted,
  lastLines,
  pollUntil,
  run,
  waitUntilReady,
  type FlyContext,
} from "./flyProcess";
import { askSelect, notice } from "./selfhostInstall/ask";
import {
  canAsk,
  confirmTypedRestore,
  readBooleanFlag,
  type ParsedArgs,
} from "./selfhostSession";
import { UsageError, type CommandDeps } from "./shared";

/** `pg_dump` / `pg_restore` of a few hundred MB, and the sftp transfers, take minutes; past these a call is treated as stalled. */
const DUMP_TIMEOUT_MS = 60 * 60_000;
const TRANSFER_TIMEOUT_MS = 60 * 60_000;
/** A checksum, a version query, a scale: seconds when the connection is healthy. */
const SHORT_CONSOLE_TIMEOUT_MS = 2 * 60_000;

/** A file this run put in the database machine's `/tmp`, removed again however the run ends. */
type RemoteFile = { app: string; machineId: string; path: string };

/** Best effort: a leftover dump in `/tmp` is not worth failing over, and the machine's rootfs does not keep it forever. */
async function removeRemote(fly: FlyContext, file: RemoteFile): Promise<void> {
  try {
    await run(fly, "fly", consoleArgs(file, `rm -f ${file.path}`), { timeoutMs: 60_000 });
  } catch {
    // Deliberately swallowed; see above.
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function formatSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(megabytes))} MB`;
}

/** The exclusions an ssh backup prints, for what a Fly backup leaves out: always the buckets, and an external database. */
function exclusionNotice(external: boolean): string[] {
  return renderBackupExclusions(describeBackupCoverage({
    databaseMode: external ? "external" : "bundled",
    storageMode: "s3",
  }));
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

const BACKUP = "cmpatch selfhost backup";

/** The ssh backup's flags that mean nothing on Fly, each with why. */
const SSH_ONLY_BACKUP_FLAGS: Readonly<Record<string, string>> = {
  "--download": "--download does not apply to a Fly install: the backup is always saved on this machine.",
  "--ssh-key": "--ssh-key does not apply to a Fly install: the backup reaches Fly through flyctl, not ssh.",
};

/**
 * `cmpatch selfhost backup` for a Fly mapping (D4). A failure or Ctrl-C
 * removes the staging directory and the dump in the machine's `/tmp`.
 */
export async function runFlyBackup(
  deps: CommandDeps,
  parsed: ParsedArgs,
  target: SelfhostFlyTarget,
): Promise<string> {
  const { fly, localRoot } = openFlyCommand(deps, parsed, { label: BACKUP, sshOnlyFlags: SSH_ONLY_BACKUP_FLAGS, target });
  const app = target.app;

  let staging: string | undefined;
  let remote: RemoteFile | undefined;
  const cleanUp = async () => {
    const [directory, file] = [staging, remote];
    staging = undefined;
    remote = undefined;
    if (directory !== undefined) {
      await rm(directory, { force: true, recursive: true });
    }
    if (file !== undefined) {
      await removeRemote(fly, file);
    }
  };
  const removeInterruptHook = onInterruptCleanup(cleanUp);

  try {
    const preflight = await flyPreflight(fly, target, { localRoot });
    const stamp = utcStamp(deps.now());
    const name = `${app}-${stamp}`;
    const directory = join(localRoot, name);
    const external = preflight.database.kind === "external";

    fly.progress.settle();
    notice(deps, exclusionNotice(external));
    if (preflight.marker === null) {
      notice(deps, `${app} has no recorded server tag, so restore will refuse this backup, now and after the tag is recorded. Run cmpatch selfhost upgrade --redeploy once to record it, then take a new backup.`);
    }

    await mkdir(localRoot, { mode: 0o700, recursive: true });
    staging = join(localRoot, `.${name}.partial`);
    await mkdir(staging, { mode: 0o700 });

    let createdAt = new Date(deps.now()).toISOString();
    let dump: { postgresVersion: string; sha256: string; sizeBytes: number } | null = null;
    if (preflight.database.kind === "managed") {
      const db = preflight.database;
      const file: RemoteFile = { app: db.app, machineId: db.machineId, path: `/tmp/cmpatch-backup-${stamp}.dump` };
      remote = file;

      fly.progress.write(`Dumping the database on ${db.machineId}`);
      createdAt = new Date(deps.now()).toISOString();
      const dumped = await run(fly, "fly", consoleArgs(file, pgDumpCommand(file.path)), { timeoutMs: DUMP_TIMEOUT_MS });
      const remoteSha = parseRemoteSha256(dumped, file.path);
      if (remoteSha === null) {
        throw new UsageError(`pg_dump on ${db.machineId} in ${db.app} printed no checksum for ${file.path}.\n${lastLines(dumped, 5)}`);
      }
      const postgresVersion = parsePostgresVersion(await run(fly, "fly", consoleArgs(file, POSTGRES_VERSION_SQL), { timeoutMs: SHORT_CONSOLE_TIMEOUT_MS }));
      if (postgresVersion === null) {
        throw new UsageError(`Could not read the Postgres version on ${db.machineId} in ${db.app}.`);
      }

      fly.progress.write("Downloading the dump");
      const local = join(staging, FLY_BACKUP_DUMP);
      // `sftp get` refuses a local path that already exists.
      await run(fly, "fly", ["ssh", "sftp", "get", file.path, local, "--app", db.app, "--machine", db.machineId], { timeoutMs: TRANSFER_TIMEOUT_MS });
      const localSha = await sha256File(local);
      if (localSha !== remoteSha) {
        throw new UsageError(`The downloaded dump does not match the one on ${db.machineId} (sha256 ${localSha}, expected ${remoteSha}). Nothing was saved; run ${BACKUP} again.`);
      }
      dump = { postgresVersion, sha256: localSha, sizeBytes: (await stat(local)).size };
    }

    await saveReleaseConfig(fly, app, join(staging, "fly.toml"));

    const manifest: FlyBackupManifest = {
      app,
      coverage: dump === null ? "config-only" : "database",
      createdAt,
      databaseApp: preflight.database.kind === "managed" ? preflight.database.app : null,
      flyctlVersion: preflight.flyctlVersion,
      org: target.org,
      postgresVersion: dump?.postgresVersion ?? null,
      region: target.region,
      schemaMigrations: preflight.database.kind === "managed" ? preflight.database.migrationCount : null,
      serverImage: preflight.liveImage,
      serverTag: preflight.marker,
      sha256: dump?.sha256 ?? null,
    };
    await writeFile(join(staging, FLY_BACKUP_MANIFEST), renderBackupManifest(manifest), { mode: 0o600 });
    await rename(staging, directory);
    staging = undefined;

    const file = remote;
    remote = undefined;
    if (file !== undefined) {
      await removeRemote(fly, file);
    }

    fly.progress.stop("Backup complete.");
    return [
      `Backup of ${app} saved on this machine (${FLY_BACKUP_FORMAT}, ${manifest.coverage}):`,
      `  ${directory}`,
      dump === null
        ? "  Database: external, not included"
        : `  Database: ${manifest.databaseApp} (${formatSize(dump.sizeBytes)}, ${manifest.schemaMigrations} migrations, Postgres ${dump.postgresVersion})`,
      `  Server: ${preflight.marker ?? "no recorded tag"} (${preflight.liveImage})`,
      "",
      `Restore it with: cmpatch selfhost restore ${name}`,
      `Dashboard: ${flyServerUrl(app)}`,
    ].join("\n");
  } catch (error) {
    fly.progress.fail("Backup failed.");
    await cleanUp();
    throw error;
  } finally {
    removeInterruptHook();
  }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const RESTORE = "cmpatch selfhost restore";

/** The ssh restore's flags that mean nothing on Fly, each with why. */
const SSH_ONLY_RESTORE_FLAGS: Readonly<Record<string, string>> = {
  "--restore-env": "--restore-env does not apply to a Fly install: a Fly backup holds no settings or secrets, so the app keeps its own.",
  "--skip-smoke": "--skip-smoke does not apply to a Fly install: the restore only waits for /health/ready and runs no publish check to skip.",
  "--smoke": "--smoke does not apply to a Fly install: the restore only waits for /health/ready and runs no publish check.",
  "--ssh-key": "--ssh-key does not apply to a Fly install: the restore reaches Fly through flyctl, not ssh.",
};

/** Cannot collide with a real path: a NUL never survives a filesystem. */
const ELSEWHERE_CHOICE = "\0elsewhere";
/** Past this a `pg_restore`'s outcome is recorded as unknown. */
const PG_RESTORE_TIMEOUT_MS = DUMP_TIMEOUT_MS;
const DROP_TIMEOUT_MS = 5 * 60_000;
const VALIDATION_TIMEOUT_MS = 5 * 60_000;
/** `fly deploy --image` of an image Fly already has: minutes at most. */
const RELEASE_TIMEOUT_MS = 30 * 60_000;
const HOLD_WAIT_MS = 60_000;

type ChosenBackup = { directory: string; manifest: FlyBackupManifest };

/**
 * `cmpatch selfhost restore` for a Fly mapping (D4, D5, D10, D11). A stop
 * after the hold leaves Patch held and prints the record's recipes; the CLI
 * never continues or undoes a restore by itself.
 */
export async function runFlyRestore(
  deps: CommandDeps,
  parsed: ParsedArgs,
  target: SelfhostFlyTarget,
  backupArgument: string | undefined,
): Promise<string> {
  // Ctrl-C sets this before anything else happens, and from then on the
  // flow's next process, fetch, sleep or checkpoint throws: a call already in
  // flight (pg_restore, say) may still finish while the interrupt hook writes
  // the record, but nothing after it runs.
  let interrupted = false;
  const checkpoint = () => {
    if (interrupted) {
      throw new FlyInterrupted();
    }
  };
  /** The flow's process in flight, which the interrupt's cleanup ends and lets settle before it removes the dump. */
  let inFlight: Promise<unknown> | null = null;
  // Aborts the flow's processes. Under the spinner Ctrl-C never reaches
  // flyctl, so an upload left alone would run until its 60-minute timeout.
  const cancel = new AbortController();
  const guardedDeps: CommandDeps = {
    ...deps,
    fetch: async (...args) => {
      checkpoint();
      const response = await deps.fetch(...args);
      checkpoint();
      return response;
    },
    runProcess: async (options) => {
      checkpoint();
      const call = deps.runProcess({ ...options, signal: cancel.signal });
      inFlight = call;
      try {
        await call;
      } finally {
        if (inFlight === call) {
          inFlight = null;
        }
      }
      checkpoint();
      return call;
    },
    sleep: async (milliseconds) => {
      checkpoint();
      await deps.sleep(milliseconds);
      checkpoint();
    },
  };
  const { fly, localRoot } = openFlyCommand(deps, parsed, {
    label: RESTORE,
    processDeps: guardedDeps,
    sshOnlyFlags: SSH_ONLY_RESTORE_FLAGS,
    target,
  });
  const interactive = canAsk(deps, parsed);
  const yes = readBooleanFlag(parsed, "--yes");
  if (!interactive && backupArgument === undefined) {
    throw new UsageError("Which backup? Pass its directory on this machine: cmpatch selfhost restore <backup> --yes");
  }
  if (!interactive && !yes) {
    throw new UsageError("cmpatch selfhost restore replaces the server's data. Pass --yes to confirm in a non-interactive run.");
  }
  const app = target.app;
  /**
   * The cleanup's own flyctl: the same resolved binaries (`flyctl`, or
   * `~/.fly/bin/fly`) as the flow's, without the cancellation guard.
   */
  const cleanupFly: FlyContext = { commands: fly.commands, deps, progress: fly.progress, rerun: RESTORE };

  const stamp = utcStamp(deps.now());
  const recordPath = join(localRoot, `${app}-restore-${stamp}.md`);
  const flyToml = join(localRoot, `${app}-restore-${stamp}.fly.toml`);
  let remote: RemoteFile | undefined;
  /** The record as last committed; changed only inside the write queue. */
  let record: RestoreRecordInput | undefined;
  let flyTomlSaved = false;

  // Every change to the record is one queued read-modify-write: the next
  // state is built from the committed one inside the queue, so the interrupt
  // hook's write and the flow's cannot interleave or undo each other. Each
  // write goes to a temporary file and is renamed, so a failed write never
  // leaves a truncated record.
  let queue: Promise<void> = Promise.resolve();
  const update = (
    change: (current: RestoreRecordInput | undefined) => RestoreRecordInput | undefined,
    options: { keepOnFailure?: boolean } = {},
  ): Promise<void> => {
    const write = queue.then(async () => {
      const next = change(record);
      if (next === undefined) {
        return;
      }
      if (options.keepOnFailure === true) {
        record = next;
      }
      const temporary = `${recordPath}.tmp`;
      await writeFile(temporary, renderRestoreRecordMd(next), { mode: 0o600 });
      await rename(temporary, recordPath);
      record = next;
    });
    queue = write.catch(() => {});
    return write;
  };
  type StepPatch = Partial<Pick<RestoreRecordInput, "keepAwake" | "mismatch" | "phase" | "snapshot">>;
  /**
   * Appends a step to the committed record. Kept in memory only once it is on
   * disk, so the record and the terminal never claim a step whose write
   * failed. Facts (`keepOnFailure`: the snapshot id, a count mismatch) are
   * kept in memory either way, since the guidance depends on them.
   */
  const step = (text: string | ((current: RestoreRecordInput) => string), patch: StepPatch = {}, options: { keepOnFailure?: boolean } = {}) =>
    update((current) => current === undefined
      ? undefined
      : {
          ...current,
          ...patch,
          steps: [...current.steps, { at: new Date(deps.now()).toISOString(), text: typeof text === "string" ? text : text(current) }],
        }, options);
  /** What a failed write leaves out, said with the step it was recording. */
  const writeFailure = (text: string, error: unknown) =>
    `Could not update ${recordPath} after this step: "${text}" (${firstLineOf(error)}); the record still says ${record?.phase ?? "nothing"}.`;
  /** The flow's step: nothing runs after it once interrupted, and a write that fails stops the restore. */
  const advance = async (text: string, patch: StepPatch = {}) => {
    checkpoint();
    try {
      await step(text, patch);
    } catch (error) {
      throw new UsageError(writeFailure(text, error));
    }
    checkpoint();
  };
  /** A step that must not hide the guidance: its write failure becomes one more line. */
  const tryStep = async (text: string | ((current: RestoreRecordInput) => string), patch: StepPatch = {}, options: { keepOnFailure?: boolean } = {}): Promise<string | null> => {
    try {
      await step(text, patch, options);
      return null;
    } catch (error) {
      return writeFailure(typeof text === "string" ? text : "Interrupted (Ctrl-C)", error);
    }
  };
  /**
   * The database machine's autostop back on once nothing needs it awake. Best
   * effort, since by then the restore is over or nothing on Patch changed: a
   * failure is noted in the record and said, with the command, as the lines
   * returned here.
   */
  const letSleep = async (context: FlyContext): Promise<string[]> => {
    const current = record;
    if (current === undefined || current.keepAwake === null || current.keepAwake.restored) {
      return [];
    }
    const db = current.database;
    const awake = current.keepAwake;
    const verb = awake.previous === "suspend" ? "suspends" : "stops";
    try {
      await setAutostop(context, db.app, db.machineId, awake.previous);
    } catch (error) {
      const failure = await tryStep(`Autostop still off: ${firstLineOf(error)}`);
      return [
        `${db.machineId} in ${db.app} still has autostop off, so it never ${verb} when idle. Turn it back on with: fly ${autostopArgs(db.machineId, db.app, awake.previous).join(" ")}`,
        ...(failure === null ? [] : [failure]),
      ];
    }
    const failure = await tryStep(`Autostop back on: ${db.machineId} ${verb} again when idle.`, { keepAwake: { ...awake, restored: true } }, { keepOnFailure: true });
    return failure === null ? [] : [failure];
  };
  /** Before the hold nothing on Patch changed: remove what this run put in place. */
  const discard = async (): Promise<string[]> => {
    // An upload still running would recreate the dump after the rm: end it
    // (SIGKILL after a grace period, so the wait is bounded), then wait.
    cancel.abort();
    await inFlight?.catch(() => {});
    const file = remote;
    remote = undefined;
    if (file !== undefined) {
      await removeRemote(cleanupFly, file);
    }
    const notes = await letSleep(cleanupFly);
    if (flyTomlSaved) {
      flyTomlSaved = false;
      await rm(flyToml, { force: true });
    }
    return notes;
  };
  const removeInterruptHook = onInterruptCleanup(async () => {
    interrupted = true;
    if (record === undefined || record.phase === "staged") {
      await tryStep("Interrupted (Ctrl-C) before the hold; nothing on Patch was changed.");
      const notes = await discard();
      if (notes.length > 0) {
        deps.stderr?.write(`${notes.join("\n")}\n`);
      }
      return;
    }
    const failure = await tryStep((current) => `Interrupted (Ctrl-C) at ${current.phase}.`);
    const committed = record;
    deps.stderr?.write(`${[...stoppedGuidance(committed, recordPath), ...(failure === null ? [] : ["", failure])].join("\n")}\n`);
  });

  try {
    const chosen = await chooseBackup(deps, localRoot, backupArgument);
    checkpoint();
    const { manifest } = chosen;
    const dump = join(chosen.directory, FLY_BACKUP_DUMP);
    checkManifest(chosen, target);
    fly.progress.write("Checking the dump's checksum");
    const sha = await sha256File(dump).catch(() => null);
    checkpoint();
    if (sha === null) {
      throw new UsageError(`${chosen.directory} has no ${FLY_BACKUP_DUMP}. Nothing was changed.`);
    }
    if (sha !== manifest.sha256) {
      throw new UsageError(`${dump} does not match its manifest (sha256 ${sha}, expected ${manifest.sha256}). The backup is damaged; nothing was changed.`);
    }

    const preflight = await flyPreflight(fly, target, { localRoot });
    // checkManifest refused a mapping without a database app, so the preflight read a managed one.
    assert(preflight.database.kind === "managed");
    const db = preflight.database;
    const liveTag = checkDirection(app, manifest, preflight.marker);
    refuseSnapshotInProgress(fly, await listSnapshots(fly, db.app, db.volumeId, "Nothing was changed."), db.app, db.volumeId);

    await mkdir(localRoot, { mode: 0o700, recursive: true });
    flyTomlSaved = true;
    await saveReleaseConfig(fly, app, flyToml);
    await checkReleaseConfig(fly, app, flyToml, preflight.liveGuest);

    if (interactive && !yes) {
      fly.progress.settle();
      notice(deps, renderFlyRestoreConsequence({ app, createdAt: manifest.createdAt, liveTag }));
      await confirmTypedRestore(deps);
      checkpoint();
    }

    const pinned = await pinDatabaseMachine(fly, db.app, db.machineId);
    const file: RemoteFile = { app: db.app, machineId: db.machineId, path: `/tmp/cmpatch-restore-${stamp}.dump` };

    // Step 2: the record, before the dump or the keep-awake touches the
    // database machine. Its first write failing stops the restore there.
    const initial: RestoreRecordInput = {
      app,
      backup: {
        createdAt: manifest.createdAt,
        directory: chosen.directory,
        dump,
        migrationCount: manifest.schemaMigrations ?? 0,
        serverTag: manifest.serverTag ?? "",
        sha256: manifest.sha256 ?? "",
      },
      database: {
        app: db.app,
        machineId: db.machineId,
        migrationCount: db.migrationCount,
        sizeGb: db.sizeGb,
        volumeId: db.volumeId,
      },
      flyToml,
      keepAwake: null,
      liveImage: preflight.liveImage,
      liveTag,
      mismatch: null,
      phase: "staged",
      region: target.region,
      remoteDump: file.path,
      snapshot: null,
      startedAt: new Date(deps.now()).toISOString(),
      steps: [{ at: new Date(deps.now()).toISOString(), text: `Started: the dump goes to ${db.machineId}:${file.path}.` }],
    };
    await update(() => initial);
    checkpoint();

    // Step 2b: keep the database machine awake, before the upload. The proxy
    // suspends an idle machine within about a minute, whatever an ssh session
    // inside it is doing: live, pg_restore hung inside a suspended machine
    // until the machine was started by hand. The hold ends every proxy
    // connection to it, and an idle install's suspended Patch has none even
    // before. Recorded before it is sent, so a stop here still turns it back on.
    const previous = pinned.autostop;
    if (previous === "stop" || previous === "suspend") {
      fly.progress.write(`Keeping ${db.machineId} awake for the restore`);
      await advance(`Keep-awake sent: fly ${autostopArgs(db.machineId, db.app, "off").join(" ")}.`, { keepAwake: { previous, restored: false } });
      await setAutostop(fly, db.app, db.machineId, "off");
      await advance(`Kept awake: ${db.machineId} no longer ${previous === "suspend" ? "suspends" : "stops"} when idle, until the restore is over.`);
    }

    // Step 3: the upload, while Patch still runs.
    remote = file;
    fly.progress.write(`Uploading the dump to ${db.machineId}`);
    // `fly ssh sftp put <local> <remote> --app <db> --machine <id>` uploads one file and refuses an existing remote path (flyctl source).
    await run(fly, "fly", ["ssh", "sftp", "put", dump, file.path, "--app", db.app, "--machine", db.machineId], { timeoutMs: TRANSFER_TIMEOUT_MS });
    const uploaded = parseRemoteSha256(await run(fly, "fly", consoleArgs(file, `sha256sum ${file.path}`), { timeoutMs: SHORT_CONSOLE_TIMEOUT_MS }), file.path);
    if (uploaded !== manifest.sha256) {
      throw new UsageError(`The uploaded dump on ${db.machineId} does not match the backup (sha256 ${uploaded ?? "unreadable"}, expected ${manifest.sha256}).`);
    }
    await advance(`Dump uploaded to ${db.machineId}:${file.path} and checked.`);

    // Step 4: hold.
    fly.progress.write(`Holding ${app} (no machines while the database is replaced)`);
    await advance(`Hold sent: fly scale count 0 --app ${app}.`, { phase: "hold-sent" });
    // `fly scale count 0 --app <app> --yes` destroys every machine without asking (flyctl source).
    await run(fly, "fly", ["scale", "count", "0", "--app", app, "--yes"], { timeoutMs: SHORT_CONSOLE_TIMEOUT_MS });
    await waitForNoMachines(fly, app);
    await advance(`Patch held: fly machine list --app ${app} is empty.`, { phase: "held" });

    // Step 5: the safety snapshot.
    const snapshot = await takeSnapshot(fly, db.app, db.volumeId, {
      operation: "this restore",
      unchanged: "The database is untouched.",
    });
    checkpoint();
    const safety = { expiresAt: snapshotExpiry(snapshot), id: snapshot.id };
    try {
      await step(`Safety snapshot ${snapshot.id} of ${db.volumeId} created.`, { phase: "snapshotted", snapshot: safety }, { keepOnFailure: true });
    } catch (error) {
      throw new UsageError(writeFailure(`Safety snapshot ${snapshot.id} of ${db.volumeId} created.`, error));
    }
    checkpoint();

    // Step 6: replace the database.
    await pinDatabaseMachine(fly, db.app, db.machineId);
    fly.progress.write("Replacing the database");
    await advance("Drop sent: sessions on patch ended, DROP DATABASE patch, CREATE DATABASE patch.", { phase: "drop-sent" });
    // `-C` keeps the double-quoted SQL and each -c as one word, and a failed psql makes flyctl exit non-zero.
    await run(fly, "fly", consoleArgs(file, DROP_CREATE_SQL), { timeoutMs: DROP_TIMEOUT_MS });
    await advance(`Restore sent: ${pgRestoreCommand(file.path)}.`, { phase: "restore-sent" });
    fly.progress.write(`Restoring the backup of ${manifest.createdAt}`);
    try {
      // `pg_restore`'s exit status comes back as flyctl's; the remote process may keep running after a local timeout.
      await run(fly, "fly", consoleArgs(file, pgRestoreCommand(file.path)), { timeoutMs: PG_RESTORE_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof FlyInterrupted)) {
        // The phase stays restore-sent: a timeout says nothing about the remote process.
        await tryStep("pg_restore did not provably complete; the reason is the next line.");
      }
      throw error;
    }
    await advance("Restored: pg_restore exited 0.", { phase: "restored" });

    // Step 7: validate.
    fly.progress.write("Checking the restored database");
    let count: number | null;
    try {
      count = parseMigrationCount(await run(fly, "fly", consoleArgs(file, MIGRATION_COUNT_SQL), { timeoutMs: VALIDATION_TIMEOUT_MS }));
    } catch (error) {
      if (!(error instanceof FlyInterrupted)) {
        await tryStep(`${/did not finish within/u.test(firstLineOf(error)) ? "Validation timed out" : "Validation failed"}: ${firstLineOf(error)}`);
      }
      throw error;
    }
    const expected = manifest.schemaMigrations ?? 0;
    if (count !== expected) {
      await tryStep(`Validation failed: ${count ?? "no readable"} schema_migration rows, expected ${expected}.`, { mismatch: { expected, found: count } }, { keepOnFailure: true });
      throw new UsageError(`The restored database has ${count ?? "no readable"} schema_migration rows, not the backup's ${expected}.`);
    }
    await advance(`Validated: ${count} schema_migration rows, as in the backup.`, { phase: "validated" });

    // Step 8: release.
    fly.progress.write(`Deploying ${liveTag} again on the restored database`);
    await advance(`Release sent: fly deploy --image ${preflight.liveImage} --env PATCH_SERVER_TAG=${liveTag}.`, { phase: "release-sent" });
    // From zero machines, `fly deploy --config <saved> --image <live image> --env …` creates one machine on that image and writes a complete release with the marker (flyctl source).
    await run(fly, "fly", [
      "deploy",
      "--ha=false",
      "--app",
      app,
      "--config",
      flyToml,
      "--image",
      preflight.liveImage,
      "--env",
      `PATCH_SERVER_TAG=${liveTag}`,
    ], { show: true, timeoutMs: RELEASE_TIMEOUT_MS });
    await advance("Released: the deploy finished.", { phase: "released" });
    try {
      await waitUntilReady(fly, app);
    } catch (error) {
      if (!(error instanceof FlyInterrupted)) {
        await tryStep("Not ready: the deployed server did not answer /health/ready; the reason is the next line.");
      }
      throw error;
    }
    await advance("Completed: /health/ready answered.", { phase: "completed" });

    remote = undefined;
    await removeRemote(fly, file);
    const notes = await letSleep(fly);
    fly.progress.stop("Restore complete.");
    const expiry = safety.expiresAt;
    return [
      `Restored ${app} to the backup of ${manifest.createdAt}.`,
      `  Backup: ${chosen.directory}`,
      `  Database: ${db.app} on ${db.machineId}, ${count} schema_migration rows`,
      `  Server: ${liveTag} (${preflight.liveImage}), not changed`,
      `  Safety snapshot: ${snapshot.id}${expiry === null ? "" : ` (expires ${expiry})`}`,
      `  Record: ${recordPath} (its undo recipe stays valid until the snapshot expires)`,
      `  Dashboard: ${flyServerUrl(app)}`,
      "",
      "Your data is restored. Sign in again with `cmpatch login`, then publish a release to confirm end to end.",
      ...(notes.length === 0 ? [] : ["", ...notes]),
    ].join("\n");
  } catch (error) {
    fly.progress.fail("Restore failed.");
    if (error instanceof FlyInterrupted || interrupted) {
      // The interrupt hook owns the record and the guidance; wait for its write.
      await queue;
      throw new UsageError(`The restore was interrupted. Record: ${recordPath}`);
    }
    const message = errorMessage(error);
    if (record === undefined) {
      await discard();
      if (error instanceof UsageError && !/[Nn]othing was changed/u.test(message)) {
        throw new UsageError(`${message}\nNothing on ${app} was changed.`);
      }
      throw error;
    }
    if (record.phase === "staged") {
      const failure = await tryStep(`Stopped before the hold: ${firstLineOf(error)}`);
      const notes = await discard();
      throw new UsageError([`${message}\nNothing on ${app} was changed. Record: ${recordPath}`, ...(failure === null ? [] : [failure]), ...notes].join("\n"));
    }
    // From memory, whatever the disk does: a record that cannot be written
    // is one more line here, never the only output.
    const failure = await tryStep(`Stopped: ${firstLineOf(error)}`);
    throw new UsageError([message, "", ...stoppedGuidance(record, recordPath), ...(failure === null ? [] : ["", failure])].join("\n"));
  } finally {
    removeInterruptHook();
  }
}

function firstLineOf(error: unknown): string {
  return firstLine(errorMessage(error));
}

/** What the terminal says when a restore stops after the hold: where it stands, the record, and the recipes that apply. */
function stoppedGuidance(record: RestoreRecordInput, recordPath: string): string[] {
  const recipes = restoreRecipes(record);
  const db = record.database;
  const lines = [
    `The restore stopped at "${record.phase}". cmpatch does not continue or undo it by itself.`,
    describeRestorePhase(record),
    `Record: ${recordPath}`,
    `Before the restore: ${db.app} machine ${db.machineId}, volume ${db.volumeId} (${db.sizeGb} GB), ${db.migrationCount} schema_migration rows; ${record.app} on ${record.liveImage} (${record.liveTag}).`,
    `Safety snapshot: ${record.snapshot?.id ?? "not taken"}. Dump on the machine: ${record.remoteDump}.`,
    ...(recipes.sleep === null ? [] : [`${db.machineId} is kept awake (autostop off) so the steps below cannot stall inside a suspended machine; the last step of either recipe lets it sleep again.`]),
  ];
  if (recipes.finish !== null) {
    lines.push("", recipes.undo === null ? "To bring Patch back:" : "To finish the restore:", ...renderStepsPlain(recipes.finish));
  }
  if (recipes.undo !== null) {
    lines.push("", "To undo it instead:", ...renderStepsPlain(recipes.undo));
  }
  return lines;
}

/** D10: the hold holds only once the app has no machines at all. */
async function waitForNoMachines(fly: FlyContext, app: string): Promise<void> {
  const held = await pollUntil(fly.deps, { intervalMs: 2_000, waitMs: HOLD_WAIT_MS }, async () => {
    const machines = parseFlyMachines(await run(fly, "fly", ["machine", "list", "--app", app, "--json"], { timeoutMs: POLL_CALL_TIMEOUT_MS }));
    // `fly machine list --json` prints [] for an app with no machines.
    return machines !== null && machines.length === 0 ? true : undefined;
  });
  if (held === undefined) {
    throw new UsageError(`${app} still has machines a minute after fly scale count 0. fly machine list --app ${app} shows them.`);
  }
}

/** D4, before anything on Fly: the format and coverage, and that the backup is of this app and its database. */
function checkManifest(chosen: ChosenBackup, target: SelfhostFlyTarget): void {
  const { directory, manifest } = chosen;
  if (manifest.coverage === "config-only") {
    throw new UsageError([
      `${directory} is a config-only backup: ${manifest.app}'s database was external when it was taken, so there is no database in it to restore.`,
      "Restore the database with your database provider's own backups (for example point-in-time recovery). To put the server back as it was then, deploy the backup's release config and image:",
      `  fly deploy --app ${manifest.app} --config ${quoteShellValue("The backup directory", join(directory, "fly.toml"))} --image ${manifest.serverImage}`,
    ].join("\n"));
  }
  if (manifest.app !== target.app) {
    throw new UsageError(`${directory} is a backup of ${manifest.app}, not ${target.app}. A Fly restore only goes back into the app it was taken from. Nothing was changed.`);
  }
  if (target.databaseApp === undefined) {
    throw new UsageError(`${target.app} is recorded with an external database, so there is no database cmpatch can restore into. Nothing was changed.`);
  }
  if (manifest.databaseApp !== target.databaseApp) {
    throw new UsageError(`${directory} is a backup of the database app ${manifest.databaseApp ?? "(none)"}, but ${target.app} is recorded with ${target.databaseApp}. Nothing was changed.`);
  }
}

/**
 * The live tag the release step redeploys, once the backup is known not to
 * come from a newer server, whose schema the live one would not know.
 */
function checkDirection(app: string, manifest: FlyBackupManifest, marker: string | null): string {
  if (marker === null) {
    throw new UsageError(`${app} has no recorded server tag, so cmpatch cannot tell whether it is new enough for this backup. Run cmpatch selfhost upgrade --redeploy once to record it, then restore. Nothing was changed.`);
  }
  if (manifest.serverTag === null) {
    throw new UsageError(`The backup records no server tag, so cmpatch cannot tell whether ${marker} is new enough for it. Nothing was changed.`);
  }
  const order = compareServerTags(manifest.serverTag, marker);
  if (order === null) {
    throw new UsageError(`Could not compare the backup's server tag ${manifest.serverTag} with ${app}'s ${marker}. Nothing was changed.`);
  }
  if (order > 0) {
    throw new UsageError(`The backup was taken on ${manifest.serverTag}, which is newer than ${marker} on ${app}. Upgrade to at least ${manifest.serverTag} first (cmpatch selfhost upgrade --tag ${manifest.serverTag}), then restore. Nothing was changed.`);
  }
  return marker;
}

/** The backup to restore: the argument (a directory, or a name under the backup root), or one picked from the local list. */
async function chooseBackup(deps: CommandDeps, localRoot: string, argument: string | undefined): Promise<ChosenBackup> {
  if (argument !== undefined) {
    const directory = isAbsolute(argument) || argument.includes("/") || argument.startsWith(".")
      ? resolve(process.cwd(), argument)
      : join(localRoot, argument);
    return readBackup(directory);
  }

  const backups = await listLocalBackups(localRoot);
  const choices = backups.map((backup) => ({
    title: `${basename(backup.directory)}  (${backup.manifest.createdAt}, ${backup.manifest.coverage}, ${backup.manifest.serverTag ?? "no server tag"})`,
    value: backup.directory,
  }));
  choices.push({ title: "a backup folder elsewhere on this machine…", value: ELSEWHERE_CHOICE });
  const choice = await askSelect(deps, { choices, fallback: ELSEWHERE_CHOICE, message: "Which backup do you want to restore?" });
  const chosen = backups.find((backup) => backup.directory === choice);
  if (chosen !== undefined) {
    return chosen;
  }

  const answer = await deps.prompt?.({ message: "Path to the backup folder on this machine", type: "text" });
  const typed = (typeof answer === "string" ? answer : (answer?.[0] ?? "")).trim();
  if (typed.length === 0) {
    throw new UsageError("Pass the backup folder as an argument: cmpatch selfhost restore <backup>");
  }
  return readBackup(resolve(process.cwd(), typed));
}

/** Fly backups under the root, newest first. Anything else there (upgrade baselines, records, ssh downloads) is not listed. */
async function listLocalBackups(localRoot: string): Promise<ChosenBackup[]> {
  let entries: string[];
  try {
    entries = await readdir(localRoot);
  } catch {
    return [];
  }
  const backups: ChosenBackup[] = [];
  for (const entry of entries.filter((name) => !name.startsWith(".")).sort().reverse()) {
    const directory = join(localRoot, entry);
    const contents = await readFile(join(directory, FLY_BACKUP_MANIFEST), "utf8").catch(() => null);
    const parsed = contents === null ? null : parseBackupManifest(contents);
    if (parsed !== null && "manifest" in parsed) {
      backups.push({ directory, manifest: parsed.manifest });
    }
  }
  return backups;
}

async function readBackup(directory: string): Promise<ChosenBackup> {
  const contents = await readFile(join(directory, FLY_BACKUP_MANIFEST), "utf8").catch(() => null);
  if (contents === null) {
    const ssh = await exists(join(directory, "env.selfhost"));
    throw new UsageError(ssh
      ? `${directory} is a backup of an ssh server, not of a Fly install. Restore it with cmpatch selfhost restore <backup> user@vps.`
      : `${directory} is not a Fly backup: it has no ${FLY_BACKUP_MANIFEST}.`);
  }
  const parsed = parseBackupManifest(contents);
  if ("problem" in parsed) {
    throw new UsageError(`${join(directory, FLY_BACKUP_MANIFEST)} is not a backup this cmpatch can restore: ${parsed.problem}.`);
  }
  return { directory, manifest: parsed.manifest };
}
