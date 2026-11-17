import type { PoolClient } from "pg";

import { readServerVersion, serverLabel } from "../version";
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
  // An applied migration this server does not ship means a newer server
  // already migrated this database: refuse to run an older server on it.
  const unknownMigrationNames = findUnknownAppliedMigrations(appliedMigrationNames, migrations);
  if (unknownMigrationNames.length > 0) {
    throw new Error(describeUnknownAppliedMigrations(unknownMigrationNames));
  }

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

/** Applied migration names this server does not ship, sorted. */
export function findUnknownAppliedMigrations(
  appliedMigrationNames: Iterable<string>,
  migrations: readonly SqlMigration[],
): string[] {
  const knownMigrationNames = new Set(migrations.map((migration) => migration.name));

  return [...appliedMigrationNames].filter((name) => !knownMigrationNames.has(name)).sort();
}

export function describeUnknownAppliedMigrations(
  unknownMigrationNames: readonly string[],
): string {
  return `The database has migrations this server does not know (${unknownMigrationNames.join(", ")}); ${serverLabel(readServerVersion())} is older than the one that last migrated the database. Start the newer server version instead, or restore the database from a backup taken before those migrations.`;
}

export interface AppliedMigrationsReadOptions {
  /** Server-side cap for each statement, so a held lock cannot stall the read. */
  statementTimeoutMillis?: number;
}

/**
 * Reads the names in schema_migration without changing anything: a READ ONLY
 * transaction, no advisory lock, no CREATE TABLE. Returns null when the table
 * does not exist on the search path (a database no server has migrated yet).
 */
export async function readAppliedMigrationNames(
  pool: DatabasePool,
  options: AppliedMigrationsReadOptions = {},
): Promise<string[] | null> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN READ ONLY");
    if (options.statementTimeoutMillis !== undefined) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(options.statementTimeoutMillis),
      ]);
    }

    const table = await client.query<{ present: boolean }>(
      "SELECT to_regclass('schema_migration') IS NOT NULL AS present",
    );
    const names = table.rows[0]?.present
      ? (
          await client.query<{ name: string }>(
            "SELECT name FROM schema_migration ORDER BY name",
          )
        ).rows.map((row) => row.name)
      : null;

    await client.query("ROLLBACK");
    client.release();
    return names;
  } catch (error) {
    // Drop the connection rather than return a possibly broken one to the pool.
    client.release(true);
    throw error;
  }
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
