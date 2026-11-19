import type { Pool, PoolClient } from "pg";

import { withTransaction } from "../db";
import type { DatabasePool } from "../db";
import type {
  TeamId,
  UserId,
  WebhookDelivery,
  WebhookDeliveryError,
  WebhookDeliveryId,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointId,
  WebhookEndpointStatus,
  WebhookEventId,
  WebhookEventType,
  WebhookReleaseEventType,
} from "../domain";
import {
  mapWebhookDeliveryRow,
  mapWebhookEndpointRow,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from "./rowMappers";

/** `server/specs/webhooks-tech-spec.md`, Management API → Create. */
export const WEBHOOK_ENDPOINT_LIMIT_PER_TEAM = 10;

/** The latest delivery of an endpoint, as its list and read responses show it. */
export type WebhookLastDelivery = Pick<
  WebhookDelivery,
  | "attemptCount"
  | "eventType"
  | "id"
  | "lastAttemptAt"
  | "lastError"
  | "lastResponseStatus"
  | "status"
>;

export interface WebhookEndpointWithLastDelivery {
  endpoint: WebhookEndpoint;
  lastDelivery: WebhookLastDelivery | null;
}

export interface CreateWebhookEndpointInput {
  createdAt: Date;
  createdBy: UserId | null;
  description: string | null;
  eventTypes: readonly WebhookReleaseEventType[];
  id: WebhookEndpointId;
  secret: string;
  teamId: TeamId;
  url: string;
}

export type CreateWebhookEndpointResult =
  | { outcome: "created"; endpoint: WebhookEndpoint }
  | { outcome: "not_found"; reason: "team_not_found" }
  | { outcome: "limit_reached"; limit: number };

export interface UpdateWebhookEndpointInput {
  /** `undefined` leaves the field alone; `null` clears the description. */
  description?: string | null;
  eventTypes?: readonly WebhookReleaseEventType[];
  id: WebhookEndpointId;
  status?: WebhookEndpointStatus;
  updatedAt: Date;
  url?: string;
}

export type UpdateWebhookEndpointResult =
  | { outcome: "updated"; endpoint: WebhookEndpoint; previous: WebhookEndpoint }
  | { outcome: "not_found" };

export interface RecordWebhookTestEventInput {
  /** Builds the body once the endpoint's team has been read. */
  buildPayload(team: { id: TeamId; name: string }): string;
  deliveryId: WebhookDeliveryId;
  endpointId: WebhookEndpointId;
  eventId: WebhookEventId;
  now: Date;
}

export type RecordWebhookTestEventResult =
  | { outcome: "recorded"; delivery: WebhookDelivery }
  | { outcome: "not_found" }
  | { outcome: "disabled" };

export interface ListWebhookDeliveriesInput {
  endpointId: WebhookEndpointId;
  limit: number;
  offset: number;
  status?: WebhookDeliveryStatus;
}

export type RedeliverWebhookResult =
  | { outcome: "queued"; delivery: WebhookDelivery }
  | { outcome: "not_found" }
  | { outcome: "pending" }
  | { outcome: "disabled" };

/**
 * A delivery the loop has claimed. It carries the body, which never changes,
 * but not where to send it: the endpoint is read again when the attempt
 * actually starts (`readDeliveryTarget`), so a URL or secret changed while the
 * delivery waited for a free slot is not used.
 */
export interface ClaimedWebhookDelivery {
  /** Counts this attempt, as people see it. */
  attemptCount: number;
  /** Fences this claim: completing or reading the target needs it. */
  claimToken: number;
  deliveryId: WebhookDeliveryId;
  endpointId: WebhookEndpointId;
  eventId: WebhookEventId;
  eventType: WebhookEventType;
  payload: string;
}

/** Where a claimed delivery goes, as the endpoint is right now. */
export interface WebhookDeliveryTarget {
  endpointStatus: WebhookEndpointStatus;
  secret: string;
  url: string;
}

export interface CompleteWebhookDeliveryInput {
  /** From the claim. A completion for a claim that lost its lease is ignored. */
  claimToken: number;
  deliveryId: WebhookDeliveryId;
  now: Date;
  responseStatus: number | null;
}

export interface FailWebhookDeliveryInput extends CompleteWebhookDeliveryInput {
  error: WebhookDeliveryError;
  /** `null` ends the delivery as `failed`; a date schedules the next attempt. */
  nextAttemptAt: Date | null;
}

export interface InsertWebhookEventInput {
  createDeliveryId: () => WebhookDeliveryId;
  endpointIds: readonly WebhookEndpointId[];
  eventId: WebhookEventId;
  now: Date;
  payload: string;
  teamId: TeamId;
  type: WebhookEventType;
}

export interface WebhookRepository {
  claimDueDeliveries(input: {
    leaseMs: number;
    limit: number;
    /** A delivery that already used this many attempts is failed, not claimed. */
    maxAttempts: number;
    now: Date;
  }): Promise<ClaimedWebhookDelivery[]>;
  createEndpoint(input: CreateWebhookEndpointInput): Promise<CreateWebhookEndpointResult>;
  deleteEndpoint(id: WebhookEndpointId): Promise<WebhookEndpoint | null>;
  /** Deletes events created before `before` that have no pending delivery. */
  deleteExpiredEvents(before: Date): Promise<number>;
  getDelivery(
    endpointId: WebhookEndpointId,
    deliveryId: WebhookDeliveryId,
  ): Promise<{ delivery: WebhookDelivery; payload: string } | null>;
  getEndpoint(id: WebhookEndpointId): Promise<WebhookEndpointWithLastDelivery | null>;
  listDeliveries(
    input: ListWebhookDeliveriesInput,
  ): Promise<{ deliveries: WebhookDelivery[]; total: number }>;
  listEndpointsForTeam(teamId: TeamId): Promise<WebhookEndpointWithLastDelivery[]>;
  markDeliveryFailed(input: FailWebhookDeliveryInput): Promise<boolean>;
  /**
   * The endpoint a claimed delivery goes to, read at the moment of sending.
   * Null when the claim no longer holds the delivery or the endpoint is gone.
   */
  readDeliveryTarget(input: {
    claimToken: number;
    deliveryId: WebhookDeliveryId;
  }): Promise<WebhookDeliveryTarget | null>;
  markDeliverySucceeded(input: CompleteWebhookDeliveryInput): Promise<boolean>;
  recordTestEvent(input: RecordWebhookTestEventInput): Promise<RecordWebhookTestEventResult>;
  redeliver(
    endpointId: WebhookEndpointId,
    deliveryId: WebhookDeliveryId,
    now: Date,
  ): Promise<RedeliverWebhookResult>;
  rotateEndpointSecret(
    id: WebhookEndpointId,
    secret: string,
    now: Date,
  ): Promise<WebhookEndpoint | null>;
  updateEndpoint(input: UpdateWebhookEndpointInput): Promise<UpdateWebhookEndpointResult>;
}

const ENDPOINT_COLUMNS = `
  id, team_id, url, description, event_types, status, created_by,
  created_at, updated_at
`;

const DELIVERY_COLUMNS = `
  d.id, d.event_id, d.endpoint_id, e.type AS event_type, d.status,
  d.attempt_count, d.next_attempt_at, d.last_attempt_at,
  d.last_response_status, d.last_error, d.created_at, d.completed_at
`;

interface EndpointWithLastDeliveryRow extends WebhookEndpointRow {
  last_delivery_attempt_count: number | null;
  last_delivery_event_type: string | null;
  last_delivery_id: string | null;
  last_delivery_last_attempt_at: Date | null;
  last_delivery_last_error: string | null;
  last_delivery_last_response_status: number | null;
  last_delivery_status: WebhookDeliveryStatus | null;
}

const ENDPOINT_WITH_LAST_DELIVERY_SELECT = `
  SELECT
    ep.id, ep.team_id, ep.url, ep.description, ep.event_types, ep.status,
    ep.created_by, ep.created_at, ep.updated_at,
    ld.id AS last_delivery_id,
    ld.event_type AS last_delivery_event_type,
    ld.status AS last_delivery_status,
    ld.attempt_count AS last_delivery_attempt_count,
    ld.last_attempt_at AS last_delivery_last_attempt_at,
    ld.last_response_status AS last_delivery_last_response_status,
    ld.last_error AS last_delivery_last_error
  FROM webhook_endpoint ep
  LEFT JOIN LATERAL (
    SELECT
      d.id, e.type AS event_type, d.status, d.attempt_count,
      d.last_attempt_at, d.last_response_status, d.last_error
    FROM webhook_delivery d
    JOIN webhook_event e ON e.id = d.event_id
    WHERE d.endpoint_id = ep.id
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT 1
  ) ld ON TRUE
`;

export function createPostgresWebhookRepository(
  pool: DatabasePool | Pool,
): WebhookRepository {
  return {
    async createEndpoint(input) {
      return withTransaction(pool, async (client) => {
        // Locking the team row serializes creates within a team, so two
        // concurrent requests cannot both pass the limit check. NO KEY UPDATE,
        // not UPDATE: a settling release inserts a webhook_event that
        // references this team, and must not wait behind this lock.
        const team = await client.query(
          "SELECT id FROM team WHERE id = $1 FOR NO KEY UPDATE",
          [input.teamId],
        );
        if (team.rowCount === 0) {
          return { outcome: "not_found", reason: "team_not_found" };
        }

        const count = await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM webhook_endpoint WHERE team_id = $1",
          [input.teamId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= WEBHOOK_ENDPOINT_LIMIT_PER_TEAM) {
          return { outcome: "limit_reached", limit: WEBHOOK_ENDPOINT_LIMIT_PER_TEAM };
        }

        const inserted = await client.query<WebhookEndpointRow>(
          `
            INSERT INTO webhook_endpoint (
              id, team_id, url, description, event_types, secret, status,
              created_by, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5::text[], $6, 'active', $7, $8, $8)
            RETURNING ${ENDPOINT_COLUMNS}
          `,
          [
            input.id,
            input.teamId,
            input.url,
            input.description,
            [...input.eventTypes],
            input.secret,
            input.createdBy,
            input.createdAt,
          ],
        );

        return {
          endpoint: mapWebhookEndpointRow(requireRow(inserted.rows[0])),
          outcome: "created",
        };
      });
    },

    async listEndpointsForTeam(teamId) {
      const result = await pool.query<EndpointWithLastDeliveryRow>(
        `
          ${ENDPOINT_WITH_LAST_DELIVERY_SELECT}
          WHERE ep.team_id = $1
          ORDER BY ep.created_at, ep.id
        `,
        [teamId],
      );

      return result.rows.map(mapEndpointWithLastDeliveryRow);
    },

    async getEndpoint(id) {
      const result = await pool.query<EndpointWithLastDeliveryRow>(
        `${ENDPOINT_WITH_LAST_DELIVERY_SELECT} WHERE ep.id = $1`,
        [id],
      );
      const row = result.rows[0];

      return row ? mapEndpointWithLastDeliveryRow(row) : null;
    },

    async updateEndpoint(input) {
      return withTransaction(pool, async (client) => {
        const current = await client.query<WebhookEndpointRow>(
          `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoint WHERE id = $1 FOR UPDATE`,
          [input.id],
        );
        const currentRow = current.rows[0];
        if (!currentRow) {
          return { outcome: "not_found" };
        }

        const updated = await client.query<WebhookEndpointRow>(
          `
            UPDATE webhook_endpoint
            SET url = $2,
                description = $3,
                event_types = $4::text[],
                status = $5,
                updated_at = $6
            WHERE id = $1
            RETURNING ${ENDPOINT_COLUMNS}
          `,
          [
            input.id,
            input.url ?? currentRow.url,
            input.description === undefined ? currentRow.description : input.description,
            input.eventTypes === undefined ? currentRow.event_types : [...input.eventTypes],
            input.status ?? currentRow.status,
            input.updatedAt,
          ],
        );

        // Disabling ends what is still waiting, here and not at the next
        // claim: otherwise enabling the endpoint again before a retry was due
        // would send a delivery the caller was told had stopped.
        if (currentRow.status === "active" && input.status === "disabled") {
          await client.query(
            `
              UPDATE webhook_delivery
              SET status = 'failed',
                  next_attempt_at = NULL,
                  last_error = 'endpoint_disabled',
                  completed_at = $2
              WHERE endpoint_id = $1
                AND status = 'pending'
            `,
            [input.id, input.updatedAt],
          );
        }

        return {
          endpoint: mapWebhookEndpointRow(requireRow(updated.rows[0])),
          outcome: "updated",
          previous: mapWebhookEndpointRow(currentRow),
        };
      });
    },

    async deleteEndpoint(id) {
      const result = await pool.query<WebhookEndpointRow>(
        `DELETE FROM webhook_endpoint WHERE id = $1 RETURNING ${ENDPOINT_COLUMNS}`,
        [id],
      );
      const row = result.rows[0];

      return row ? mapWebhookEndpointRow(row) : null;
    },

    async rotateEndpointSecret(id, secret, now) {
      const result = await pool.query<WebhookEndpointRow>(
        `
          UPDATE webhook_endpoint
          SET secret = $2, updated_at = $3
          WHERE id = $1
          RETURNING ${ENDPOINT_COLUMNS}
        `,
        [id, secret, now],
      );
      const row = result.rows[0];

      return row ? mapWebhookEndpointRow(row) : null;
    },

    async recordTestEvent(input) {
      return withTransaction(pool, async (client) => {
        const endpoint = await client.query<{
          status: WebhookEndpointStatus;
          team_id: string;
          team_name: string;
        }>(
          `
            SELECT ep.team_id, ep.status, t.name AS team_name
            FROM webhook_endpoint ep
            JOIN team t ON t.id = ep.team_id
            WHERE ep.id = $1
            FOR SHARE OF ep
          `,
          [input.endpointId],
        );
        const endpointRow = endpoint.rows[0];
        if (!endpointRow) {
          return { outcome: "not_found" };
        }
        if (endpointRow.status !== "active") {
          return { outcome: "disabled" };
        }

        await insertWebhookEvent(client, {
          createDeliveryId: () => input.deliveryId,
          endpointIds: [input.endpointId],
          eventId: input.eventId,
          now: input.now,
          payload: input.buildPayload({
            id: endpointRow.team_id as TeamId,
            name: endpointRow.team_name,
          }),
          teamId: endpointRow.team_id as TeamId,
          type: "ping",
        });

        const delivery = await client.query<WebhookDeliveryRow>(
          `
            SELECT ${DELIVERY_COLUMNS}
            FROM webhook_delivery d
            JOIN webhook_event e ON e.id = d.event_id
            WHERE d.id = $1
          `,
          [input.deliveryId],
        );

        return {
          delivery: mapWebhookDeliveryRow(requireRow(delivery.rows[0])),
          outcome: "recorded",
        };
      });
    },

    async listDeliveries(input) {
      const statusFilter = input.status ?? null;
      const [rows, total] = await Promise.all([
        pool.query<WebhookDeliveryRow>(
          `
            SELECT ${DELIVERY_COLUMNS}
            FROM webhook_delivery d
            JOIN webhook_event e ON e.id = d.event_id
            WHERE d.endpoint_id = $1
              AND ($2::text IS NULL OR d.status = $2)
            ORDER BY d.created_at DESC, d.id DESC
            LIMIT $3 OFFSET $4
          `,
          [input.endpointId, statusFilter, input.limit, input.offset],
        ),
        pool.query<{ count: string }>(
          `
            SELECT count(*) AS count
            FROM webhook_delivery d
            WHERE d.endpoint_id = $1
              AND ($2::text IS NULL OR d.status = $2)
          `,
          [input.endpointId, statusFilter],
        ),
      ]);

      return {
        deliveries: rows.rows.map(mapWebhookDeliveryRow),
        total: Number(total.rows[0]?.count ?? 0),
      };
    },

    async getDelivery(endpointId, deliveryId) {
      const result = await pool.query<WebhookDeliveryRow & { payload: string }>(
        `
          SELECT ${DELIVERY_COLUMNS}, e.payload
          FROM webhook_delivery d
          JOIN webhook_event e ON e.id = d.event_id
          WHERE d.id = $1 AND d.endpoint_id = $2
        `,
        [deliveryId, endpointId],
      );
      const row = result.rows[0];

      return row ? { delivery: mapWebhookDeliveryRow(row), payload: row.payload } : null;
    },

    async redeliver(endpointId, deliveryId, now) {
      return withTransaction(pool, async (client) => {
        // Hold the endpoint first, the way disabling does. Disabling fails
        // the endpoint's pending deliveries; a redelivery that read "active"
        // and requeued a moment after that sweep would leave a pending
        // delivery behind on a disabled endpoint, and enabling it again would
        // send it. Under this lock a disable either has finished, and is
        // seen below, or waits and then sweeps the requeued delivery too.
        const endpoint = await client.query<{ status: WebhookEndpointStatus }>(
          "SELECT status FROM webhook_endpoint WHERE id = $1 FOR SHARE",
          [endpointId],
        );
        const endpointRow = endpoint.rows[0];
        if (!endpointRow) {
          return { outcome: "not_found" };
        }

        // Hold the event before touching the delivery. Retention deletes an
        // old event only while it holds that row, so it either waits for this
        // transaction or has already removed the delivery; it can never
        // delete a delivery this call has just reported as queued.
        const event = await client.query(
          `
            SELECT e.id
            FROM webhook_event e
            JOIN webhook_delivery d ON d.event_id = e.id
            WHERE d.id = $1 AND d.endpoint_id = $2
            FOR KEY SHARE OF e
          `,
          [deliveryId, endpointId],
        );
        if (event.rowCount === 0) {
          return { outcome: "not_found" };
        }

        const current = await client.query<{ status: WebhookDeliveryStatus }>(
          `
            SELECT status
            FROM webhook_delivery
            WHERE id = $1 AND endpoint_id = $2
            FOR UPDATE
          `,
          [deliveryId, endpointId],
        );
        const currentRow = current.rows[0];
        if (!currentRow) {
          return { outcome: "not_found" };
        }
        if (endpointRow.status !== "active") {
          return { outcome: "disabled" };
        }
        if (currentRow.status === "pending") {
          return { outcome: "pending" };
        }

        // Requeuing also retires whatever claim came before. A delivery can
        // be failed while its request is still out (the endpoint was disabled,
        // or the lease ran out on the last attempt); without a new generation
        // that request's late result would match the requeued row and settle
        // it before it was ever sent again.
        await client.query(
          `
            UPDATE webhook_delivery
            SET status = 'pending',
                attempt_count = 0,
                claim_generation = claim_generation + 1,
                next_attempt_at = $2,
                last_response_status = NULL,
                last_error = NULL,
                completed_at = NULL
            WHERE id = $1
          `,
          [deliveryId, now],
        );

        const delivery = await client.query<WebhookDeliveryRow>(
          `
            SELECT ${DELIVERY_COLUMNS}
            FROM webhook_delivery d
            JOIN webhook_event e ON e.id = d.event_id
            WHERE d.id = $1
          `,
          [deliveryId],
        );

        return {
          delivery: mapWebhookDeliveryRow(requireRow(delivery.rows[0])),
          outcome: "queued",
        };
      });
    },

    async claimDueDeliveries(input) {
      const leaseEnd = new Date(input.now.getTime() + input.leaseMs);

      // A delivery that is due again after its last allowed attempt was
      // claimed never reported back: the process that held it died. It is not
      // sent an extra time; it ends as failed and waits for a person.
      await pool.query(
        `
          UPDATE webhook_delivery
          SET status = 'failed',
              next_attempt_at = NULL,
              last_error = COALESCE(last_error, 'timeout'),
              completed_at = $1
          WHERE status = 'pending'
            AND next_attempt_at <= $1
            AND attempt_count >= $2
        `,
        [input.now, input.maxAttempts],
      );

      // One statement: the row lock, the counters and the lease move
      // together, so a second claimer skips these rows and a crash after this
      // point leaves them due again when the lease runs out.
      const result = await pool.query<{
        attempt_count: number;
        claim_generation: number;
        endpoint_id: string;
        event_id: string;
        event_type: string;
        id: string;
        payload: string;
      }>(
        `
          WITH due AS (
            SELECT id
            FROM webhook_delivery
            WHERE status = 'pending'
              AND next_attempt_at <= $1
              AND attempt_count < $4
            ORDER BY next_attempt_at, id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          UPDATE webhook_delivery d
          SET attempt_count = d.attempt_count + 1,
              claim_generation = d.claim_generation + 1,
              next_attempt_at = $3,
              last_attempt_at = $1
          FROM due, webhook_event e
          WHERE d.id = due.id
            AND e.id = d.event_id
          RETURNING
            d.id, d.attempt_count, d.claim_generation, d.event_id,
            d.endpoint_id, e.type AS event_type, e.payload
        `,
        [input.now, input.limit, leaseEnd, input.maxAttempts],
      );

      return result.rows.map((row) => ({
        attemptCount: row.attempt_count,
        claimToken: row.claim_generation,
        deliveryId: row.id as WebhookDeliveryId,
        endpointId: row.endpoint_id as WebhookEndpointId,
        eventId: row.event_id as WebhookEventId,
        eventType: row.event_type as WebhookEventType,
        payload: row.payload,
      }));
    },

    async readDeliveryTarget(input) {
      const result = await pool.query<{
        endpoint_status: WebhookEndpointStatus;
        secret: string;
        url: string;
      }>(
        `
          SELECT ep.url, ep.secret, ep.status AS endpoint_status
          FROM webhook_delivery d
          JOIN webhook_endpoint ep ON ep.id = d.endpoint_id
          WHERE d.id = $1
            AND d.status = 'pending'
            AND d.claim_generation = $2
        `,
        [input.deliveryId, input.claimToken],
      );
      const row = result.rows[0];

      return row
        ? { endpointStatus: row.endpoint_status, secret: row.secret, url: row.url }
        : null;
    },

    async markDeliverySucceeded(input) {
      const result = await pool.query(
        `
          UPDATE webhook_delivery
          SET status = 'succeeded',
              next_attempt_at = NULL,
              last_response_status = $4,
              last_error = NULL,
              completed_at = $3
          WHERE id = $1
            AND status = 'pending'
            AND claim_generation = $2
        `,
        [input.deliveryId, input.claimToken, input.now, input.responseStatus],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async markDeliveryFailed(input) {
      const result = await pool.query(
        `
          UPDATE webhook_delivery
          SET status = CASE WHEN $5::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
              next_attempt_at = $5,
              last_response_status = $4,
              last_error = $6,
              completed_at = CASE WHEN $5::timestamptz IS NULL THEN $3::timestamptz ELSE NULL END
          WHERE id = $1
            AND status = 'pending'
            AND claim_generation = $2
        `,
        [
          input.deliveryId,
          input.claimToken,
          input.now,
          input.responseStatus,
          input.nextAttemptAt,
          input.error,
        ],
      );

      return (result.rowCount ?? 0) > 0;
    },

    async deleteExpiredEvents(before) {
      return withTransaction(pool, async (client) => {
        // Two statements on purpose. The first takes the old events; a
        // redelivery holds its event while it requeues, so such an event is
        // skipped here. The second runs on a fresh snapshot, so it sees every
        // redelivery that committed before the first took its locks, and any
        // that starts later waits for this transaction and finds the delivery
        // gone.
        const candidates = await client.query<{ id: string }>(
          `
            SELECT id
            FROM webhook_event
            WHERE created_at < $1
            FOR UPDATE SKIP LOCKED
          `,
          [before],
        );
        if (candidates.rowCount === 0) {
          return 0;
        }

        const deleted = await client.query(
          `
            DELETE FROM webhook_event e
            WHERE e.id = ANY ($1::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM webhook_delivery d
                WHERE d.event_id = e.id
                  AND d.status = 'pending'
              )
          `,
          [candidates.rows.map((row) => row.id)],
        );

        return deleted.rowCount ?? 0;
      });
    },
  };
}

/**
 * The ids of a team's active endpoints that take `type`, oldest first.
 * Runs on the caller's client so a settling transaction can use it.
 *
 * The rows are held (KEY SHARE) until the caller commits. Without that, an
 * endpoint deleted between this read and the delivery inserts would fail the
 * insert that references it and take the whole event down with it, losing it
 * for the endpoints that are still there. A delete in progress is waited for
 * and then simply not selected.
 */
export async function selectWebhookEndpointIdsForEvent(
  client: Pick<PoolClient, "query">,
  teamId: TeamId,
  type: WebhookReleaseEventType,
): Promise<WebhookEndpointId[]> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM webhook_endpoint
      WHERE team_id = $1
        AND status = 'active'
        AND (cardinality(event_types) = 0 OR $2 = ANY (event_types))
      ORDER BY created_at, id
      FOR KEY SHARE
    `,
    [teamId, type],
  );

  return result.rows.map((row) => row.id as WebhookEndpointId);
}

/**
 * Inserts one event and a pending delivery for each endpoint, due at `now`.
 * Runs on the caller's client so the rows commit with the caller's change.
 */
export async function insertWebhookEvent(
  client: Pick<PoolClient, "query">,
  input: InsertWebhookEventInput,
): Promise<void> {
  await client.query(
    `
      INSERT INTO webhook_event (id, team_id, type, payload, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [input.eventId, input.teamId, input.type, input.payload, input.now],
  );

  for (const endpointId of input.endpointIds) {
    await client.query(
      `
        INSERT INTO webhook_delivery (
          id, event_id, endpoint_id, status, attempt_count, next_attempt_at,
          created_at
        ) VALUES ($1, $2, $3, 'pending', 0, $4, $4)
      `,
      [input.createDeliveryId(), input.eventId, endpointId, input.now],
    );
  }
}

function mapEndpointWithLastDeliveryRow(
  row: EndpointWithLastDeliveryRow,
): WebhookEndpointWithLastDelivery {
  return {
    endpoint: mapWebhookEndpointRow(row),
    lastDelivery:
      row.last_delivery_id === null || row.last_delivery_status === null
        ? null
        : {
            attemptCount: row.last_delivery_attempt_count ?? 0,
            eventType: row.last_delivery_event_type as WebhookEventType,
            id: row.last_delivery_id as WebhookDeliveryId,
            lastAttemptAt: row.last_delivery_last_attempt_at,
            lastError: row.last_delivery_last_error as WebhookDeliveryError | null,
            lastResponseStatus: row.last_delivery_last_response_status,
            status: row.last_delivery_status,
          },
  };
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Expected webhook row to exist");
  }

  return row;
}
