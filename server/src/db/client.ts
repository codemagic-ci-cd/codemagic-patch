import { Pool, type PoolConfig } from "pg";

export interface DatabasePoolOptions {
  connectionString: string;
  max?: number;
  searchPath?: string[];
}

export type DatabasePool = Pool;

export function createDatabasePool(options: DatabasePoolOptions): DatabasePool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max,
  };

  const searchPath = serializeSearchPath(options.searchPath);
  if (searchPath) {
    config.options = `-c search_path=${searchPath}`;
  }

  return new Pool(config);
}

function serializeSearchPath(searchPath: string[] | undefined): string | undefined {
  if (!searchPath || searchPath.length === 0) {
    return undefined;
  }

  return searchPath.map(quoteIdentifier).join(",");
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid PostgreSQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}
