// Release-status marker. Visual contract: a coloured led + grey label, not a
// filled pill. Status is conveyed by the text label + led glyph, never color
// alone. Worker-job status renders via JobBadge, NOT this chip, so the two
// fields must stay visually distinct.

import { clsx } from "clsx";

import type { ReleaseStatus } from "../../model/release";
import {
  STATUS_DOT_TONE,
  STATUS_LABEL,
  STATUS_LED,
  STATUS_LED_LIVE,
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
    uploaded: { label: "Uploaded", tone: STATUS_DOT_TONE.slate, live: false },
    processing: { label: "Processing", tone: STATUS_DOT_TONE.blue, live: true },
    published: { label: "Published", tone: STATUS_DOT_TONE.green, live: false },
    failed: { label: "Failed", tone: STATUS_DOT_TONE.red, live: false },
    disabled: { label: "Disabled", tone: STATUS_DOT_TONE.muted, live: false },
  };

export interface StatusChipProps {
  status: ReleaseStatus;
}

export function StatusChip({ status }: StatusChipProps) {
  const presentation = RELEASE_STATUS_PRESENTATION[status];
  return (
    <span className={STATUS_LABEL}>
      <span
        className={clsx(
          STATUS_LED,
          presentation.tone,
          presentation.live && STATUS_LED_LIVE,
        )}
        aria-hidden="true"
      />
      {presentation.label}
    </span>
  );
}
