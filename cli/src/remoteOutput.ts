/**
 * How the selfhost scripts' output reaches the user.
 *
 * The policy, one renderer for install / backup / restore / upgrade:
 *
 * - The scripts' own `[selfhost]` lines (common.sh's `log_selfhost` /
 *   `warn_selfhost` / `fail_selfhost`) are a de-facto stable contract. Known
 *   ones become the wizard's step labels; the phrases are pinned by test
 *   fixtures, so a script wording change fails a test instead of silently
 *   degrading the UX.
 * - Everything else — docker build output, container logs — repaints the
 *   *animating* line only, so a twenty-minute build never looks hung even
 *   while no milestone matches. Milestone mapping is a bonus, not a dependency.
 * - The complete raw output always goes to a log file, byte for byte. The view
 *   is summarized; the record never is.
 * - On failure the pretty layer steps aside: the script's own `FAIL:` message,
 *   the last raw lines verbatim, and the log path. Failures are never
 *   summarized — the pretty layer exists for the happy path, and diagnosis is
 *   exactly when it must not be in the way.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveConfigHome } from "./configStore";
import type { Progress } from "./progress";

export type RemoteMilestone = {
  /** Beginner-plain step label shown in place of the script's own wording. */
  label: string;
  /** Substring of the script's `[selfhost]` line that identifies the step. */
  match: string;
};

const SELFHOST_PREFIX = "[selfhost] ";
const WARN_PREFIX = "WARN: ";
const FAIL_PREFIX = "FAIL: ";

const DEFAULT_TAIL_LINES = 30;
const DEFAULT_WIDTH = 80;

export type RemoteOutputRendererOptions = {
  milestones?: readonly RemoteMilestone[];
  /** Receives every chunk exactly as it arrived, for the log file. */
  onRawChunk?: (chunk: string) => void;
  /**
   * The prefix the script's own narration carries, `[selfhost] ` unless a
   * script brands its lines differently (`[local-eval] `).
   */
  prefix?: string;
  progress: Progress;
  /** How many raw lines the failure tail keeps. */
  tailLines?: number;
  /** Terminal width the liveness line is truncated to. */
  width?: number;
};

export type RemoteOutputRenderer = {
  /** Flushes a trailing partial line. Call once the process has exited. */
  end: () => void;
  /**
   * The script's own last `FAIL:` message, when it produced one. Null for a
   * process that died without one (killed, ssh transport failure) — the caller
   * then reports the exit code instead of inventing a cause.
   */
  failureMessage: () => string | null;
  /** The last raw lines, oldest first, for the failure report. */
  tail: () => string[];
  write: (chunk: string) => void;
};

export function createRemoteOutputRenderer(
  options: RemoteOutputRendererOptions,
): RemoteOutputRenderer {
  const milestones = options.milestones ?? [];
  const prefix = options.prefix ?? SELFHOST_PREFIX;
  const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
  const width = options.width ?? DEFAULT_WIDTH;

  const tail: string[] = [];
  let pending = "";
  let failureMessage: string | null = null;

  const consumeLine = (raw: string) => {
    const line = raw.replace(/\s+$/u, "");
    if (line.length === 0) {
      return;
    }

    tail.push(line);
    if (tail.length > tailLines) {
      tail.shift();
    }

    if (!line.startsWith(prefix)) {
      options.progress.detail(truncateToWidth(line, width));
      return;
    }

    const body = line.slice(prefix.length);

    if (body.startsWith(FAIL_PREFIX)) {
      // Recorded, not rendered: the caller decides how a failure is presented,
      // and rendering it here would draw it twice.
      failureMessage = body.slice(FAIL_PREFIX.length);
      return;
    }

    if (body.startsWith(WARN_PREFIX)) {
      options.progress.warn(body.slice(WARN_PREFIX.length));
      return;
    }

    const milestone = milestones.find((candidate) =>
      body.includes(candidate.match),
    );
    if (milestone !== undefined) {
      options.progress.write(milestone.label);
      return;
    }

    // An unmapped `[selfhost]` line is still the script narrating itself, so it
    // is better liveness than a docker layer id — but it does not settle the
    // step, because the wizard's step boundaries are the mapped milestones.
    options.progress.detail(truncateToWidth(body, width));
  };

  return {
    end() {
      if (pending.length > 0) {
        const last = pending;
        pending = "";
        consumeLine(last);
      }
    },
    failureMessage: () => failureMessage,
    tail: () => [...tail],
    write(chunk) {
      options.onRawChunk?.(chunk);

      // Split on \r as well as \n: docker build progress repaints a single
      // line with carriage returns, and treating the whole burst as one
      // unterminated line would freeze the liveness display for minutes.
      pending += chunk;
      const parts = pending.split(/\r\n|\r|\n/u);
      pending = parts.pop() ?? "";
      for (const part of parts) {
        consumeLine(part);
      }
    },
  };
}

