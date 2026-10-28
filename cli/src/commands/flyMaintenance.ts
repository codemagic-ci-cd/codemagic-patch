/**
 * `cmpatch selfhost upgrade` on a Fly install, and the preflight and snapshot
 * backup and restore share with it. No secret is read here (D5); see
 * wiki/discussions/fly-setup-wizard.md, "Maintenance".
 */

import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SOURCE_REPO_URL } from "../branding";
import type { SelfhostFlyMapping } from "../configStore";
import {
  autostopArgs,
  compareServerTags,
  DATABASE_MOUNT,
  describeVmDrift,
  isServerTag,
  isSnapshotInProgress,
  latestRelease,
  listServerTags,
  MIGRATION_COUNT_SQL,
  missingFlyEnv,
  parseFlyAppConfig,
  parseFlyMachines,
  parseFlyReleases,
  parseFlySnapshots,
  parseMigrationCount,
  parseSavedFlyToml,
  RELEASE_COMPLETE,
  renderRollbackMd,
  SNAPSHOT_CREATED,
  SNAPSHOT_FAILED,
  snapshotExpiry,
  type FlyGuest,
  type FlyAutostop,
  type FlyMachine,
  type FlyRelease,
  type FlySnapshot,
  type RollbackDatabase,
} from "../flySetup";
import { onInterruptCleanup } from "../progress";
import { localBackupRoot, utcStamp } from "../selfhostRemote";
import type { SelfhostFlyTarget } from "../selfhostTarget";
import {
  cloneServerTag,
  createFlyContext,
  errorMessage,
  firstLine,
  flyLoginFirst,
  flyProgress,
  flyServerUrl,
  lastLines,
  latestServerTag,
  listRemoteTags,
  pollUntil,
  requireTool,
  run,
  signedIn,
  waitUntilReady,
  type FlyContext,
} from "./flyProcess";
import { askSelect, notice } from "./selfhostInstall/ask";
import {
  canAsk,
  readBooleanFlag,
  readStringFlag,
  type ParsedArgs,
} from "./selfhostSession";
import { UsageError, type CommandDeps } from "./shared";

type FlyPreflightDatabase =
  | { kind: "external" }
  | {
      app: string;
      kind: "managed";
      machineId: string;
      migrationCount: number;
      sizeGb: number;
      volumeId: string;
    };

type FlyPreflight = {
  database: FlyPreflightDatabase;
  /** The first line of `fly version`, for the records. */
  flyctlVersion: string;
  /** The image every Patch machine runs, which is also the newest release's. */
  liveImage: string;
  /** The live machine's size, for the `[[vm]]` notice. */
  liveGuest: FlyGuest | null;
  /** `PATCH_SERVER_TAG` from the live release config, or null for an install that predates it. */
  marker: string | null;
};

/**
 * D3: reads only, apart from starting a stopped or suspended database machine
 * so it can be asked ("Preflight" in the wiki record).
 */
export async function flyPreflight(
  fly: FlyContext,
  mapping: SelfhostFlyMapping,
  options: { localRoot: string },
): Promise<FlyPreflight> {
  const tool = await requireTool(fly, "fly");
  if (!(await signedIn(fly))) {
    throw new UsageError(flyLoginFirst(fly.rerun));
  }

  const app = mapping.app;
  fly.progress.write(`Checking ${app} on Fly`);
  const machines = readMachines(await run(fly, "fly", ["machine", "list", "--app", app, "--json"], { timeoutMs: POLL_CALL_TIMEOUT_MS }), app);
  const releases = parseFlyReleases(await run(fly, "fly", ["releases", "--app", app, "--json"], { timeoutMs: POLL_CALL_TIMEOUT_MS }));
  if (releases === null) {
    throw new UsageError(`Could not read fly releases --app ${app} --json. Check flyctl and the Fly API, then run ${fly.rerun} again.`);
  }
  const latest = latestRelease(releases);

  const machineImage = machines.find((machine) => machine.image.length > 0)?.image;
  const problem = consistencyProblem(machines, latest);
  if (problem !== null || latest === null) {
    const record = await newestRecoveryRecord(options.localRoot, app);
    const image = machineImage ?? (latest?.imageRef || "<image>");
    throw new UsageError([
      `${app} is mid-change: ${problem}.`,
      `Finish the pending recovery${record === null ? "" : ` (${record})`}, or reconcile with fly deploy --app ${app} --image ${image}, then run ${fly.rerun} again.`,
    ].join("\n"));
  }

  const shown = parseFlyAppConfig(await run(fly, "fly", ["config", "show", "--app", app], { timeoutMs: POLL_CALL_TIMEOUT_MS }));
  const marker = shown?.env.PATCH_SERVER_TAG ?? "";
  const database = mapping.databaseApp === undefined
    ? { kind: "external" as const }
    : await readDatabase(fly, app, mapping.databaseApp, options.localRoot);

  return {
    database,
    flyctlVersion: firstLine(tool.versionOutput.trim()),
    liveGuest: machines[0]?.guest ?? null,
    liveImage: latest.imageRef,
    marker: marker.length > 0 ? marker : null,
  };
}

