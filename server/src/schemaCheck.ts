/**
 * Read-only schema compatibility check: `node dist/schemaCheck.js [--json]`.
 *
 * Tells whether this server build can run against the configured database,
 * with the server's own connection settings (DATABASE_URL,
 * DATABASE_SEARCH_PATH, DATABASE_MAX_CONNECTIONS). It never writes: no
 * schema_migration table is created and no migration is applied.
 *
 * stdout: one JSON line (SchemaCheckResult). stderr: one human line.
 * Exit codes: 0 compatible (or a database no server has migrated yet),
 * 3 applied migrations this server does not know, 4 database unreachable or
 * the read failed, 2 usage. Exit 1 is never a verdict: it means node itself
 * failed (for example an image without this entry point).
 */
import { createDatabasePool } from "./db/client";
import {
  describeUnknownAppliedMigrations,
  findUnknownAppliedMigrations,
  readAppliedMigrationNames,
} from "./db/migrate";
import { dbMigrations } from "./db/migrations";
import { resolveMigrationConfig } from "./runtime/migrationConfig";
import { readServerVersion, serverLabel } from "./version";

const SCHEMA_CHECK_EXIT_CODES = {
  ok: 0,
  usage: 2,
  unknownMigrations: 3,
  unreachable: 4,
} as const;

export type SchemaCheckStatus = "ok" | "unknown-migrations" | "unreachable";

export interface SchemaCheckResult {
  schemaVersion: 1;
  status: SchemaCheckStatus;
  /** Applied migration names this server does not ship, sorted. */
  unknown: string[];
  /** Migrations this server ships. */
  known: number;
  /** Rows in schema_migration; 0 for a fresh or unreachable database. */
  applied: number;
  server: string;
}

export interface SchemaCheckOutcome {
  exitCode: number;
  /** Null only for a usage error, which prints no JSON. */
  result: SchemaCheckResult | null;
  /** The human line for stderr. */
  message: string;
}

export interface SchemaCheckDependencies {
  args?: readonly string[];
  connectionTimeoutMillis?: number;
}

const DEFAULT_TIMEOUT_MILLIS = 15_000;
const USAGE = "Usage: node dist/schemaCheck.js [--json]";

export async function runSchemaCheck(
  env: Record<string, string | undefined> = process.env,
  dependencies: SchemaCheckDependencies = {},
): Promise<SchemaCheckOutcome> {
  const unexpectedArgument = (dependencies.args ?? []).find((arg) => arg !== "--json");
  if (unexpectedArgument !== undefined) {
    return {
      exitCode: SCHEMA_CHECK_EXIT_CODES.usage,
      result: null,
      message: `Unknown argument: ${unexpectedArgument}. ${USAGE}`,
    };
  }

  const version = readServerVersion();
  const timeoutMillis = dependencies.connectionTimeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
  const result = (
    status: SchemaCheckStatus,
    unknown: string[],
    applied: number,
  ): SchemaCheckResult => ({
    schemaVersion: 1,
    status,
    unknown,
    known: dbMigrations.length,
    applied,
    server: version ?? "unknown",
  });

  let appliedNames: string[] | null;
  try {
    // Same configuration and pool as the migration entry point, so the check
    // reads exactly the database (and search path) the server would migrate.
    const config = resolveMigrationConfig(env);
    const pool = createDatabasePool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: timeoutMillis,
      max: config.databaseMaxConnections,
      searchPath: config.databaseSearchPath,
    });
    try {
      appliedNames = await readAppliedMigrationNames(pool, {
        statementTimeoutMillis: timeoutMillis,
      });
    } finally {
      await pool.end();
    }
  } catch (error) {
    return {
      exitCode: SCHEMA_CHECK_EXIT_CODES.unreachable,
      result: result("unreachable", [], 0),
      message: `Could not read the database's applied migrations: ${formatError(error)}`,
    };
  }

  if (appliedNames === null) {
    return {
      exitCode: SCHEMA_CHECK_EXIT_CODES.ok,
      result: result("ok", [], 0),
      message: `The database has no schema_migration table yet; ${serverLabel(version)} will create it.`,
    };
  }

  const unknown = findUnknownAppliedMigrations(appliedNames, dbMigrations);
  if (unknown.length > 0) {
    return {
      exitCode: SCHEMA_CHECK_EXIT_CODES.unknownMigrations,
      result: result("unknown-migrations", unknown, appliedNames.length),
      message: describeUnknownAppliedMigrations(unknown),
    };
  }

  return {
    exitCode: SCHEMA_CHECK_EXIT_CODES.ok,
    result: result("ok", [], appliedNames.length),
    message: `The database's ${appliedNames.length} applied migrations are all known to ${serverLabel(version)}, which ships ${dbMigrations.length}.`,
  };
}

function formatError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    // pg surfaces a refused connection to a dual-stack host this way, with an
    // empty message of its own.
    return error.errors.map(formatError).join("; ");
  }

  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

if (require.main === module) {
  void runSchemaCheck(process.env, { args: process.argv.slice(2) })
    .catch(
      (error: unknown): SchemaCheckOutcome => ({
        exitCode: SCHEMA_CHECK_EXIT_CODES.unreachable,
        result: null,
        message: `Schema check failed: ${formatError(error)}`,
      }),
    )
    .then((outcome) => {
      if (outcome.result) {
        process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
      }
      process.stderr.write(`${outcome.message}\n`);
      process.exitCode = outcome.exitCode;
    });
}
