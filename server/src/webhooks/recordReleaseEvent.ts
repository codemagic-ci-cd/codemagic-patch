import type {
  ReleaseJobTriggerType,
  TeamId,
  WebhookDeliveryId,
  WebhookEventId,
  WebhookReleaseEventType,
} from "../domain";
import {
  insertWebhookEvent,
  selectWebhookEndpointIdsForEvent,
  type ReleaseSettledHook,
  type ReleaseSettledInput,
} from "../repositories";
import { buildReleaseEventPayload, type WebhookFailureOperation } from "./payload";

const SAVEPOINT = "webhook_release_event";

const SUCCESS_EVENT_TYPE: Record<ReleaseJobTriggerType, WebhookReleaseEventType> = {
  release_created: "release.published",
  release_disabled: "release.disabled",
  release_enabled: "release.enabled",
  release_patched: "release.updated",
  release_promoted: "release.promoted",
  release_rolled_back: "release.rolled_back",
};

const FAILURE_OPERATION: Record<ReleaseJobTriggerType, WebhookFailureOperation> = {
  release_created: "publish",
  release_disabled: "disable",
  release_enabled: "enable",
  release_patched: "update",
  release_promoted: "promote",
  release_rolled_back: "rollback",
};

/** Triggers that bring a new release into a deployment. */
const NEW_RELEASE_TRIGGERS: ReadonlySet<ReleaseJobTriggerType> = new Set([
  "release_created",
  "release_promoted",
  "release_rolled_back",
]);

export interface ReleaseWebhookRecorderOptions {
  createDeliveryId: () => string;
  createEventId: () => string;
  /** Default `WEBHOOK_RECORD_LOCK_TIMEOUT_MS`. */
  lockTimeoutMs?: number;
  /** Told about a recording that failed. Its own failure is ignored. */
  onError(error: unknown, context: { jobId: string; releaseId: string }): void;
  /** Default `WEBHOOK_RECORD_STATEMENT_TIMEOUT_MS`. */
  statementTimeoutMs?: number;
}

/**
 * How long recording may wait inside the settling transaction. That
 * transaction holds the release and job rows, so a webhook statement stuck
 * behind someone else's lock would hold up the release with it. Past these
 * limits the statement is cancelled and the event is given up on.
 */
export const WEBHOOK_RECORD_LOCK_TIMEOUT_MS = 2_000;
export const WEBHOOK_RECORD_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Records the webhook event for a release job as it settles
 * (`server/specs/webhooks-tech-spec.md`, Events → Where events are recorded).
 *
 * It runs inside the settling transaction so the event commits with the
 * transition, and under a savepoint so that nothing here can undo that
 * transition: when recording fails, the savepoint is rolled back, the error is
 * reported, and the release settles as if webhooks did not exist.
 *
 * Two failures are not swallowed, because after either the transaction itself
 * can no longer be trusted: the savepoint could not be taken, or could not be
 * rolled back to. A transaction left aborted would still answer COMMIT, with a
 * rollback, and the caller would report a release that never settled. Those
 * errors are thrown, the settle fails visibly, and the worker retries it.
 */
