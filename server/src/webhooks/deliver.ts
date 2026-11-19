import type { WebhookDeliveryError } from "../domain";
import type { ClaimedWebhookDelivery, WebhookRepository } from "../repositories";
import { nextWebhookAttemptAt, WEBHOOK_MAX_ATTEMPTS } from "./backoff";
import {
  sendWebhookRequest,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  type WebhookSender,
} from "./send";
import { signWebhookRequest } from "./signature";
import {
  checkWebhookUrl,
  resolveWebhookTarget,
  type WebhookLookup,
  type WebhookTargetOptions,
} from "./target";

/** `server/specs/webhooks-tech-spec.md`, Delivery → The delivery loop. */
export const WEBHOOK_CLAIM_BATCH_SIZE = 20;
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;
export const WEBHOOK_MAX_IN_FLIGHT = 5;

export interface WebhookDelivererOptions {
  lookup?: WebhookLookup;
  now?: () => Date;
  onAttempt?: (attempt: WebhookAttemptReport) => void;
  repository: WebhookRepository;
  send?: WebhookSender;
  /** For the `user-agent` header; null leaves the version off. */
  serverVersion: string | null;
  targetOptions: WebhookTargetOptions;
  timeoutMs?: number;
}

export interface WebhookAttemptReport {
  attemptCount: number;
  deliveryId: string;
  endpointId: string;
  error: WebhookDeliveryError | null;
  eventType: string;
  responseStatus: number | null;
  /** False when this was the last attempt, or the delivery succeeded. */
  willRetry: boolean;
}

export interface WebhookDeliverer {
  /**
   * Claims one batch of due deliveries and attempts each. Returns how many it
   * claimed, so a caller can tell a full batch from a drained queue.
   */
  runOnce(): Promise<number>;
}

type AttemptOutcome =
  | { kind: "succeeded"; status: number }
  | { kind: "failed"; error: WebhookDeliveryError; status: number | null; terminal: boolean }
  /** The claim no longer holds the delivery; whoever does will complete it. */
  | { kind: "superseded" };

const TIMED_OUT = Symbol("timed out");

export function createWebhookDeliverer(options: WebhookDelivererOptions): WebhookDeliverer {
  const now = options.now ?? (() => new Date());
  const send = options.send ?? sendWebhookRequest;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  const userAgent = options.serverVersion
    ? `Codemagic-Patch-Webhooks/${options.serverVersion}`
    : "Codemagic-Patch-Webhooks";

  async function attempt(delivery: ClaimedWebhookDelivery): Promise<AttemptOutcome> {
    // Read where to send now, not at claim time: a delivery can wait behind
    // others for a free slot, and the endpoint may have been repointed, had
    // its secret rotated, or been disabled or deleted in the meantime.
    const target = await options.repository.readDeliveryTarget({
      claimToken: delivery.claimToken,
      deliveryId: delivery.deliveryId,
    });
    if (target === null) {
      return { kind: "superseded" };
    }
    if (target.endpointStatus !== "active") {
      return { error: "endpoint_disabled", kind: "failed", status: null, terminal: true };
    }

    // The registration rules again, as they stand today: an endpoint saved
    // while private targets were allowed must stop receiving over http, or at
    // a private literal, once the operator turns that off.
    const allowed = checkWebhookUrl(target.url, options.targetOptions);
    if (!allowed.ok) {
      return { error: "blocked_address", kind: "failed", status: null, terminal: true };
    }
    const url = new URL(allowed.url);

    // One deadline for the whole attempt. Resolving the host counts against
    // it, so a slow lookup cannot hold a slot past the lease.
    const startedAt = Date.now();
    const resolution = await withinDeadline(
      resolveWebhookTarget(url, { ...options.targetOptions, lookup: options.lookup }),
      timeoutMs,
    );
    if (resolution === TIMED_OUT) {
      return { error: "timeout", kind: "failed", status: null, terminal: false };
    }
    if (!resolution.ok) {
      return resolution.reason === "blocked_address"
        ? { error: "blocked_address", kind: "failed", status: null, terminal: true }
        : { error: "network_error", kind: "failed", status: null, terminal: false };
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return { error: "timeout", kind: "failed", status: null, terminal: false };
    }

    const timestampSeconds = Math.floor(now().getTime() / 1000);
    const result = await send({
      body: delivery.payload,
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent,
        "webhook-id": delivery.eventId,
        "webhook-signature": signWebhookRequest({
          body: delivery.payload,
          id: delivery.eventId,
          secret: target.secret,
          timestampSeconds,
        }),
        "webhook-timestamp": String(timestampSeconds),
      },
      targets: resolution.targets,
      timeoutMs: remainingMs,
      url,
    });

    if (result.kind === "error") {
      return { error: result.error, kind: "failed", status: null, terminal: false };
    }
    if (result.status >= 200 && result.status < 300) {
      return { kind: "succeeded", status: result.status };
    }

    return { error: "http_error", kind: "failed", status: result.status, terminal: false };
  }

  async function deliver(delivery: ClaimedWebhookDelivery): Promise<void> {
    let outcome: AttemptOutcome;
    try {
      outcome = await attempt(delivery);
    } catch {
      // Whatever went wrong, the delivery keeps its place in the schedule.
      outcome = { error: "network_error", kind: "failed", status: null, terminal: false };
    }
    if (outcome.kind === "superseded") {
      return;
    }

    const completedAt = now();
    const base = {
      claimToken: delivery.claimToken,
      deliveryId: delivery.deliveryId,
      now: completedAt,
    };

    if (outcome.kind === "succeeded") {
      await options.repository.markDeliverySucceeded({ ...base, responseStatus: outcome.status });
      options.onAttempt?.(report(delivery, null, outcome.status, false));
      return;
    }

    const nextAttemptAt = outcome.terminal
      ? null
      : nextWebhookAttemptAt(delivery.attemptCount, completedAt);
    await options.repository.markDeliveryFailed({
      ...base,
      error: outcome.error,
      nextAttemptAt,
      responseStatus: outcome.status,
    });
    options.onAttempt?.(report(delivery, outcome.error, outcome.status, nextAttemptAt !== null));
  }

  return {
    async runOnce() {
      const claimed = await options.repository.claimDueDeliveries({
        leaseMs: WEBHOOK_CLAIM_LEASE_MS,
        limit: WEBHOOK_CLAIM_BATCH_SIZE,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        now: now(),
      });

      // One delivery failing to record its result must not stop the others,
      // and must not let this call return while requests are still out: the
      // caller takes the return as "nothing in flight" and may close the pool.
      const errors: unknown[] = [];
      let next = 0;
      const worker = async () => {
        while (next < claimed.length) {
          const delivery = claimed[next];
          next += 1;
          if (delivery) {
            try {
              await deliver(delivery);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(WEBHOOK_MAX_IN_FLIGHT, claimed.length) }, worker),
      );

      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `could not record the result of ${errors.length} webhook ${
            errors.length === 1 ? "delivery" : "deliveries"
          }; their leases will expire and they will be attempted again`,
        );
      }

      return claimed.length;
    },
  };
}

/** `promise`, or `TIMED_OUT` if it has not settled within `ms`. */
async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function report(
  delivery: ClaimedWebhookDelivery,
  error: WebhookDeliveryError | null,
  responseStatus: number | null,
  willRetry: boolean,
): WebhookAttemptReport {
  return {
    attemptCount: delivery.attemptCount,
    deliveryId: delivery.deliveryId,
    endpointId: delivery.endpointId,
    error,
    eventType: delivery.eventType,
    responseStatus,
    willRetry,
  };
}
