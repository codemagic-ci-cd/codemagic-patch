import type { TeamId, WebhookEndpointId, WebhookEventType } from "../domain";

/**
 * Event bodies (`server/specs/webhooks-tech-spec.md`, Payload). A body is
 * built once and stored as text, so every attempt sends the same bytes.
 */

interface WebhookEnvelope {
  data: Record<string, unknown>;
  timestamp: string;
  type: WebhookEventType;
}

export function serializeWebhookPayload(envelope: {
  data: Record<string, unknown>;
  timestamp: Date;
  type: WebhookEventType;
}): string {
  const body: WebhookEnvelope = {
    type: envelope.type,
    timestamp: envelope.timestamp.toISOString(),
    data: envelope.data,
  };

  return JSON.stringify(body);
}

export function buildPingPayload(input: {
  team: { id: TeamId; name: string };
  timestamp: Date;
  webhookId: WebhookEndpointId;
}): string {
  return serializeWebhookPayload({
    data: {
      team: { id: input.team.id, name: input.team.name },
      webhook: { id: input.webhookId },
    },
    timestamp: input.timestamp,
    type: "ping",
  });
}

export type WebhookFailureOperation =
  | "publish"
  | "promote"
  | "rollback"
  | "update"
  | "disable"
  | "enable";

export interface ReleaseEventPayloadInput {
  app: { id: string; name: string };
  /** Present on `release.updated` only. */
  changes: Record<string, { from: unknown; to: unknown }> | null;
  deployment: { id: string; name: string };
  /** Present on `release.failed` only. */
  failure: { operation: WebhookFailureOperation; reason: string; stage: string } | null;
  release: {
    createdAt: Date;
    id: string;
    isMandatory: boolean;
    releaseLabel: string;
    releaseNotes: string | null;
    rollbackOf: string | null;
    rolloutPercentage: number;
    sourceReleaseId: string | null;
    status: string;
    targetBinaryVersion: string;
  };
  requestedBy: string | null;
  team: { id: string; name: string };
  timestamp: Date;
  type: WebhookEventType;
}

export function buildReleaseEventPayload(input: ReleaseEventPayloadInput): string {
  return serializeWebhookPayload({
    data: {
      team: { id: input.team.id, name: input.team.name },
      app: { id: input.app.id, name: input.app.name },
      deployment: { id: input.deployment.id, name: input.deployment.name },
      release: {
        id: input.release.id,
        release_label: input.release.releaseLabel,
        status: input.release.status,
        target_binary_version: input.release.targetBinaryVersion,
        rollout_percentage: input.release.rolloutPercentage,
        is_mandatory: input.release.isMandatory,
        release_notes: input.release.releaseNotes,
        rollback_of: input.release.rollbackOf,
        source_release_id: input.release.sourceReleaseId,
        created_at: input.release.createdAt.toISOString(),
      },
      ...(input.changes ? { changes: input.changes } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
      requested_by: input.requestedBy === null ? null : { id: input.requestedBy },
    },
    timestamp: input.timestamp,
    type: input.type,
  });
}
