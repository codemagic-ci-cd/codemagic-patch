import type { Pool, PoolClient } from "pg";

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let shouldReleaseClient = true;

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    shouldReleaseClient = await rollbackTransaction(client);
    throw error;
  } finally {
    if (shouldReleaseClient) {
      client.release();
    }
  }
}

async function rollbackTransaction(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    client.release(true);
    return false;
  }
}
