import { resolveDatabaseSearchPath } from "./databaseSearchPath";

export interface MigrationConfig {
  databaseMaxConnections?: number;
  databaseSearchPath: string[];
  databaseUrl: string;
}

type MigrationEnvironment = Record<string, string | undefined>;

export function resolveMigrationConfig(
  env: MigrationEnvironment = process.env,
): MigrationConfig {
  const databaseUrl = resolveOptionalString(env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database migrations");
  }

  return {
    databaseMaxConnections: resolveOptionalPositiveInteger(
      env.DATABASE_MAX_CONNECTIONS,
      "DATABASE_MAX_CONNECTIONS",
    ),
    databaseSearchPath: resolveDatabaseSearchPath(env.DATABASE_SEARCH_PATH),
    databaseUrl,
  };
}

function resolveOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();

  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function resolveOptionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${name} must be a positive decimal integer. Received: ${value}`,
    );
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive decimal integer. Received: ${value}`,
    );
  }

  return parsed;
}