/**
 * Why the app is not in one consistent state, or null when it is. A complete
 * release whose image cannot be read leaves nothing to roll back to (D8).
 */
function consistencyProblem(machines: readonly FlyMachine[], latest: FlyRelease | null): string | null {
  if (machines.length === 0) {
    return "it has no machines";
  }
  if (latest === null) {
    return "it has no releases";
  }
  if (latest.status !== RELEASE_COMPLETE) {
    return `its newest release v${latest.version} is ${latest.status || "in an unknown state"}, not ${RELEASE_COMPLETE}`;
  }
  if (latest.imageRef.length === 0) {
    throw new UsageError(`Could not read the image of the newest release (v${latest.version}) from fly releases --json. Nothing was changed. Check flyctl and the Fly API, then run the command again.`);
  }
  const strays = machines.filter((machine) => machine.image !== latest.imageRef);
  if (strays.length > 0) {
    return `${strays.map((machine) => machine.id).join(", ")} ${strays.length === 1 ? "runs" : "run"} ${strays[0]?.image || "an unknown image"}, not the newest release's ${latest.imageRef}`;
  }
  return null;
}

function readMachines(output: string, app: string): FlyMachine[] {
  const machines = parseFlyMachines(output);
  if (machines === null) {
    throw new UsageError(`Could not read fly machine list --app ${app} --json. Check flyctl and the Fly API.`);
  }
  return machines;
}

async function readDatabase(
  fly: FlyContext,
  app: string,
  databaseApp: string,
  localRoot: string,
): Promise<FlyPreflightDatabase> {
  fly.progress.write(`Checking ${databaseApp}`);
  const machines = await listDatabaseMachines(fly, databaseApp);
  if (machines.length !== 1) {
    const record = await newestRecoveryRecord(localRoot, app);
    throw new UsageError([
      `${databaseApp} has ${machines.length} machines; the database has to be exactly one.`,
      machines.length === 0
        ? `Start or recreate it with fly, then run ${fly.rerun} again.`
        : `A database cutover was left half done${record === null ? "" : ` (${record})`}: destroy whichever machine is not the verified one, then run ${fly.rerun} again.`,
    ].join("\n"));
  }

  const machine = machines[0] as FlyMachine;
  // Only the volume at the database's own path: snapshotting or restoring any
  // other volume would leave the real database out of the recovery.
  const mount = machine.mounts.find((entry) => entry.path === DATABASE_MOUNT);
  if (mount === undefined) {
    const found = machine.mounts.map((entry) => `${entry.volume} at ${entry.path}`).join(", ");
    throw new UsageError(`${machine.id} in ${databaseApp} has no volume mounted at ${DATABASE_MOUNT} (mounts found: ${found.length === 0 ? "none" : found}), so cmpatch cannot tell which volume holds the database. Nothing was changed.`);
  }
  if (mount.sizeGb === null) {
    throw new UsageError(`Could not read the volume mounted on ${machine.id} in ${databaseApp} from fly machine list --json. Nothing was changed.`);
  }

  await startIfNeeded(fly, databaseApp, machine);

  fly.progress.write("Counting the database's migrations");
  const output = await run(fly, "fly", consoleArgs({ app: databaseApp, machineId: machine.id }, MIGRATION_COUNT_SQL), { timeoutMs: CONSOLE_QUERY_TIMEOUT_MS });
  const migrationCount = parseMigrationCount(output);
  if (migrationCount === null) {
    throw new UsageError(`Could not read the schema_migration count on ${machine.id} in ${databaseApp}. Nothing was changed.\n${lastLines(output, 5)}`);
  }

  return {
    app: databaseApp,
    kind: "managed",
    machineId: machine.id,
    migrationCount,
    sizeGb: mount.sizeGb,
    volumeId: mount.volume,
  };
}