function truncateToWidth(line: string, width: number): string {
  // The spinner's own frame and gutter take a few columns; leaving room for
  // them is what keeps the detail line from wrapping and tearing the spinner.
  const budget = Math.max(20, width - 12);
  return line.length <= budget ? line : `${line.slice(0, budget - 1)}…`;
}

/**
 * Failure output. Deliberately plain text rather than a rendered tree: this is
 * the one moment where the user needs the script's own words, unedited.
 */
export function renderRemoteFailure(input: {
  exitCode: number | null;
  failureMessage: string | null;
  logPath?: string;
  signal: string | null;
  /** What the script is called when it died without a `FAIL:` line. */
  subject?: string;
  tail: readonly string[];
  /** Heading over the raw tail. */
  tailHeading?: string;
}): string {
  const lines: string[] = [];
  const subject = input.subject ?? "the remote script";

  if (input.failureMessage !== null) {
    lines.push(input.failureMessage);
  } else if (input.signal !== null) {
    lines.push(`${subject} was terminated by ${input.signal}`);
  } else {
    lines.push(`${subject} exited with status ${String(input.exitCode ?? 1)}`);
  }

  if (input.tail.length > 0) {
    lines.push(
      "",
      input.tailHeading ?? "Last output from the server:",
      ...input.tail,
    );
  }

  if (input.logPath !== undefined) {
    lines.push("", `Full log: ${input.logPath}`);
  }

  return lines.join("\n");
}

export type RemoteLog = {
  append: (chunk: string) => void;
  close: () => Promise<void>;
  path: string;
};

export function resolveRemoteLogDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolveConfigHome(env), "logs");
}

/** `2026-08-27T14-02-11Z` — filename-safe and sorts chronologically. */
export function formatRemoteLogTimestamp(now: number): string {
  return new Date(now).toISOString().replace(/:/gu, "-").replace(/\..*$/u, "Z");
}

export async function createRemoteLog(input: {
  env: Record<string, string | undefined>;
  name: string;
  now: number;
}): Promise<RemoteLog> {
  const path = join(
    resolveRemoteLogDirectory(input.env),
    `${formatRemoteLogTimestamp(input.now)}-${input.name}.log`,
  );
  // 0700/0600: the log holds whatever the scripts printed about a deployment
  // the user owns, and nothing else on the machine needs to read it.
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const stream: WriteStream = createWriteStream(path, { mode: 0o600 });

  // The file is opened lazily, so a directory the CLI cannot write to fails
  // *after* this function would otherwise have returned a usable log — as an
  // `error` event with no listener, which terminates the process in the middle
  // of the remote run the log was only ever recording. So the log does not
  // exist until the file is really open, and the caller's fallback to
  // streamed-only output gets to do its job.
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.off("open", onOpen);
      stream.destroy();
      reject(error);
    };

    stream.once("open", onOpen);
    stream.once("error", onError);
  });

  // Past open the same rule still holds, and there is no longer anywhere to
  // fall back to: a disk that fills during a twenty-minute build truncates the
  // record, and must not take the install with it.
  stream.on("error", () => {});

  return {
    append(chunk) {
      stream.write(chunk);
    },
    close: () =>
      new Promise((resolve) => {
        stream.end(resolve);
      }),
    path,
  };
}

