// Small pieces the webhook screens share.

import { HttpProblemError } from "../../api/problem";
import { CHIP, CHIP_TONE } from "../../components/ui/chip";
import type { WebhookDeliveryStatus } from "../../model/webhook";

/** The most specific text a failed request carries, for an inline error slot. */
export function problemMessage(error: unknown): string {
  if (error instanceof HttpProblemError) {
    return error.detail ?? error.title ?? "The request was rejected.";
  }
  return "The request failed. Check your connection and try again.";
}

const DELIVERY_STATUS: Record<WebhookDeliveryStatus, { label: string; tone: string }> = {
  failed: { label: "Failed", tone: CHIP_TONE.red },
  pending: { label: "Pending", tone: CHIP_TONE.yellow },
  succeeded: { label: "Delivered", tone: CHIP_TONE.green },
};

export function DeliveryStatusChip({ status }: { status: WebhookDeliveryStatus }) {
  const { label, tone } = DELIVERY_STATUS[status];
  return <span className={`${CHIP} ${tone}`}>{label}</span>;
}