/** `fly ssh console -C` on one database machine. */
export function consoleArgs(machine: { app: string; machineId: string }, command: string): string[] {
  // flyctl splits `-C` into words itself, keeping a quoted group together, and runs it without a shell.
  return ["ssh", "console", "--app", machine.app, "--machine", machine.machineId, "-C", command];
}

/** One poll's flyctl call; a hung one must not outlast the wait it is part of. */
export const POLL_CALL_TIMEOUT_MS = 30_000;
/** A one-row query, a config save, a machine start or a snapshot request through flyctl: seconds when the connection is healthy. */
const CONSOLE_QUERY_TIMEOUT_MS = 2 * 60_000;
const START_WAIT_MS = 60_000;

function listDatabaseMachines(fly: FlyContext, databaseApp: string): Promise<FlyMachine[]> {
  return run(fly, "fly", ["machine", "list", "--app", databaseApp, "--json"], { timeoutMs: POLL_CALL_TIMEOUT_MS })
    .then((output) => readMachines(output, databaseApp));
}

async function startIfNeeded(fly: FlyContext, databaseApp: string, machine: FlyMachine): Promise<void> {
  // `fly ssh console --machine` wakes a stopped machine but refuses a suspended one ("machine <id>
  // is not started"); `fly machine start` resumes both, so any machine not started is started first.
  if (machine.state === "started") {
    return;
  }
  fly.progress.write(`Starting ${machine.id} in ${databaseApp}`);
  await run(fly, "fly", ["machine", "start", machine.id, "--app", databaseApp], { timeoutMs: CONSOLE_QUERY_TIMEOUT_MS });
  const started = await pollUntil(fly.deps, { intervalMs: 2_000, waitMs: START_WAIT_MS }, async () =>
    (await listDatabaseMachines(fly, databaseApp)).find((entry) => entry.id === machine.id)?.state === "started" ? true : undefined);
  if (started === undefined) {
    throw new UsageError(`${machine.id} in ${databaseApp} did not start within a minute. fly machine status ${machine.id} --app ${databaseApp} shows why.`);
  }
}

/**
 * The database machine the preflight pinned, started again if it suspended
 * since: restore talks to it several times over several minutes, and an idle
 * database machine suspends. Returns the machine as listed, autostop included.
 */
export async function pinDatabaseMachine(fly: FlyContext, databaseApp: string, machineId: string): Promise<FlyMachine> {
  const machine = (await listDatabaseMachines(fly, databaseApp)).find((entry) => entry.id === machineId);
  if (machine === undefined) {
    throw new UsageError(`${machineId}, the database machine the preflight found, is no longer in ${databaseApp}. fly machine list --app ${databaseApp} shows what is there.`);
  }
  await startIfNeeded(fly, databaseApp, machine);
  return machine;
}

/**
 * `fly machine update <id> --autostop=<value> --yes`: the one config change
 * the maintenance commands make to a database machine. On flyctl 0.4.122 it
 * changes the service's autostop without restarting the machine (checked
 * live). The proxy suspends an idle machine within about a minute of its
 * last connection, whatever an ssh session inside it is doing, so a step
 * that must not be interrupted turns autostop off first.
 */
export async function setAutostop(fly: FlyContext, databaseApp: string, machineId: string, value: FlyAutostop): Promise<void> {
  await run(fly, "fly", autostopArgs(machineId, databaseApp, value), { timeoutMs: CONSOLE_QUERY_TIMEOUT_MS });
}

