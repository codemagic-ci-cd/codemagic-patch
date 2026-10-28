import type { DatabasePool } from "../db";
import { foldExpiredMetricDays } from "../repositories";
import type { RuntimeLogger } from "./logger";

export interface MetricFoldTimer {
  start(): void;
  /**
   * Resolves once the day in progress, if any, has committed. Terminal: a
   * stopped timer does not fold again, even after another `start()`.
   */
  stop(): Promise<void>;
}

/**
 * Runs `foldExpiredMetricDays` once on start and then every `intervalMs`.
 *
 * A run that is still going when the next tick fires is left alone rather
 * than joined by a second one: the watermark lock would only make the second
 * wait. A failed run is logged and the next tick retries; every committed day
 * stays folded. `intervalMs <= 0` disables folding.
 */
export function createMetricFoldTimer(options: {
  intervalMs: number;
  logger: RuntimeLogger;
  pool: DatabasePool;
}): MetricFoldTimer {
  const { intervalMs, logger, pool } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inflightRun: Promise<void> | null = null;
  let stopping = false;

  const runFold = (): void => {
    if (inflightRun || stopping) {
      return;
    }

    inflightRun = foldExpiredMetricDays(pool, {
      now: new Date(),
      onDayFolded(result) {
        logger.info(
          {
            day: result.day,
            deletedEventCounts: result.deletedEventCounts,
            durationMs: result.durationMs,
            event: "metric_fold.day_folded",
          },
          "folded a day of raw metric events into daily aggregates",
        );
      },
      shouldStop: () => stopping,
    })
      .then(
        () => undefined,
        (error: unknown) => {
          logger.error(
            { err: error, event: "metric_fold.failed" },
            "metric fold failed; the next run retries",
          );
        },
      )
      .finally(() => {
        inflightRun = null;
      });
  };

  return {
    start() {
      if (intervalMs <= 0 || timer) {
        return;
      }

      runFold();
      timer = setInterval(runFold, intervalMs);
      timer.unref();
    },

    async stop() {
      stopping = true;
      clearInterval(timer);
      timer = undefined;
      await inflightRun;
    },
  };
}
