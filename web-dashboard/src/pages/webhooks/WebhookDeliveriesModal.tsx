// One webhook's delivery history: a row per event, newest first, with the
// latest attempt's result. A row opens the exact body that was sent, and a
// delivery that has stopped retrying on its own can be sent again.

import { useState } from "react";

import {
  useRedeliverWebhook,
  useWebhookDeliveries,
  useWebhookDelivery,
  WEBHOOK_DELIVERY_PAGE_SIZE,
} from "../../api/hooks/webhooks";
import { Modal } from "../../components/overlay/Modal";
import { useToast } from "../../components/overlay/ToastProvider";
import { buttonVariants } from "../../components/ui/Button";
import { CODEBLOCK } from "../../components/ui/codeblock";
import { ErrorState } from "../../components/ui/ErrorState";
import { INPUT, INPUT_STATE, SELECT_EXTRA } from "../../components/ui/form";
import { Skeleton } from "../../components/ui/Skeleton";
import { TBL, TBL_TD, TBL_TH, TBL_TR, TBL_WRAP } from "../../components/ui/table";
import { formatDateTime, formatRelativeTime } from "../../model/format";
import {
  canRedeliver,
  describeDeliveryResult,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "../../model/webhook";
import { DeliveryStatusChip, problemMessage } from "./shared";

const STATUS_FILTERS: ReadonlyArray<{ label: string; value: WebhookDeliveryStatus | "all" }> = [
  { label: "All deliveries", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Delivered", value: "succeeded" },
  { label: "Failed", value: "failed" },
];

interface WebhookDeliveriesModalProps {
  onClose: () => void;
  teamId: string;
  webhook: Webhook;
}

export function WebhookDeliveriesModal({ onClose, teamId, webhook }: WebhookDeliveriesModalProps) {
  const toast = useToast();
  const [status, setStatus] = useState<WebhookDeliveryStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const [openDeliveryId, setOpenDeliveryId] = useState<string | null>(null);
  const deliveries = useWebhookDeliveries(webhook.id, { offset, status });
  const redeliver = useRedeliverWebhook(teamId);

  const total = deliveries.data?.total ?? 0;
  const shown = deliveries.data?.deliveries.length ?? 0;

  const handleRedeliver = (delivery: WebhookDelivery) => {
    redeliver.mutate(
      { deliveryId: delivery.id, webhookId: webhook.id },
      {
        onError: (error) => toast.error(problemMessage(error)),
        onSuccess: () =>
          toast.success("Delivery queued again", {
            description: "It keeps its event id, so a receiver that saw it can skip it.",
          }),
      },
    );
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Deliveries"
      description={webhook.url}
      footer={
        <button type="button" className={buttonVariants({ intent: "subtle" })} onClick={onClose}>
          Close
        </button>
      }
    >
      <label className="mb-3.5 block max-w-[240px]">
        <span className="sr-only">Filter by status</span>
        <select
          className={`${INPUT} ${INPUT_STATE.normal} ${SELECT_EXTRA}`}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as WebhookDeliveryStatus | "all");
            setOffset(0);
            setOpenDeliveryId(null);
          }}
        >
          {STATUS_FILTERS.map((filter) => (
            <option key={filter.value} value={filter.value}>
              {filter.label}
            </option>
          ))}
        </select>
      </label>

      {deliveries.isPending ? (
        <div role="status" aria-label="Loading deliveries">
          <Skeleton variant="line" />
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : deliveries.isError ? (
        <ErrorState
          error={deliveries.error}
          onRetry={() => {
            void deliveries.refetch();
          }}
        />
      ) : shown === 0 ? (
        <p className="text-[14px] text-fg-3">
          {status === "all"
            ? "Nothing has been sent to this webhook yet. Use Send test to try it."
            : "No deliveries match this filter."}
        </p>
      ) : (
        <>
          <div className={TBL_WRAP}>
            <table className={TBL}>
              <thead>
                <tr>
                  <th className={TBL_TH}>Event</th>
                  <th className={TBL_TH}>Status</th>
                  <th className={TBL_TH}>Result</th>
                  <th className={TBL_TH}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.deliveries.map((delivery) => (
                  <DeliveryRows
                    key={delivery.id}
                    delivery={delivery}
                    open={openDeliveryId === delivery.id}
                    onToggle={() =>
                      setOpenDeliveryId((current) =>
                        current === delivery.id ? null : delivery.id,
                      )
                    }
                    onRedeliver={() => handleRedeliver(delivery)}
                    redeliverPending={redeliver.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3.5 flex items-center justify-between text-[13px] text-fg-3">
            <span>
              {offset + 1}–{offset + shown} of {total}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className={buttonVariants({ intent: "ghost", size: "sm" })}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - WEBHOOK_DELIVERY_PAGE_SIZE))}
              >
                Newer
              </button>
              <button
                type="button"
                className={buttonVariants({ intent: "ghost", size: "sm" })}
                disabled={offset + shown >= total}
                onClick={() => setOffset(offset + WEBHOOK_DELIVERY_PAGE_SIZE)}
              >
                Older
              </button>
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

interface DeliveryRowsProps {
  delivery: WebhookDelivery;
  onRedeliver: () => void;
  onToggle: () => void;
  open: boolean;
  redeliverPending: boolean;
}

function DeliveryRows({ delivery, onRedeliver, onToggle, open, redeliverPending }: DeliveryRowsProps) {
  const result = describeDeliveryResult(delivery);

  return (
    <>
      <tr className={TBL_TR}>
        <td className={TBL_TD}>
          <span className="font-mono text-[12.5px] font-semibold">{delivery.eventType}</span>
          <span
            className="block text-[12.5px] text-fg-3"
            title={formatDateTime(delivery.createdAt)}
          >
            {formatRelativeTime(delivery.createdAt)}
          </span>
        </td>
        <td className={TBL_TD}>
          <DeliveryStatusChip status={delivery.status} />
        </td>
        <td className={`${TBL_TD} whitespace-nowrap`}>
          <span className="text-[13px]">{result ?? "Not attempted yet"}</span>
          <span className="block text-[12.5px] text-fg-3">
            {describeAttempts(delivery)}
          </span>
        </td>
        <td className={`${TBL_TD} whitespace-nowrap text-right`}>
          <button
            type="button"
            className={buttonVariants({ intent: "subtle", size: "sm" })}
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? "Hide" : "Details"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          {/* max-w-0: a wide body must scroll inside its block, not widen the table. */}
          <td className={`${TBL_TD} max-w-0`} colSpan={4}>
            <DeliveryBody deliveryId={delivery.id} webhookId={delivery.webhookId} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[12.5px] text-fg-3">{delivery.id}</span>
              {canRedeliver(delivery) ? (
                <button
                  type="button"
                  className={buttonVariants({ intent: "ghost", size: "sm" })}
                  disabled={redeliverPending}
                  onClick={onRedeliver}
                >
                  Send again
                </button>
              ) : (
                <span className="text-[13px] text-fg-3">
                  Still retrying. It can be sent again once it has finished.
                </span>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** "2 attempts", plus when the next one is due while the delivery is still retrying. */
function describeAttempts(delivery: WebhookDelivery): string {
  const attempts = `${delivery.attemptCount} ${delivery.attemptCount === 1 ? "attempt" : "attempts"}`;
  if (delivery.status === "pending" && delivery.attemptCount > 0 && delivery.nextAttemptAt !== null) {
    // An absolute time: the relative formatter reads any future time as "just now".
    return `${attempts} · next at ${formatDateTime(delivery.nextAttemptAt)}`;
  }
  return attempts;
}

function DeliveryBody({ deliveryId, webhookId }: { deliveryId: string; webhookId: string }) {
  const detail = useWebhookDelivery(webhookId, deliveryId);

  if (detail.isPending) {
    return <Skeleton variant="line" />;
  }
  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }

  return (
    <div className={`${CODEBLOCK} max-h-[320px]`}>
      <code className="whitespace-pre">{JSON.stringify(detail.data.payload, null, 2)}</code>
    </div>
  );
}