/** The newest local `ROLLBACK.md` or restore record of this app, by the time in its name. */
async function newestRecoveryRecord(localRoot: string, app: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(localRoot);
  } catch {
    return null;
  }

  const prefix = `${app}-`;
  let newest: { path: string; stamp: string } | null = null;
  for (const entry of entries) {
    const name = entry.startsWith(prefix) ? entry.slice(prefix.length) : "";
    const upgrade = /^upgrade-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/u.exec(name);
    const restore = /^restore-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.md$/u.exec(name);
    const match = upgrade ?? restore;
    if (match === null) {
      continue;
    }
    const path = upgrade === null ? join(localRoot, entry) : join(localRoot, entry, "ROLLBACK.md");
    if (!(await exists(path))) {
      continue;
    }
    const stamp = match[1] ?? "";
    if (newest === null || stamp > newest.stamp) {
      newest = { path, stamp };
    }
  }
  return newest?.path ?? null;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The ssh-only flags refused, then the run's context, step tree and local backup root. */
export function openFlyCommand(
  deps: CommandDeps,
  parsed: ParsedArgs,
  input: {
    label: string;
    /** The deps the run's processes go through, when not `deps` itself. */
    processDeps?: CommandDeps;
    sshOnlyFlags: Readonly<Record<string, string>>;
    target: SelfhostFlyTarget;
  },
): { fly: FlyContext; localRoot: string } {
  for (const [flag, reason] of Object.entries(input.sshOnlyFlags)) {
    if (parsed.flags[flag] !== undefined) {
      throw new UsageError(reason);
    }
  }
  return {
    fly: createFlyContext(input.processDeps ?? deps, input.label, flyProgress(deps, input.label)),
    localRoot: localBackupRoot(new URL(input.target.serverUrl).hostname),
  };
}

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

const UPGRADE = "cmpatch selfhost upgrade";

/** The ssh upgrade's flags that mean nothing on Fly, each with why. */
const SSH_ONLY_UPGRADE_FLAGS: Readonly<Record<string, string>> = {
  "--i-have-a-backup": "--i-have-a-backup does not apply to a Fly install: the upgrade always snapshots the database volume first, which takes a minute and costs nothing to keep.",
  "--image": "--image does not apply to a Fly install: the upgrade builds the server from a release tag on Fly. Pass --tag to choose the release.",
  "--local-image": "--local-image does not apply to a Fly install: Fly builds the image itself, so there is no image on a host to reuse.",
  "--skip-smoke": "--skip-smoke does not apply to a Fly install: the upgrade only waits for /health/ready and runs no smoke test.",
  "--ssh-key": "--ssh-key does not apply to a Fly install: the upgrade reaches Fly through flyctl, not ssh.",
};

type Baseline = {
  directory: string;
  kind: "full" | "image-only";
  snapshot: FlySnapshot | null;
  snapshotExpiresAt: string | null;
};

