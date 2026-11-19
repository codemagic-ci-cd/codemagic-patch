import { WEBHOOK_CLAIM_BATCH_SIZE, type WebhookDeliverer } from "../webhooks/deliver";
import type { RuntimeLogger } from "./logger";

export const WEBHOOK_DELIVERY_INTERVAL_MS = 5_000;
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface WebhookDeliveryTimer {
  /** Runs the loop now rather than at the next tick. Safe to call at any time. */
  poke(): void;
  start(): void;
  /** Resolves once the requests in flight have settled. Terminal. */
  stop(): Promise<void>;
}

/**
 * Drives webhook delivery (`server/specs/webhooks-tech-spec.md`, Delivery →
 * The delivery loop): a run on start, one every `intervalMs`, and one on
 * `poke()`. A run drains the queue batch by batch. A run that is still going
 * when the next tick or poke arrives is left alone and asked to go round once
 * more. The retention sweep rides on the same loop, at most once an hour.
 * `intervalMs <= 0` disables the timer.
 */
export function createWebhookDeliveryTimer(options: {
  deleteExpiredEvents(before: Date): Promise<number>;
  deliverer: WebhookDeliverer;
  intervalMs?: number;
  logger: RuntimeLogger;
  now?: () => Date;
}): WebhookDeliveryTimer {
  const { deliverer, logger } = options;
  const intervalMs = options.intervalMs ?? WEBHOOK_DELIVERY_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let inflightRun: Promise<void> | null = null;
  let runAgain = false;
  let started = false;
  let stopping = false;
  let lastRetentionSweepAt = 0;

  const drain = async (): Promise<void> => {
    while (!stopping && (await deliverer.runOnce()) >= WEBHOOK_CLAIM_BATCH_SIZE) {
      // A full batch means more may be due; go again without waiting.
    }

    const at = now().getTime();
    if (!stopping && at - lastRetentionSweepAt >= RETENTION_SWEEP_INTERVAL_MS) {
      lastRetentionSweepAt = at;
      const deleted = await options.deleteExpiredEvents(new Date(at - WEBHOOK_EVENT_RETENTION_MS));
      if (deleted > 0) {
        logger.info(
          { deleted, event: "webhook.events_expired" },
          "deleted webhook events past retention",
        );
      }
    }
  };

  const run = (): void => {
    if (stopping || !started) {
      return;
    }
    if (inflightRun) {
      runAgain = true;
      return;
    }

    inflightRun = drain()
      .catch((error: unknown) => {
        logger.error(
          { err: error, event: "webhook.delivery_run_failed" },
          "webhook delivery run failed; the next run retries",
        );
      })
      .finally(() => {
        inflightRun = null;
        // A tick or poke that arrived mid-run may have queued work this run
        // had already looked past.
        if (runAgain) {
          runAgain = false;
          run();
        }
      });
  };

  return {
    poke: run,

    start() {
      if (intervalMs <= 0 || started) {
        return;
      }

      started = true;
      run();
      timer = setInterval(run, intervalMs);
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
