/**
 * The retry schedule (`server/specs/webhooks-tech-spec.md`, Delivery →
 * Retries): the wait after the first failed attempt, the second, and so on.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  8 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** One first attempt plus one per delay. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/**
 * When to try again after attempt number `attemptCount` (1-based) failed at
 * `now`, or `null` when that was the last attempt.
 */
export function nextWebhookAttemptAt(attemptCount: number, now: Date): Date | null {
  const delayMs = WEBHOOK_RETRY_DELAYS_MS[attemptCount - 1];

  return delayMs === undefined ? null : new Date(now.getTime() + delayMs);
}
