/**
 * JobQueueAdapter — worker job dispatch abstraction.
 *
 * Determines how `reconcileRelease(jobId)` is invoked. The worker
 * function code is identical across all adapters; only the dispatch
 * mechanism changes.
 *
 * Implementations (from server-tech-spec.md):
 *   - InProcessJobQueue (MODE=all): calls reconcileRelease() via
 *     setImmediate() in the same process.
 *   - Push-based adapter (MODE=api+worker): enqueues a message to
 *     Cloud Tasks / SQS / Azure Queue, which POSTs to the worker
 *     service's HTTP endpoint.
 */

import type { ReleaseJobId } from "../domain/types";

export interface EnqueueOptions {
  /**
   * Optional delay before the job is dispatched.
   *
   * Used for retry backoff in MODE=all. Immediate dispatch remains the default.
   */
  delayMs?: number;
}

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface JobQueueAdapter {
  /**
   * Dispatch a release job to the worker.
   * Called by the API server after persisting a release_job row.
   *
   * The adapter must ensure at-least-once delivery. Duplicate delivery
   * is safe because the reconciler is idempotent.
   */
  enqueue(jobId: ReleaseJobId, options?: EnqueueOptions): Promise<void>;

  /**
   * Start listening for / processing jobs.
   * Called once at process startup.
   *
   * For the in-process adapter, this runs the startup sweep
   * (re-claiming jobs with expired leases).
   * For push-based adapters, this is a no-op.
   */
  start(): Promise<void>;

  /**
   * Graceful shutdown: stop accepting new jobs and wait for
   * in-flight work to complete.
   */
  stop(): Promise<void>;
}
