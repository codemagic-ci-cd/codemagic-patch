import type { PoolClient } from "pg";

import type { ReleaseJobRow, ReleaseRow } from "./rowMappers";

/**
 * What a transaction that settles a release job hands to its hook: the rows
 * as that transaction leaves them, on the transaction's own client.
 */
export interface ReleaseSettledInput {
  client: PoolClient;
  /** Set when the job failed for good; null when it succeeded. */
  failure: { reason: string; stage: string } | null;
  jobRow: ReleaseJobRow;
  now: Date;
  releaseRow: ReleaseRow;
}

/**
 * Runs inside the settling transaction, just before it commits. It must not
 * throw: a hook that fails would take the release transition down with it, so
 * an implementation contains its own errors (see
 * `webhooks/recordReleaseEvent.ts`).
 */
export type ReleaseSettledHook = (input: ReleaseSettledInput) => Promise<void>;
