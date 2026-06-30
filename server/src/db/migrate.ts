import type { PoolClient } from "pg";

import { withTransaction } from "./tx";
import type { DatabasePool } from "./client";
import { dbMigrations, type SqlMigration } from "./migrations";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const MIGRATION_LOCK_NAMESPACE = 6_253;
const MIGRATION_LOCK_KEY = 1;

export async function migrateDatabase(
  pool: DatabasePool,
  migrations: readonly SqlMigration[] = dbMigrations,
): Promise<MigrationResult> {
  return withTransaction(pool, async (client) => applyMigrations(client, migrations));
}

async function applyMigrations(
  client: PoolClient,
  migrations: readonly SqlMigration[],
): Promise<MigrationResult> {
  await acquireMigrationLock(client);
  await ensureSchemaMigrationTable(client);

  const existingMigrations = await client.query<{ name: string }>(
    "SELECT name FROM schema_migration",
  );
  const appliedMigrationNames = new Set(existingMigrations.rows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of migrations) {
    if (appliedMigrationNames.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }

    await client.query(migration.sql);
    await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [migration.name]);
    applied.push(migration.name);
  }

  return { applied, skipped };
}

async function ensureSchemaMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function acquireMigrationLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
    MIGRATION_LOCK_NAMESPACE,
    MIGRATION_LOCK_KEY,
  ]);
}