export function createReleaseWebhookRecorder(
  options: ReleaseWebhookRecorderOptions,
): ReleaseSettledHook {
  const lockTimeoutMs = Math.trunc(options.lockTimeoutMs ?? WEBHOOK_RECORD_LOCK_TIMEOUT_MS);
  const statementTimeoutMs = Math.trunc(
    options.statementTimeoutMs ?? WEBHOOK_RECORD_STATEMENT_TIMEOUT_MS,
  );
  const report = (error: unknown, input: ReleaseSettledInput): void => {
    try {
      options.onError(error, contextOf(input));
    } catch {
      // A logger that throws must not decide whether a release settles.
    }
  };

  return async (input) => {
    const { client } = input;
    await client.query(`SAVEPOINT ${SAVEPOINT}`);

    try {
      // SET LOCAL lasts to the end of the transaction, so the limits are put
      // back once recording is done. A rollback to the savepoint undoes them
      // by itself.
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await record(input, options);
      await client.query("SET LOCAL lock_timeout TO DEFAULT");
      await client.query("SET LOCAL statement_timeout TO DEFAULT");
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch (error) {
      // Undo first, report second: reporting must not be able to leave the
      // transaction aborted.
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      report(error, input);
    }
  };
}

/** The event type for a settled job, or null when the job sends nothing. */
export function releaseWebhookEventType(input: {
  failed: boolean;
  releaseStatus: string;
  triggerType: ReleaseJobTriggerType;
}): WebhookReleaseEventType | null {
  if (input.failed) {
    return "release.failed";
  }
  // A release created in the disabled state is not live when its job
  // succeeds. `release.enabled` announces it when someone enables it.
  if (NEW_RELEASE_TRIGGERS.has(input.triggerType) && input.releaseStatus !== "published") {
    return null;
  }

  return SUCCESS_EVENT_TYPE[input.triggerType];
}

async function record(
  input: ReleaseSettledInput,
  options: ReleaseWebhookRecorderOptions,
): Promise<void> {
  const { client, failure, jobRow, now, releaseRow } = input;
  const type = releaseWebhookEventType({
    failed: failure !== null,
    releaseStatus: releaseRow.status,
    triggerType: jobRow.trigger_type,
  });
  if (type === null) {
    return;
  }

  const teamId = releaseRow.team_id as TeamId;
  const endpointIds = await selectWebhookEndpointIdsForEvent(client, teamId, type);
  if (endpointIds.length === 0) {
    return;
  }

  const names = await client.query<{
    app_name: string;
    deployment_name: string;
    team_name: string;
  }>(
    `
      SELECT t.name AS team_name, a.name AS app_name, d.name AS deployment_name
      FROM team t, app a, deployment d
      WHERE t.id = $1 AND a.id = $2 AND d.id = $3
    `,
    [releaseRow.team_id, releaseRow.app_id, releaseRow.deployment_id],
  );
  const nameRow = names.rows[0];
  if (!nameRow) {
    throw new Error(`release ${releaseRow.id} has no team, app or deployment row`);
  }

  await insertWebhookEvent(client, {
    createDeliveryId: () => options.createDeliveryId() as WebhookDeliveryId,
    endpointIds,
    eventId: options.createEventId() as WebhookEventId,
    now,
    payload: buildReleaseEventPayload({
      app: { id: releaseRow.app_id, name: nameRow.app_name },
      changes: type === "release.updated" ? orderedChanges(jobRow.patch_changes) : null,
      deployment: { id: releaseRow.deployment_id, name: nameRow.deployment_name },
      failure: failure
        ? {
            operation: FAILURE_OPERATION[jobRow.trigger_type],
            reason: failure.reason,
            stage: failure.stage,
          }
        : null,
      release: {
        createdAt: releaseRow.created_at,
        id: releaseRow.id,
        isMandatory: releaseRow.is_mandatory,
        releaseLabel: releaseRow.release_label,
        releaseNotes: releaseRow.release_notes,
        rollbackOf: releaseRow.rollback_of,
        rolloutPercentage: releaseRow.rollout_percentage,
        sourceReleaseId: releaseRow.source_bundle_release_id ?? null,
        status: releaseRow.status,
        targetBinaryVersion: releaseRow.target_binary_version,
      },
      requestedBy: jobRow.requested_by,
      team: { id: releaseRow.team_id, name: nameRow.team_name },
      timestamp: now,
      type,
    }),
    teamId,
    type,
  });
}

/**
 * JSONB does not keep key order, so the pairs come back as `{ to, from }`.
 * The payload reads better, and matches its documentation, as `{ from, to }`.
 */
function orderedChanges(
  changes: Record<string, { from: unknown; to: unknown }> | null | undefined,
): Record<string, { from: unknown; to: unknown }> | null {
  if (!changes) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(changes).map(([field, change]) => [
      field,
      { from: change.from, to: change.to },
    ]),
  );
}

function contextOf(input: ReleaseSettledInput): { jobId: string; releaseId: string } {
  return { jobId: input.jobRow.id, releaseId: input.releaseRow.id };
}
