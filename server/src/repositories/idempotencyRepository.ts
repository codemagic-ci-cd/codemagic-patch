import type { Pool } from "pg";

import type { DatabasePool } from "../db";
import { withTransaction } from "../db";

export interface StartIdempotentRequestInput {
  bodyHash: string;
  key: string;
  method: string;
  path: string;
  startedAt: Date;
}

export type StartIdempotentRequestResult =
  | {
      outcome: "started";
    }
  | {
      body: unknown;
      outcome: "replay";
      status: number;
    }
  | {
      outcome: "in_progress";
    }
  | {
      outcome: "mismatch";
    };

export interface CompleteIdempotentRequestInput {
  body: unknown;
  key: string;
  status: number;
}

export interface IdempotencyRepository {
  completeRequest(input: CompleteIdempotentRequestInput): Promise<void>;
  startRequest(
    input: StartIdempotentRequestInput,
  ): Promise<StartIdempotentRequestResult>;
}

interface Queryable {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface IdempotencyKeyRow {
  completed: boolean;
  request_body_hash: string;
  request_method: string;
  request_path: string;
  response_body: unknown;
  response_status: number | null;
}

const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

export function createPostgresIdempotencyRepository(
  pool: DatabasePool | Pool,
): IdempotencyRepository {
  return {
    async startRequest(input) {
      return withTransaction(pool, async (client) => {
        await deleteExpiredKey(client, input.key, input.startedAt);

        const expiresAt = new Date(
          input.startedAt.getTime() + IDEMPOTENCY_KEY_TTL_MS,
        );
        const inserted = await client.query<{ key: string }>(
          `
            INSERT INTO idempotency_key (
              key,
              request_method,
              request_path,
              request_body_hash,
              completed,
              created_at,
              expires_at
            ) VALUES ($1, $2, $3, $4, false, $5, $6)
            ON CONFLICT (key) DO NOTHING
            RETURNING key
          `,
          [
            input.key,
            input.method,
            input.path,
            input.bodyHash,
            input.startedAt,
            expiresAt,
          ],
        );

        if (inserted.rows[0]) {
          return {
            outcome: "started",
          };
        }

        const existing = await client.query<IdempotencyKeyRow>(
          `
            SELECT
              request_method,
              request_path,
              request_body_hash,
              response_status,
              response_body,
              completed
            FROM idempotency_key
            WHERE key = $1
          `,
          [input.key],
        );
        const row = requireRow(existing.rows[0], "idempotency_key");

        if (
          row.request_method !== input.method ||
          row.request_path !== input.path ||
          row.request_body_hash !== input.bodyHash
        ) {
          return {
            outcome: "mismatch",
          };
        }

        if (!row.completed || row.response_status === null) {
          return {
            outcome: "in_progress",
          };
        }

        return {
          body: row.response_body,
          outcome: "replay",
          status: row.response_status,
        };
      });
    },

    async completeRequest(input) {
      await pool.query(
        `
          UPDATE idempotency_key
          SET response_status = $2,
              response_body = $3,
              completed = true
          WHERE key = $1
        `,
        [input.key, input.status, input.body],
      );
    },
  };
}

async function deleteExpiredKey(
  client: Queryable,
  key: string,
  now: Date,
): Promise<void> {
  await client.query(
    `
      DELETE FROM idempotency_key
      WHERE key = $1
        AND expires_at <= $2
    `,
    [key, now],
  );
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
