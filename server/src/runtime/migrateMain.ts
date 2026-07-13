import {
  createDatabasePool,
  migrateDatabase,
  type DatabasePool,
  type DatabasePoolOptions,
  type MigrationResult,
  type SqlMigration,
} from "../db";
import { resolveMigrationConfig } from "./migrationConfig";

type MigrationEnvironment = Record<string, string | undefined>;

export interface MigrationLogger {
  error(message: string, context?: Record<string, unknown>): void;
  log(message: string, context?: Record<string, unknown>): void;
}

export interface MigrationMainDependencies {
  createDatabasePool?: (options: DatabasePoolOptions) => DatabasePool;
  env?: MigrationEnvironment;
  logger?: MigrationLogger;
  migrateDatabase?: (
    pool: DatabasePool,
    migrations?: readonly SqlMigration[],
  ) => Promise<MigrationResult>;
  migrations?: readonly SqlMigration[];
  successMessage?: string;
}

const defaultLogger: MigrationLogger = {
  error(message, context) {
    if (context === undefined) {
      console.error(message);
      return;
    }

    console.error(message, context);
  },
  log(message, context) {
    if (context === undefined) {
      console.log(message);
      return;
    }

    console.log(message, context);
  },
};

export async function runMigrationMain(
  dependencies: MigrationMainDependencies = {},
): Promise<MigrationResult> {
  const logger = dependencies.logger ?? defaultLogger;
  const config = resolveMigrationConfig(dependencies.env);
  const pool = (dependencies.createDatabasePool ?? createDatabasePool)({
    connectionString: config.databaseUrl,
    max: config.databaseMaxConnections,
    searchPath: config.databaseSearchPath,
  });

  try {
    const runMigrations = dependencies.migrateDatabase ?? migrateDatabase;
    const result = dependencies.migrations
      ? await runMigrations(pool, dependencies.migrations)
      : await runMigrations(pool);

    logger.log(dependencies.successMessage ?? "database migrations complete", {
      applied: result.applied,
      skipped: result.skipped,
    });

    return result;
  } finally {
    await pool.end();
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

if (require.main === module) {
  void runMigrationMain().catch((error: unknown) => {
    defaultLogger.error("database migration failed", {
      error: formatErrorMessage(error),
    });
    process.exitCode = 1;
  });
}
