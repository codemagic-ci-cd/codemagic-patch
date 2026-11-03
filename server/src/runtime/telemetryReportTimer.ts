import type {
  TelemetryReporter,
  TelemetryReportResult,
} from "../app/telemetryReport";
import { formatUtcDay } from "../domain";
import type { RuntimeLogger } from "./logger";

export interface TelemetryReportTimer {
  start(): void;
  /**
   * Resolves once the report in flight, if any, has finished. Terminal: a
   * stopped timer does not report again, even after another `start()`.
   */
  stop(): Promise<void>;
}

export interface TelemetryReportTimerOptions {
  /** First attempt after `start()`; the default is uniform in [5, 15] minutes. */
  initialDelayMs?: number;
  logger: RuntimeLogger;
  now?: () => number;
  /** Uniform in [0, 1); only the initial delay uses it. */
  random?: () => number;
  reporter: TelemetryReporter;
  /** Interval between attempts after the first; the default is one hour. */
  tickMs?: number;
}

const MIN_INITIAL_DELAY_MS = 5 * 60 * 1000;
const MAX_INITIAL_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_TICK_MS = 60 * 60 * 1000;

/**
 * Sends the daily usage report once per UTC day: a first attempt 5–15
 * minutes after start, then one attempt per hourly tick while the day has
 * not been reported and no `Retry-After` wait is pending.
 *
 * The random initial delay keeps a fleet restarted together from reporting
 * together. State lives in memory only, so a restart may report a day twice;
 * the collector answers the repeat with 429, which is treated as a wait, not
 * an error. Both timers are `unref()`ed: a usage report never holds the
 * process open.
 */
export function createTelemetryReportTimer(
  options: TelemetryReportTimerOptions,
): TelemetryReportTimer {
  const { logger, reporter } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const initialDelayMs =
    options.initialDelayMs ??
    MIN_INITIAL_DELAY_MS +
      Math.floor(random() * (MAX_INITIAL_DELAY_MS - MIN_INITIAL_DELAY_MS));

  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let inflight: Promise<void> | null = null;
  let lastSentDay: string | null = null;
  let notBefore = 0;
  let disabled = false;
  let stopping = false;

  const clearTimers = (): void => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
    initialTimer = undefined;
    intervalTimer = undefined;
  };

  const settle = (today: string, result: TelemetryReportResult): void => {
    switch (result.outcome) {
      case "sent":
      case "rejected":
        lastSentDay = today;
        break;
      case "deferred":
        notBefore = now() + result.retryAfterMs;
        break;
      case "gone":
        disabled = true;
        clearTimers();
        break;
      case "failed":
        // Nothing to remember: the next tick simply tries again.
        break;
    }
  };

  const tick = (): void => {
    if (inflight || stopping || disabled) {
      return;
    }
    const startedAt = now();
    const today = formatUtcDay(new Date(startedAt));
    if (lastSentDay === today || startedAt < notBefore) {
      return;
    }

    inflight = reporter
      .report()
      .then(
        (result) => {
          settle(today, result);
        },
        (error: unknown) => {
          // The reporter resolves every failure into an outcome; a rejection
          // here is a bug, and it still must not take the timer down.
          logger.warn(
            { err: error, event: "telemetry.report_failed", outcome: "failed", reason: "unexpected" },
            "usage report attempt threw; the next tick retries",
          );
        },
      )
      .finally(() => {
        inflight = null;
      });
  };

  return {
    start() {
      if (initialTimer || intervalTimer || stopping || disabled) {
        return;
      }
      initialTimer = setTimeout(tick, initialDelayMs);
      initialTimer.unref();
      intervalTimer = setInterval(tick, tickMs);
      intervalTimer.unref();
    },

    async stop() {
      stopping = true;
      clearTimers();
      await inflight;
    },
  };
}