/** `cmpatch selfhost upgrade` for a Fly mapping ("Upgrade flow" in the wiki record). */
export async function runFlyUpgrade(
  deps: CommandDeps,
  parsed: ParsedArgs,
  target: SelfhostFlyTarget,
): Promise<string> {
  const { fly, localRoot } = openFlyCommand(deps, parsed, { label: UPGRADE, sshOnlyFlags: SSH_ONLY_UPGRADE_FLAGS, target });
  const requested = readStringFlag(parsed, "--tag");
  if (requested !== undefined && !isServerTag(requested)) {
    throw new UsageError(`--tag takes a server release tag such as codemagic-patch-server-v0.7.0, not ${requested}.`);
  }

  const interactive = canAsk(deps, parsed);
  const app = target.app;

  let baseline: Baseline | undefined;
  let parent: string | undefined;
  let deploying = false;
  const removeInterruptHook = onInterruptCleanup(async () => {
    if (deploying && baseline !== undefined) {
      notice(deps, ["Interrupted. The deploy Fly already accepted may still finish, and cmpatch does not roll back by itself.", ...afterDeployText(parent, baseline)]);
      return;
    }
    if (parent !== undefined) {
      await rm(parent, { force: true, recursive: true });
    }
    notice(deps, `Interrupted. Nothing was deployed, so ${app} is unchanged.`);
  });
  try {
    const preflight = await flyPreflight(fly, target, { localRoot });

    // Everything that can still refuse without touching Fly runs before the
    // baseline, so a failed clone or an incomplete release config leaves no
    // snapshot and no ROLLBACK.md behind for an upgrade that never happened.
    parent = await mkdtemp(join(tmpdir(), "cmpatch-fly-"));
    // The saved config is read before the tag is chosen: an unreadable
    // `fly config show` must not switch off the downgrade check.
    const savedToml = await saveReleaseConfig(fly, app, join(parent, "fly.toml"));
    const marker = reconcileMarker(app, preflight.liveImage, preflight.marker, savedMarker(await readFile(savedToml, "utf8")));
    const live: FlyPreflight = { ...preflight, marker };

    fly.progress.write("Looking up the server releases");
    const tag = pickTag(await listRemoteTags(fly), requested, live.marker, app);
    if (tag === live.marker && !readBooleanFlag(parsed, "--redeploy")) {
      const again = interactive && await askRedeploy(deps, fly, app, tag);
      if (!again) {
        await rm(parent, { force: true, recursive: true });
        fly.progress.stop();
        return `${app} is already on ${tag}. Nothing was deployed.${interactive ? "" : " Pass --redeploy to deploy it again."}`;
      }
    }

    const checkout = await cloneServerTag(fly, tag, parent);
    const flyToml = join(checkout, "fly.toml");
    await rename(savedToml, flyToml);
    await checkReleaseConfig(fly, app, flyToml, live.liveGuest);

    const directory = join(localRoot, `${app}-upgrade-${utcStamp(deps.now())}`);
    if (preflight.database.kind === "external") {
      fly.progress.settle();
      notice(deps, [
        `Patch's database is external, so this upgrade cannot snapshot it. The new server migrates the database when it boots.`,
        `Going back afterwards needs your own backup or point-in-time recovery from before this upgrade. ${join(directory, "ROLLBACK.md")} will say how.`,
      ]);
    }

    baseline = await takeBaseline(fly, target, live, { directory, tag });
    await copyFile(flyToml, join(baseline.directory, "fly.toml"));

    fly.progress.write(`Building ${tag} on Fly and deploying it. The build takes several minutes.`);
    deploying = true;
    // `--env` wins over the saved [env], so the new release's config carries the new marker. The
    // saved config already has [build] dockerfile = 'server/Dockerfile'; --dockerfile only says so.
    await run(fly, "fly", [
      "deploy",
      "--ha=false",
      "--app",
      app,
      "--config",
      flyToml,
      "--dockerfile",
      "server/Dockerfile",
      "--env",
      `PATCH_SERVER_TAG=${tag}`,
    ], { cwd: checkout, show: true });
    await waitUntilReady(fly, app);
    await rm(parent, { force: true, recursive: true });
    parent = undefined;

    fly.progress.stop("Upgrade complete.");
    return upgradeSummary({ app, baseline, preflight: live, tag });
  } catch (error) {
    fly.progress.fail("Upgrade failed.");
    const message = errorMessage(error);
    if (deploying && baseline !== undefined) {
      throw new UsageError([
        message,
        "",
        "The upgrade stopped during or after the deploy. cmpatch does not roll back by itself.",
        ...afterDeployText(parent, baseline),
      ].join("\n"));
    }
    if (parent !== undefined) {
      await rm(parent, { force: true, recursive: true });
    }
    // From the clone on, every failure before the deploy gets the same closing
    // line; the snapshot's own messages already carry it.
    if (parent !== undefined && !message.includes("Nothing was deployed")) {
      throw new UsageError(`${message}\nNothing was deployed, so ${app} is unchanged.`);
    }
    throw error;
  } finally {
    removeInterruptHook();
  }
}

/** Where to look once a deploy has started, whether it failed or was interrupted. */
function afterDeployText(parent: string | undefined, baseline: Baseline): string[] {
  return [
    ...(parent === undefined ? [] : [`The checkout is still at ${parent}.`]),
    `Baseline: ${baseline.directory}`,
    `To go back, follow ${join(baseline.directory, "ROLLBACK.md")}`,
  ];
}

