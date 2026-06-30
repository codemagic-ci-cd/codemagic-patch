import type { ReleaseJobId } from "../domain";

export interface TrackedReconcileExecutor<Result> {
  execute(jobId: ReleaseJobId): Promise<Result>;
  executeInBackground(jobId: ReleaseJobId): void;
  waitForIdle(): Promise<void>;
}

export function createTrackedReconcileExecutor<Result>(
  handler: (jobId: ReleaseJobId) => Promise<Result>,
  options: {
    onBackgroundError?: (error: unknown, jobId: ReleaseJobId) => void;
  } = {},
): TrackedReconcileExecutor<Result> {
  const inflight = new Set<Promise<Result>>();

  const track = (jobId: ReleaseJobId): Promise<Result> => {
    const promise = handler(jobId).finally(() => {
      inflight.delete(promise);
    });

    inflight.add(promise);

    return promise;
  };

  return {
    execute(jobId) {
      return track(jobId);
    },

    executeInBackground(jobId) {
      void track(jobId).catch((error) => {
        options.onBackgroundError?.(error, jobId);
      });
    },

    async waitForIdle() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}
