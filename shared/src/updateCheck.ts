/**
 * "A newer CLI is on npm" notice, shared by `cmpatch` and `cmpatch-capacitor`.
 *
 * A command never waits on the registry. It prints what an earlier run's check
 * found, and when that answer is stale it starts the next check as a detached
 * process whose result the *following* run reads. The state file is the only
 * thing the two processes share.
 *
 * No `node:` imports here: the dashboard bundles this package's index, so the
 * file system and the child process are handed in by each CLI.
 */

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const REGISTRY_URL = "https://registry.npmjs.org";

// Also what keeps a registry answer, or an edited state file, from putting
// terminal control characters into the notice.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

interface UpdateCheckState {
  checkedAt: number;
  /** Absent until a check has succeeded once. */
  latestVersion?: string;
  /**
   * False from the moment a check is started until it reports back, so a
   * check that never answers is retried on the failure schedule.
   */
  succeeded: boolean;
}

function parseUpdateCheckState(text: string | null): UpdateCheckState | null {
  if (text === null) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const { checkedAt, latestVersion, succeeded } = parsed as Record<string, unknown>;
  if (typeof checkedAt !== "number" || typeof succeeded !== "boolean") {
    return null;
  }

  return {
    checkedAt,
    succeeded,
    ...(typeof latestVersion === "string" && VERSION_PATTERN.test(latestVersion)
      ? { latestVersion }
      : {}),
  };
}

function isUpdateCheckDue(state: UpdateCheckState | null, now: number): boolean {
  if (state === null) {
    return true;
  }

  const age = now - state.checkedAt;
  // A timestamp from the future (a clock that was set back) would otherwise
  // silence the check until the clock caught up.
  return age < 0 || age >= (state.succeeded ? SUCCESS_TTL_MS : FAILURE_TTL_MS);
}

/** Whether `candidate` is a later release than `current`, by SemVer precedence. */
function isNewerVersion(candidate: string, current: string): boolean {
  const a = VERSION_PATTERN.exec(candidate);
  const b = VERSION_PATTERN.exec(current);
  if (a === null || b === null) {
    return false;
  }

  for (const index of [1, 2, 3]) {
    const diff = Number(a[index]) - Number(b[index]);
    if (diff !== 0) {
      return diff > 0;
    }
  }

  // A release is later than any prerelease of it.
  if (a[4] === undefined || b[4] === undefined) {
    return a[4] === undefined && b[4] !== undefined;
  }

  const left = a[4].slice(1).split(".");
  const right = b[4].slice(1).split(".");
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const diff = comparePrereleaseIdentifiers(left[index]!, right[index]!);
    if (diff !== 0) {
      return diff > 0;
    }
  }

  return left.length > right.length;
}

/** Numeric identifiers by value and below any other; the rest as text. */
function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftIsNumber = /^\d+$/.test(left);
  const rightIsNumber = /^\d+$/.test(right);
  if (leftIsNumber && rightIsNumber) {
    return Number(left) - Number(right);
  }
  if (leftIsNumber !== rightIsNumber) {
    return leftIsNumber ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

type Env = Record<string, string | undefined>;

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export interface UpdateNoticeRun {
  /** The command as typed, for the notice: `cmpatch`. */
  cliName: string;
  currentVersion: string;
  env: Env;
  /**
   * A build that `npm install -g` would not replace with what the user means
   * to run (cmpatch's internal source-bundle build): the notice names the
   * release and leaves the command out.
   */
  hideInstallHint?: boolean;
  /** `--format json` was asked for. */
  jsonRequested: boolean;
  now: number;
  packageName: string;
  /**
   * The state file's text; null when it is missing or unreadable. Like
   * `writeState` and `startCheck`, called only when the run is not silenced.
   */
  readState: () => string | null;
  /** Starts the detached check. Failures are swallowed. */
  startCheck: () => void;
  stderr: { isTTY?: boolean; write: (chunk: string) => void };
  stdout: { isTTY?: boolean };
  /** Colours the notice; identity when absent. */
  style?: (line: string) => string;
  /** May throw (a read-only home); no check is started then. */
  writeState: (text: string) => void;
}

/**
 * Prints the notice an earlier check earned and starts the next check when
 * one is due. Call it after the command's own output. Never throws.
 *
 * It does nothing at all, the registry request included, unless a person is
 * reading both streams: not in CI, not when either stream is piped or JSON
 * was asked for, and not when `CMPATCH_NO_UPDATE_CHECK` or
 * `NO_UPDATE_NOTIFIER` opts out.
 */
export function notifyOfUpdate(run: UpdateNoticeRun): void {
  if (
    run.stdout.isTTY !== true ||
    run.stderr.isTTY !== true ||
    run.jsonRequested ||
    isEnabled(run.env.CI) ||
    isEnabled(run.env.CMPATCH_NO_UPDATE_CHECK) ||
    isEnabled(run.env.NO_UPDATE_NOTIFIER)
  ) {
    return;
  }

  try {
    const state = parseUpdateCheckState(run.readState());
    const latest = state?.latestVersion;

    if (latest !== undefined && isNewerVersion(latest, run.currentVersion)) {
      // Set by npm, yarn, pnpm and bun for what they run: an `npx` copy is
      // thrown away, and a project-local one is updated in its package.json.
      const hint =
        run.hideInstallHint === true || run.env.npm_config_user_agent !== undefined
          ? ""
          : ` Update with \`npm install -g ${run.packageName}@latest\`.`;
      const line = `A newer ${run.cliName} is available: ${run.currentVersion} → ${latest}.${hint}`;
      run.stderr.write(`${run.style?.(line) ?? line}\n`);
    }

    if (isUpdateCheckDue(state, run.now)) {
      // Stamped before the check starts, not by it: a check that cannot run
      // at all must not be started again by every command.
      run.writeState(
        serializeState({ checkedAt: run.now, latestVersion: latest, succeeded: false }),
      );
      run.startCheck();
    }
  } catch {
    // The notice is a courtesy; it never fails or delays the command it follows.
  }
}

export interface UpdateCheckRun {
  fetch: typeof globalThis.fetch;
  now: () => number;
  packageName: string;
  writeState: (text: string) => void;
}

/**
 * The detached half: asks the npm registry for the package's `latest` and
 * records it. A failure writes nothing, which leaves the stamp
 * `notifyOfUpdate` made in place. Never throws.
 */
export async function checkForUpdate(run: UpdateCheckRun): Promise<void> {
  try {
    // The dist-tags document is a few bytes; the packument lists every release.
    const response = await run.fetch(
      `${REGISTRY_URL}/-/package/${run.packageName.replace("/", "%2f")}/dist-tags`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return;
    }

    const body: unknown = await response.json();
    const latest =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).latest
        : undefined;
    if (typeof latest !== "string" || !VERSION_PATTERN.test(latest)) {
      return;
    }

    run.writeState(
      serializeState({ checkedAt: run.now(), latestVersion: latest, succeeded: true }),
    );
  } catch {
    // Offline, a proxy, a read-only home: the next due check tries again.
  }
}

function serializeState(state: UpdateCheckState): string {
  return `${JSON.stringify(state)}\n`;
}
