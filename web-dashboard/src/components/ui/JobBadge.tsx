// Worker-job status badge (WorkerJobPanel + release rows).
// Visual contract: the `.status` pill with the job palette —
// `st-queued`/`st-running live`/`st-succeeded`/`st-failed`/`st-dead`, ported
// to the statusPill utility literals. Distinct from StatusChip by convention:
// lowercase verbatim labels (`dead_letter`, not "Dead letter") plus the
// job-only queued/dead-letter colors; a visually hidden "job" prefix keeps the
// distinction for screen readers too.

import { clsx } from "clsx";

import type { ReleaseJobStatus } from "../../model/release";
import {
  STATUS_LED,
  STATUS_LED_LIVE,
  STATUS_PILL,
  STATUS_TONE,
} from "./statusPill";

interface JobPresentation {
  label: string;
  tone: string;
  /** Pulsing led while the worker is actively processing (`.live`). */
  live: boolean;
}

const JOB_STATUS_PRESENTATION: Record<ReleaseJobStatus, JobPresentation> = {
  queued: { label: "queued", tone: STATUS_TONE.amber, live: false },
  running: { label: "running", tone: STATUS_TONE.blue, live: true },
  succeeded: { label: "succeeded", tone: STATUS_TONE.green, live: false },
  failed: { label: "failed", tone: STATUS_TONE.red, live: false },
  dead_letter: { label: "dead_letter", tone: STATUS_TONE.dead, live: false },
};

export interface JobBadgeProps {
  status: ReleaseJobStatus;
}

export function JobBadge({ status }: JobBadgeProps) {
  const presentation = JOB_STATUS_PRESENTATION[status];
  return (
    <span className={clsx(STATUS_PILL, presentation.tone)}>
      <span
        className={clsx(STATUS_LED, presentation.live && STATUS_LED_LIVE)}
        aria-hidden="true"
      />
      <span className="sr-only">job </span>
      {presentation.label}
    </span>
  );
}