/** `PATCH_SERVER_TAG` in a `fly config save` file, or null when it is missing or empty. */
function savedMarker(contents: string): string | null {
  const tag = parseSavedFlyToml(contents).env.PATCH_SERVER_TAG ?? "";
  return tag.length > 0 ? tag : null;
}

/**
 * One live marker from the two copies of the release config. Either alone is
 * enough; two different tags leave no way to tell which server ran last.
 */
function reconcileMarker(app: string, liveImage: string, shown: string | null, saved: string | null): string | null {
  if (shown !== null && saved !== null && shown !== saved) {
    // Not "run the upgrade again": while the two keep disagreeing, a rerun
    // refuses the same way. A plain deploy of the live image with one marker
    // is what puts the release config right.
    throw new UsageError([
      `${app}'s release config names two server tags: ${shown} in fly config show --app ${app} and ${saved} in fly config save --app ${app}. Nothing was deployed, so ${app} is unchanged.`,
      `Check which release is running with fly releases --app ${app}, write that tag back with fly deploy --app ${app} --image ${liveImage} --env PATCH_SERVER_TAG=<that tag>, then run ${UPGRADE} again.`,
    ].join("\n"));
  }
  return shown ?? saved;
}

/**
 * `--tag` or the newest release, never older than the live marker: that
 * server may already have migrated the database.
 */
function pickTag(lsRemote: string, requested: string | undefined, marker: string | null, app: string): string {
  let tag: string;
  if (requested !== undefined) {
    if (!listServerTags(lsRemote).includes(requested)) {
      throw new UsageError(`${requested} is not a release in ${SOURCE_REPO_URL}. git ls-remote --tags ${SOURCE_REPO_URL} lists them.`);
    }
    tag = requested;
  } else {
    tag = latestServerTag(lsRemote);
  }

  if (marker !== null && (compareServerTags(tag, marker) ?? 0) < 0) {
    throw new UsageError([
      `${tag} is older than ${marker}, which ${app} runs. An upgrade does not go back: ${marker} may already have migrated the database.`,
      `To go back, follow the ROLLBACK.md of the upgrade that deployed ${marker}.`,
    ].join("\n"));
  }
  return tag;
}

async function askRedeploy(deps: CommandDeps, fly: FlyContext, app: string, tag: string): Promise<boolean> {
  fly.progress.settle();
  const answer = await askSelect(deps, {
    choices: [
      { title: "No, leave it", value: "no" },
      { title: "Yes, redeploy it", value: "yes" },
    ],
    fallback: "no",
    initial: 0,
    message: `${app} is already on ${tag}. Redeploy it anyway?`,
  });
  return answer === "yes";
}

/** D8: `baseline.json` and `ROLLBACK.md`, and with a managed database a snapshot, before any deploy. */
async function takeBaseline(
  fly: FlyContext,
  target: SelfhostFlyTarget,
  preflight: FlyPreflight,
  input: { directory: string; tag: string },
): Promise<Baseline> {
  const { directory } = input;
  const createdAt = new Date(fly.deps.now()).toISOString();

  const managed = preflight.database.kind === "managed" ? preflight.database : null;
  let snapshot: FlySnapshot | null = null;
  let expiresAt: string | null = null;
  let database: RollbackDatabase = { kind: "external" };
  if (managed !== null) {
    snapshot = await takeSnapshot(fly, managed.app, managed.volumeId, { operation: "this upgrade", unchanged: "Nothing was deployed." });
    expiresAt = snapshotExpiry(snapshot);
    database = {
      app: managed.app,
      kind: "managed",
      machineId: managed.machineId,
      migrationCount: managed.migrationCount,
      sizeGb: managed.sizeGb,
      snapshotExpiresAt: expiresAt,
      snapshotId: snapshot.id,
      volumeId: managed.volumeId,
    };
  }
  const kind = database.kind === "managed" ? "full" : "image-only";

  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(join(directory, "baseline.json"), `${JSON.stringify({
    app: target.app,
    created_at: createdAt,
    database_app: managed?.app ?? null,
    database_machine: managed?.machineId ?? null,
    flyctl_version: preflight.flyctlVersion,
    format: "fly-upgrade-baseline/1",
    previous_image: preflight.liveImage,
    previous_tag: preflight.marker,
    region: target.region,
    rollback: kind,
    schema_migrations: managed?.migrationCount ?? null,
    snapshot_expires_at: expiresAt,
    snapshot_id: snapshot?.id ?? null,
    snapshot_retention_days: snapshot?.retentionDays ?? null,
    target_tag: input.tag,
    volume_id: managed?.volumeId ?? null,
    volume_size_gb: managed?.sizeGb ?? null,
  }, null, 2)}\n`);
  await writeFile(join(directory, "ROLLBACK.md"), renderRollbackMd({
    app: target.app,
    createdAt,
    database,
    directory,
    previousImage: preflight.liveImage,
    previousTag: preflight.marker,
    region: target.region,
    targetTag: input.tag,
  }));

  return { directory, kind, snapshot, snapshotExpiresAt: expiresAt };
}