/**
 * Milestone tables. Each `match` is a substring of a line the script really
 * prints today; `cli/test/selfhost-remote-output.test.ts` replays recorded
 * script output through these, so a wording change in `scripts/selfhost/`
 * fails a test rather than silently dropping the step from the transcript.
 */
/**
 * `scripts/local-eval/up.sh`, whose lines carry the `[local-eval]` prefix.
 * The seed wait between readiness and "ready" prints nothing of its own.
 */
export const LOCAL_EVAL_UP_MILESTONES: readonly RemoteMilestone[] = [
  {
    label: "starting the stack (the first run builds images, which takes a few minutes)",
    match: "bringing up the evaluation stack",
  },
  { label: "waiting for the stack to answer", match: "waiting for readiness" },
  { label: "the stack is ready", match: "evaluation stack is ready" },
] as const;

export const BACKUP_MILESTONES: readonly RemoteMilestone[] = [
  { label: "preparing the backup", match: "writing backup to" },
  {
    label: "pausing the server for a consistent snapshot",
    match: "stopping the server to quiesce writes during backup",
  },
  { label: "database", match: "exporting PostgreSQL" },
  { label: "release files", match: "exporting MinIO bucket" },
  { label: "restarting the server", match: "restarting server after backup" },
  // backup.sh health-gates the restart it performs (the plan's restart-honesty
  // requirement): completion still keys on the exit code, but the step the
  // user watches is the script's own health check, never an optimistic label.
  { label: "checking the server is back", match: "API health is reachable" },
] as const;

export const INSTALL_MILESTONES: readonly RemoteMilestone[] = [
  // The trailing slash is load-bearing on the first two: install.sh prints an
  // absolute env-file path here, and its closing line ("the admin account is
  // created on first sign-in by ...") contains the bare word otherwise.
  { label: "writing the server's settings", match: "created /" },
  { label: "correcting the server's settings", match: "repaired /" },
  { label: "reusing the settings from the last run", match: "reusing existing" },
  {
    label: "checking the Cloudflare token",
    match: "verifying Cloudflare cache-purge access",
  },
  {
    label: "checking the CloudFront key",
    match: "verifying CloudFront invalidation access",
  },
  // The long one — twenty minutes on a cold cache. It stays visibly alive
  // through the renderer's detail line rather than through a milestone.
  { label: "building the server (this takes a while)", match: "building images" },
  { label: "starting the server", match: "starting self-host stack" },
  {
    label: "waiting for the HTTPS certificate",
    match: "waiting for public HTTPS",
  },
  { label: "your server is answering", match: "API HTTPS is reachable" },
  { label: "finishing up", match: "OAuth sign-in enforced" },
] as const;

export const RESTORE_MILESTONES: readonly RemoteMilestone[] = [
  {
    label: "saving a safety backup of the current data",
    match: "creating a pre-restore safety backup",
  },
  { label: "stopping the server", match: "stopping stack" },
  { label: "restoring the database", match: "restoring PostgreSQL" },
  { label: "restoring release files", match: "restoring MinIO bucket" },
  { label: "starting the server", match: "starting full stack" },
  {
    label: "checking the restored server works",
    match: "API health is reachable",
  },
] as const;

export const UPGRADE_MILESTONES: readonly RemoteMilestone[] = [
  {
    label: "backing up before the upgrade",
    match: "creating a pre-upgrade backup",
  },
  { label: "downloading the new server image", match: "pulling target server image" },
  { label: "building images", match: "rebuilding" },
  { label: "restarting the server", match: "recreating stack" },
  { label: "checking the server works", match: "API health is reachable" },
] as const;
