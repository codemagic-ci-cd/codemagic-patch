// Team webhooks screen (server/specs/webhooks-tech-spec.md).
// `webhook.manage`-gated: while useTeamRole resolves → skeleton; members
// without it see a short notice, since every webhook route would answer them
// 403. The list shows where events go and how the latest delivery went.
// Create and rotate-secret end in the show-once secret dialog. Disable and
// enable are tier-1 confirms (reversible); delete and rotate-secret are tier-2
// type-to-confirm (the history, or the old secret, is gone for good).

import { useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "react-router";

import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
  useWebhooks,
  type WebhookWithSecret,
} from "../api/hooks/webhooks";
import { ConfirmDialog } from "../components/overlay/ConfirmDialog";
import { SecretRevealModal } from "../components/overlay/SecretRevealModal";
import { useToast } from "../components/overlay/ToastProvider";
import { buttonVariants } from "../components/ui/Button";
import { CALLOUT, CALLOUT_TONE } from "../components/ui/callout";
import { CHIP, CHIP_TONE } from "../components/ui/chip";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { PageHeader } from "../components/ui/PageHeader";
import { Skeleton } from "../components/ui/Skeleton";
import { TBL, TBL_TD, TBL_TH, TBL_TR, TBL_WRAP } from "../components/ui/table";
import { formatRelativeTime } from "../model/format";
import {
  changedWebhookFields,
  describeDeliveryResult,
  describeWebhookEvents,
  type Webhook,
} from "../model/webhook";
import { useTeamRole } from "../rbac/useTeamRole";
import { DeliveryStatusChip, problemMessage } from "./webhooks/shared";
import { WebhookDeliveriesModal } from "./webhooks/WebhookDeliveriesModal";
import { WebhookFormModal } from "./webhooks/WebhookFormModal";
import { WebhookRowMenu } from "./webhooks/WebhookRowMenu";

const CARD = "rounded-lg border border-border bg-surface p-[22px] shadow-sm";
const ROTATE_CONFIRMATION = "rotate";
const TEST_RESULT_REFETCH_MS = 2500;