const SNAPSHOT_POLL_MS = 5_000;
const SNAPSHOT_WAIT_MS = 10 * 60_000;

/**
 * A snapshot of the database volume, waited until it is `created`. flyctl's
 * create prints no id, but the list shows the new snapshot with its id at
 * once, so it is the one id the list before the create did not have; two new
 * ids stop the command ("Upgrade flow", step 3, in the wiki record).
 */
export async function takeSnapshot(
  fly: FlyContext,
  databaseApp: string,
  volumeId: string,
  copy: {
    /** Whose snapshot it is, as in "this upgrade". */
    operation: string;
    /** What a failure here leaves unchanged, as one sentence. */
    unchanged: string;
  },
): Promise<FlySnapshot> {
  const list = () => listSnapshots(fly, databaseApp, volumeId, copy.unchanged);

  const before = await list();
  refuseSnapshotInProgress(fly, before, databaseApp, volumeId);
  const known = new Set(before.map((snapshot) => snapshot.id));

  fly.progress.write(`Snapshotting ${volumeId} in ${databaseApp}`);
  const requestedAt = fly.deps.now();
  // Prints "Scheduled to snapshot volume …" and no id, even with --json.
  await run(fly, "fly", ["volumes", "snapshots", "create", volumeId, "--app", databaseApp], { timeoutMs: CONSOLE_QUERY_TIMEOUT_MS });

  let seen = false;
  const created = await pollUntil(fly.deps, { from: requestedAt, intervalMs: SNAPSHOT_POLL_MS, waitMs: SNAPSHOT_WAIT_MS }, async () => {
    // While a snapshot moves from waiting to running, one list can carry two
    // rows with its id (seen on a live run); one row per id, the furthest along.
    const byId = new Map<string, FlySnapshot>();
    for (const snapshot of await list()) {
      if (known.has(snapshot.id)) {
        continue;
      }
      const other = byId.get(snapshot.id);
      if (other === undefined || isSnapshotInProgress(other)) {
        byId.set(snapshot.id, snapshot);
      }
    }
    const fresh = [...byId.values()];
    if (fresh.length > 1) {
      throw new UsageError([
        `Could not tell which new snapshot of ${volumeId} ${copy.operation} made: ${fresh.map((snapshot) => snapshot.id).join(", ")}. ${copy.unchanged}`,
        `Wait until fly volumes snapshots list ${volumeId} --app ${databaseApp} shows no snapshot in progress, then run ${fly.rerun} again.`,
      ].join("\n"));
    }
    const snapshot = fresh[0];
    seen ||= snapshot !== undefined;
    if (snapshot?.status === SNAPSHOT_FAILED) {
      throw new UsageError([
        `The snapshot of ${volumeId} ${copy.operation} requested failed (${snapshot.id}). ${copy.unchanged}`,
        `fly volumes snapshots list ${volumeId} --app ${databaseApp} shows it. Run ${fly.rerun} again; if it fails again, check the volume with fly volumes show ${volumeId} --app ${databaseApp}.`,
      ].join("\n"));
    }
    return snapshot?.status === SNAPSHOT_CREATED ? snapshot : undefined;
  });
  if (created !== undefined) {
    return created;
  }

  throw new UsageError([
    seen
      ? `The snapshot of ${volumeId} did not reach ${SNAPSHOT_CREATED} within 10 minutes. ${copy.unchanged}`
      : `No new snapshot of ${volumeId} appeared within 10 minutes. ${copy.unchanged}`,
    `fly volumes snapshots list ${volumeId} --app ${databaseApp} shows where it is. Run ${fly.rerun} again once it is created.`,
  ].join("\n"));
}

