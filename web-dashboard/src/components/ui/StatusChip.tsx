// Release-status chip. Visual contract: the `.status` pill — e.g. release rows
// (`<span class="status st-processing live"><span class="led"></span>Processing</span>`),
// ported to the statusPill utility literals. Status is conveyed by the text
// label + led glyph, never color alone. Worker-job status renders
// via JobBadge, NOT this chip — the two fields must stay visually distinct.

import { clsx } from "clsx";

import type { ReleaseStatus } from "../../model/release";
import {
  STATUS_LED,
  STATUS_LED_LIVE,
  STATUS_PILL,
  STATUS_TONE,
} from "./statusPill";

interface StatusPresentation {
  label: string;
  tone: string;
  /** Pulsing led for in-flight states (`.live`). */
  live: boolean;
}

// Capitalized labels for release rows.
const RELEASE_STATUS_PRESENTATION: Record<ReleaseStatus, StatusPresentation> =
  {
    uploaded: { label: "Uploaded", tone: STATUS_TONE.slate, live: false },
    processing: { label: "Processing", tone: STATUS_TONE.blue, live: true },
    published: { label: "Published", tone: STATUS_TONE.green, live: false },
    failed: { label: "Failed", tone: STATUS_TONE.red, live: false },
    disabled: { label: "Disabled", tone: STATUS_TONE.muted, live: false },
  };

export interface StatusChipProps {
  status: ReleaseStatus;
}

export function StatusChip({ status }: StatusChipProps) {
  const presentation = RELEASE_STATUS_PRESENTATION[status];
  return (
    <span className={clsx(STATUS_PILL, presentation.tone)}>
      <span
        className={clsx(STATUS_LED, presentation.live && STATUS_LED_LIVE)}
        aria-hidden="true"
      />
      {presentation.label}
    </span>
  );
}