export function WebhooksPage() {
  const { teamId } = useParams();
  const { isLoading, can } = useTeamRole(teamId ?? "");

  if (teamId === undefined) {
    return null;
  }

  return (
    <>
      <PageHeader title="Webhooks" />
      {isLoading ? (
        <div className={CARD} role="status" aria-label="Loading webhooks">
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : can("webhook.manage") ? (
        <WebhooksManager teamId={teamId} />
      ) : (
        <div className={CARD}>
          <EmptyState
            icon={<WebhookIcon />}
            title="Webhooks are managed by team admins"
            description="Ask an admin or owner of this team to add or change a webhook."
          />
        </div>
      )}
    </>
  );
}

function WebhooksManager({ teamId }: { teamId: string }) {
  const toast = useToast();
  const webhooks = useWebhooks(teamId);
  const create = useCreateWebhook(teamId);
  const update = useUpdateWebhook(teamId);
  const remove = useDeleteWebhook(teamId);
  const rotate = useRotateWebhookSecret();
  const test = useTestWebhook(teamId);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [deliveriesOf, setDeliveriesOf] = useState<Webhook | null>(null);
  const [togglingStatus, setTogglingStatus] = useState<Webhook | null>(null);
  const [rotating, setRotating] = useState<Webhook | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  /** Set right after create or rotate; owns the show-once dialog. */
  const [revealed, setRevealed] = useState<(WebhookWithSecret & { rotated: boolean }) | null>(
    null,
  );

  const handleTest = (webhook: Webhook) => {
    test.mutate(webhook.id, {
      onError: (error) => toast.error(problemMessage(error)),
      onSuccess: () => {
        toast.success("Test event queued", {
          description: "A ping is on its way. Open Deliveries to see the result.",
        });
        // The attempt usually settles within a second or two; read the list
        // once more so the row's latest delivery shows how it went.
        window.setTimeout(() => {
          void webhooks.refetch();
        }, TEST_RESULT_REFETCH_MS);
      },
    });
  };

  const addButton = (
    <button
      type="button"
      className={buttonVariants({ intent: "primary" })}
      onClick={() => setCreateOpen(true)}
    >
      Add webhook
    </button>
  );

  return (
    <>
      {webhooks.isPending ? (
        <div className={CARD} role="status" aria-label="Loading webhooks">
          <Skeleton variant="line" />
          <Skeleton variant="line" />
          <Skeleton variant="line" />
        </div>
      ) : webhooks.isError ? (
        <div className={CARD}>
          <ErrorState
            error={webhooks.error}
            onRetry={() => {
              void webhooks.refetch();
            }}
          />
        </div>
      ) : webhooks.data.length === 0 ? (
        <div className={CARD}>
          <EmptyState
            icon={<WebhookIcon />}
            title="No webhooks yet"
            description="Add a URL for release events."
            action={addButton}
          />
        </div>
      ) : (
        <>
          <div className="mb-3.5 flex justify-end">{addButton}</div>
          <div className="rounded-lg border border-border bg-surface shadow-sm">
            <div className={TBL_WRAP}>
              <table className={TBL}>
                <thead>
                  <tr>
                    <th className={TBL_TH}>URL</th>
                    <th className={TBL_TH}>Events</th>
                    <th className={TBL_TH}>Status</th>
                    <th className={TBL_TH}>Last delivery</th>
                    <th className={TBL_TH}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.data.map((webhook) => (
                    <tr key={webhook.id} className={TBL_TR}>
                      <td className={`${TBL_TD} min-w-[200px]`}>
                        <span className="break-all font-mono text-[12.5px] font-semibold">
                          {webhook.url}
                        </span>
                        {webhook.description !== null ? (
                          <span className="block text-[13px] text-fg-3">
                            {webhook.description}
                          </span>
                        ) : null}
                      </td>
                      <td className={TBL_TD}>
                        <span className="text-[13px]">
                          {describeWebhookEvents(webhook.eventTypes)}
                        </span>
                      </td>
                      <td className={TBL_TD}>
                        <span
                          className={`${CHIP} ${
                            webhook.status === "active" ? CHIP_TONE.green : CHIP_TONE.neutral
                          }`}
                        >
                          {webhook.status === "active" ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td className={TBL_TD}>
                        <LastDelivery webhook={webhook} />
                      </td>
                      <td className={`${TBL_TD} whitespace-nowrap text-right`}>
                        <RowButton
                          onClick={() => handleTest(webhook)}
                          disabled={test.isPending || webhook.status !== "active"}
                        >
                          Send test
                        </RowButton>
                        <RowButton onClick={() => setDeliveriesOf(webhook)}>Deliveries</RowButton>
                        <WebhookRowMenu
                          webhook={webhook}
                          onEdit={() => setEditing(webhook)}
                          onToggleStatus={() => setTogglingStatus(webhook)}
                          onRotateSecret={() => setRotating(webhook)}
                          onDelete={() => setDeleting(webhook)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Conditional mounts reset each dialog's own state on every open. */}
      {createOpen ? (
        <WebhookFormModal
          error={create.error}
          pending={create.isPending}
          onClose={() => {
            setCreateOpen(false);
            create.reset();
          }}
          onSubmit={(values) =>
            create.mutate(values, {
              onSuccess: (created) => {
                setCreateOpen(false);
                setRevealed({ ...created, rotated: false });
              },
            })
          }
        />
      ) : null}

      {editing !== null ? (
        <WebhookFormModal
          initial={editing}
          error={update.error}
          pending={update.isPending}
          onClose={() => {
            setEditing(null);
            update.reset();
          }}
          onSubmit={(values) => {
            const changes = changedWebhookFields(editing, values);
            if (Object.keys(changes).length === 0) {
              setEditing(null);
              return;
            }
            update.mutate(
              { ...changes, webhookId: editing.id },
              {
                onSuccess: () => {
                  setEditing(null);
                  toast.success("Webhook updated");
                },
              },
            );
          }}
        />
      ) : null}

      {deliveriesOf !== null ? (
        <WebhookDeliveriesModal
          teamId={teamId}
          webhook={deliveriesOf}
          onClose={() => setDeliveriesOf(null)}
        />
      ) : null}

      {revealed !== null ? (
        <SecretRevealModal
          title={revealed.rotated ? "Copy the new signing secret" : "Copy the signing secret"}
          description="This is the only time the secret is shown."
          secretName="signing secret"
          value={revealed.secret}
          warning={
            <>
              <b>Store this secret now.</b> Your receiver uses it to verify the{" "}
              <code>webhook-signature</code> header. Once you close this dialog it cannot be
              shown again; you would have to rotate it.
            </>
          }
          acknowledgement="I've saved it. This secret won't be shown again."
          doneLabel="I've copied it. Done."
          onDone={() => {
            setRevealed(null);
            // The mutation result still holds the secret while this page
            // observes it; drop it with the dialog.
            create.reset();
            rotate.reset();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={togglingStatus !== null}
        variant="summary"
        title={togglingStatus?.status === "active" ? "Disable webhook" : "Enable webhook"}
        description={
          togglingStatus?.status === "active"
            ? "No events are sent while it is disabled. Deliveries that are still waiting to retry are marked failed."
            : "Events recorded from now on are sent again. Events from while it was disabled are not."
        }
        confirmLabel={togglingStatus?.status === "active" ? "Disable" : "Enable"}
        summary={[
          { label: "URL", value: togglingStatus?.url ?? "" },
          {
            label: "Status",
            value: togglingStatus?.status === "active" ? "Active → Disabled" : "Disabled → Active",
          },
        ]}
        busy={update.isPending}
        error={update.isError ? problemMessage(update.error) : undefined}
        onCancel={() => {
          setTogglingStatus(null);
          update.reset();
        }}
        onConfirm={() => {
          if (togglingStatus === null) {
            return;
          }
          update.mutate(
            {
              status: togglingStatus.status === "active" ? "disabled" : "active",
              webhookId: togglingStatus.id,
            },
            {
              onSuccess: (updated) => {
                setTogglingStatus(null);
                toast.success(
                  updated.status === "active" ? "Webhook enabled" : "Webhook disabled",
                );
              },
            },
          );
        }}
      />

      <ConfirmDialog
        open={rotating !== null}
        variant="typeToConfirm"
        confirmationText={ROTATE_CONFIRMATION}
        title="Rotate signing secret"
        description={rotating?.url}
        confirmLabel="Rotate secret"
        busy={rotate.isPending}
        error={rotate.isError ? problemMessage(rotate.error) : undefined}
        onCancel={() => {
          setRotating(null);
          rotate.reset();
        }}
        onConfirm={() => {
          if (rotating === null) {
            return;
          }
          rotate.mutate(rotating.id, {
            onSuccess: (rotated) => {
              setRotating(null);
              setRevealed({ ...rotated, rotated: true });
            },
          });
        }}
      >
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mb-3.5`}>
          <div>
            The current secret <b>stops verifying at once</b>, for retries of earlier events
            too. Update your receiver with the new secret right after this.
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        variant="typeToConfirm"
        confirmationText="delete"
        title="Delete webhook"
        description={deleting?.url}
        confirmLabel="Delete webhook"
        busy={remove.isPending}
        error={remove.isError ? problemMessage(remove.error) : undefined}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => {
          if (deleting === null) {
            return;
          }
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast.success("Webhook deleted");
            },
          });
        }}
      >
        <div className={`${CALLOUT} ${CALLOUT_TONE.danger} mb-3.5`}>
          <div>
            Events stop going to this URL and its <b>delivery history is deleted</b>. To pause
            it and keep the history, disable it instead.
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

function LastDelivery({ webhook }: { webhook: Webhook }) {
  const last = webhook.lastDelivery;
  if (last === null) {
    return <span className="text-[13px] text-fg-3">Nothing sent yet</span>;
  }

  const result = describeDeliveryResult(last);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <DeliveryStatusChip status={last.status} />
      <span className="text-[13px] text-fg-3">
        {[result, last.lastAttemptAt === null ? null : formatRelativeTime(last.lastAttemptAt)]
          .filter((part) => part !== null)
          .join(" · ")}
      </span>
    </span>
  );
}

function RowButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={buttonVariants({ intent: "subtle", size: "sm" })}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>{" "}
    </>
  );
}

function WebhookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
      <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
      <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
    </svg>
  );
}