/** Stops before a snapshot is requested while another of the same volume is still in progress: Fly refuses a second create while one is scheduled. */
export function refuseSnapshotInProgress(
  fly: FlyContext,
  snapshots: readonly FlySnapshot[],
  databaseApp: string,
  volumeId: string,
): void {
  if (snapshots.some(isSnapshotInProgress)) {
    throw new UsageError(`A volume snapshot is already in progress for ${volumeId}; wait for it to finish and run ${fly.rerun} again. fly volumes snapshots list ${volumeId} --app ${databaseApp} shows it.`);
  }
}

export async function listSnapshots(fly: FlyContext, databaseApp: string, volumeId: string, unchanged: string): Promise<FlySnapshot[]> {
  const snapshots = parseFlySnapshots(await run(
    fly,
    "fly",
    ["volumes", "snapshots", "list", volumeId, "--app", databaseApp, "--json"],
    { timeoutMs: POLL_CALL_TIMEOUT_MS },
  ));
  if (snapshots === null) {
    throw new UsageError(`Could not read fly volumes snapshots list ${volumeId} --app ${databaseApp} --json. ${unchanged}`);
  }
  return snapshots;
}

/** D7: the live release config, the base of the upgrade and what restore's release step deploys, saved to `flyToml`. */
export async function saveReleaseConfig(fly: FlyContext, app: string, flyToml: string): Promise<string> {
  fly.progress.write(`Saving ${app}'s release config`);
  // `--config` names the file flyctl loads before it saves, so the path has
  // to exist: an empty file is enough, and flyctl rewrites it in place.
  await writeFile(flyToml, "");
  await run(fly, "fly", ["config", "save", "--app", app, "--config", flyToml, "--yes"], { timeoutMs: CONSOLE_QUERY_TIMEOUT_MS });
  return flyToml;
}

/**
 * D7's checks on the saved release config, which is what gets deployed: a key
 * Patch cannot start without stops; a `[[vm]]` that differs from the live
 * machine is a notice.
 */
export async function checkReleaseConfig(fly: FlyContext, app: string, flyToml: string, liveGuest: FlyGuest | null): Promise<void> {
  const saved = parseSavedFlyToml(await readFile(flyToml, "utf8"));
  const missing = missingFlyEnv(saved.env);
  if (missing.length > 0) {
    throw new UsageError([
      `${app}'s release config has no ${missing.join(", ")} in [env], and the server cannot start without ${missing.length === 1 ? "it" : "them"}.`,
      `Put ${missing.length === 1 ? "it" : "them"} back (fly config save --app ${app}, edit [env], fly deploy --app ${app} --image <live image>), then run ${fly.rerun} again.`,
    ].join("\n"));
  }

  const drift = describeVmDrift(saved.vm, liveGuest);
  if (drift !== null) {
    fly.progress.settle();
    notice(fly.deps, drift);
  }
}

function upgradeSummary(input: {
  app: string;
  baseline: Baseline;
  preflight: FlyPreflight;
  tag: string;
}): string {
  const { baseline } = input;
  const expiry = baseline.snapshotExpiresAt;
  return [
    `Upgraded ${input.app} on Fly: ${input.preflight.marker ?? "an unrecorded server tag"} → ${input.tag}.`,
    `  Previous image: ${input.preflight.liveImage}`,
    baseline.snapshot === null
      ? "  Database: external, no snapshot taken"
      : `  Database snapshot: ${baseline.snapshot.id}${expiry === null ? "" : ` (expires ${expiry})`}`,
    `  Baseline: ${baseline.directory} (${baseline.kind} rollback in ROLLBACK.md)`,
    `  Dashboard: ${flyServerUrl(input.app)}`,
  ].join("\n");
}
