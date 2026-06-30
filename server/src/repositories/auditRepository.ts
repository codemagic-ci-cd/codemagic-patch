import type { Pool } from "pg";

import type { AuditEvent, TeamId } from "../domain";
import type { DatabasePool } from "../db";
import {
  mapAuditEventRow,
  type AuditEventRow,
} from "./rowMappers";

export interface PersistAuditEventInput {
  action: string;
  actorId: string | null;
  actorType: string;
  afterState: Record<string, unknown> | null;
  beforeState: Record<string, unknown> | null;
  id: string;
  ip: string | null;
  requestId: string | null;
  resourceId: string;
  resourceType: string;
  result: "success" | "failure";
  teamId: TeamId;
  timestamp: Date;
  userAgent: string | null;
}

export interface AuditRepository {
  persistAuditEvent(input: PersistAuditEventInput): Promise<AuditEvent>;
}

export function createPostgresAuditRepository(
  pool: DatabasePool | Pool,
): AuditRepository {
  return {
    async persistAuditEvent(input) {
      const result = await pool.query<AuditEventRow>(
        `
          INSERT INTO audit_event (
            id,
            timestamp,
            team_id,
            actor_type,
            actor_id,
            action,
            resource_type,
            resource_id,
            before_state,
            after_state,
            ip,
            user_agent,
            request_id,
            result
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13, $14
          )
          RETURNING *
        `,
        [
          input.id,
          input.timestamp,
          input.teamId,
          input.actorType,
          input.actorId,
          input.action,
          input.resourceType,
          input.resourceId,
          input.beforeState,
          input.afterState,
          input.ip,
          input.userAgent,
          input.requestId,
          input.result,
        ],
      );

      return mapAuditEventRow(requireRow(result.rows[0], "audit_event"));
    },
  };
}

function requireRow<T>(row: T | undefined, tableName: string): T {
  if (!row) {
    throw new Error(`Expected ${tableName} row to exist`);
  }

  return row;
}
