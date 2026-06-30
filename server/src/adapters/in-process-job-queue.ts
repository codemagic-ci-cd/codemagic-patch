import type { ReleaseJobId } from "../domain";
import type { EnqueueOptions, JobQueueAdapter } from "./job-queue";

export interface InProcessJobQueueOptions {
  execute(jobId: ReleaseJobId): Promise<void> | void;
  onExecutionError?: (error: unknown, jobId: ReleaseJobId) => void;
  runStartupSweep?: () => Promise<void>;
}

export class InProcessJobQueue implements JobQueueAdapter {
  private readonly scheduled = new Set<{
    cancel: () => void;
    delayed: boolean;
    promise: Promise<void>;
  }>();
  private hasStarted = false;
  private stopping = false;

  constructor(private readonly options: InProcessJobQueueOptions) {}

  async enqueue(jobId: ReleaseJobId, options: EnqueueOptions = {}): Promise<void> {
    if (this.stopping) {
      throw new Error("job queue is stopping");
    }

    let started = false;
    let resolveScheduled!: () => void;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const delayMs = options.delayMs ?? 0;

    const run = () => {
      started = true;
      void Promise.resolve(this.options.execute(jobId))
        .catch((error) => {
          this.options.onExecutionError?.(error, jobId);
        })
        .finally(resolveScheduled);
    };

    const scheduledJob = {
      cancel: () => {
        if (started || !scheduledJob.delayed) {
          return;
        }

        started = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolveScheduled();
      },
      delayed: delayMs > 0,
      promise: new Promise<void>((resolve) => {
        resolveScheduled = resolve;

        if (delayMs > 0) {
          timeoutHandle = setTimeout(run, delayMs);
          return;
        }

        setImmediate(run);
      }).finally(() => {
        this.scheduled.delete(scheduledJob);
      }),
    };

    this.scheduled.add(scheduledJob);
  }

  async start(): Promise<void> {
    if (this.hasStarted) {
      return;
    }

    this.hasStarted = true;
    await this.options.runStartupSweep?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const scheduledJob of this.scheduled) {
      if (scheduledJob.delayed) {
        scheduledJob.cancel();
      }
    }
    await Promise.allSettled([...this.scheduled].map((scheduledJob) => scheduledJob.promise));
  }
}
