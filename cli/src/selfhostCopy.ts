/**
 * What a backup on *this* deployment actually contains, in plain words.
 *
 * The wizard installs bundled database and storage, but `backup`, `upgrade`,
 * and `restore` are offered to any server — including the advanced direct
 * `install.sh` deployments on an external database or S3/GCS storage, which is
 * exactly who this command family is most valuable to. `backup.sh` excludes
 * those components by design and `restore.sh` skips restoring them, so a fixed
 * "the database, uploaded release files, and the settings file" would be a
 * false claim of a complete disaster-recovery snapshot on those deployments.
 *
 * The answer is copy and gating in the CLI only — no script change, and no
 * early rejection: refusing external modes outright would take the tooling
 * away from the deployments that need it most. What the user gets instead is
 * the missing half named, with the provider's own tooling, **before** the
 * confirmation rather than in raw script output after the work starts.
 */

export type DeploymentModes = {
  databaseMode: string | null;
  storageMode: string | null;
};

export type ExcludedComponent = {
  /** The provider-side tooling that covers what this backup does not. */
  advice: string;
  /** The bare noun, for sentences that put several of these in a list. */
  name: string;
  /** The noun plus the clause that says where it actually lives. */
  what: string;
};

export type BackupCoverage = {
  excluded: ExcludedComponent[];
  included: string[];
  /**
   * False when nothing bundled is left to snapshot: `backup.sh` then takes a
   * config-only backup and deliberately leaves the server running, so
   * promising a pause would be wrong in the one direction that matters.
   */
  pausesTheServer: boolean;
};

const BUNDLED_DATABASE = "the database";
const BUNDLED_STORAGE = "uploaded release files";
const SETTINGS = "the settings file";

export function describeBackupCoverage(modes: DeploymentModes): BackupCoverage {
  const databaseIsBundled = (modes.databaseMode ?? "bundled") === "bundled";
  const storageIsBundled = (modes.storageMode ?? "bundled") === "bundled";

  const included: string[] = [];
  const excluded: ExcludedComponent[] = [];

  if (databaseIsBundled) {
    included.push(BUNDLED_DATABASE);
  } else {
    excluded.push({
      advice:
        "your database provider's own backups (for example an RDS snapshot, or point-in-time recovery)",
      name: "your database",
      what: "your database, which runs outside this server",
    });
  }

  if (storageIsBundled) {
    included.push(BUNDLED_STORAGE);
  } else {
    excluded.push({
      advice:
        "your storage provider's own tooling (for example bucket versioning or replication)",
      name: "your uploaded release files",
      what: "your uploaded release files, which live in your own storage bucket",
    });
  }

  included.push(SETTINGS);

  return {
    excluded,
    included,
    pausesTheServer: databaseIsBundled || storageIsBundled,
  };
}

/** "the database, uploaded release files, and the settings file" */
function joinPlainList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  if (items.length === 2) {
    return `${items[0] ?? ""} and ${items[1] ?? ""}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1] ?? ""}`;
}

export function renderBackupIntro(coverage: BackupCoverage): string[] {
  const lines = [
    `this saves a snapshot of your server: ${joinPlainList(coverage.included)}.`,
  ];

  for (const component of coverage.excluded) {
    // Phrased with the component as the object, not the subject: "your
    // uploaded release files" is plural and "your database" is singular, and
    // one sentence has to fit both.
    lines.push(
      `this snapshot does NOT include ${component.what} — protect that with ${component.advice}.`,
    );
  }

  if (coverage.pausesTheServer) {
    lines.push(
      "the dashboard and publishing pause while the snapshot is taken; your apps keep downloading updates as usual.",
    );
  }

  return lines;
}

/**
 * What this restore actually puts back on the server, given the settings
 * answer. `restore.sh` skips every component that lives outside the server,
 * and touches the settings file only under `--restore-env` — so this is the
 * scope the typed gate approves, and an empty result is a restore that would
 * change nothing.
 */
export function describeRestoredComponents(
  coverage: BackupCoverage,
  restoreEnv: boolean,
): string[] {
  return coverage.included.filter(
    (component) => component !== SETTINGS || restoreEnv,
  );
}

/**
 * What the restore does, printed above the settings question and the typed
 * gate. The settings file is deliberately absent from the list: whether it is
 * restored is the very next question, and `renderRestoreScope` states the
 * answer at the gate itself.
 */
export function renderRestoreConsequence(input: {
  coverage: BackupCoverage;
  createdAt: string | null;
}): string[] {
  const anchor = input.createdAt ?? "the time the backup was taken";
  const replaced = describeRestoredComponents(input.coverage, false);
  // Fully external deployment: the settings file is the only thing this backup
  // holds that lives on the server, so there is no list to state, nothing
  // published that a restore could roll back, and nothing for the excluded
  // components to fail to match.
  const onlySettings = replaced.length === 0;

  const lines = onlySettings
    ? [
        // Reached only when *every* data component is external, so the list is
        // always plural and "live" always agrees with it.
        `on this server the backup covers only the settings file — ${joinPlainList(
          input.coverage.excluded.map((component) => component.name),
        )} live elsewhere.`,
      ]
    : [
        `this replaces the server's current data with that backup: ${joinPlainList(
          replaced,
        )}.`,
        `everything published after ${anchor} will be gone.`,
      ];

  for (const component of input.coverage.excluded) {
    lines.push(
      `this command does NOT restore ${component.what} — roll that back to ${anchor} yourself with ${component.advice}${
        onlySettings ? "" : ", or the restored data will not match it"
      }.`,
    );
  }

  lines.push(
    onlySettings
      ? "(the current settings file is saved to a safety backup first, so a failed restore can be undone.)"
      : "(the current data is saved to a safety backup first, so a failed restore can be undone.)",
  );

  return lines;
}

/**
 * Why a restore with nothing left in its scope is refused rather than run.
 *
 * On a fully external deployment the backup holds nothing but the settings
 * file, so a "no" to the settings question leaves `restore.sh` with nothing to
 * put back — while still stopping the stack, taking a safety backup, and
 * reporting a restore that restored nothing.
 */
export function renderRestoreNoOp(coverage: BackupCoverage): string {
  // Stands on its own: the flags-only path never printed the consequence
  // lines, so this has to say where the data lives as well as what to do.
  const outside = joinPlainList(
    coverage.excluded.map((component) => component.name),
  );

  return `This restore would not change anything: ${outside} live outside this server, so the settings file is all this backup could put back — and you kept the current one. Rerun with --restore-env to restore the settings file, or roll the parts that live elsewhere back with your provider's own tooling.`;
}

/**
 * The scope the typed gate approves, stated at the gate itself.
 *
 * The settings question runs *before* the gate, so the strongest confirmation
 * the command family has names the answer the user just gave — a yes after the
 * gate would change this server's domains and keys with nothing left to
 * approve it.
 */
export function renderRestoreScope(restoreEnv: boolean): string {
  return restoreEnv
    ? "the settings file is restored too: the backup's domains and keys replace the ones this server uses now."
    : "the settings file is not restored: this server keeps its current domains and keys.";
}
