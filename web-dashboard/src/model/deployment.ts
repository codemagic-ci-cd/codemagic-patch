// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Server `Date` fields serialize to ISO strings on the wire.

export interface Deployment {
  id: string;
  appId: string;
  teamId: string;
  name: string;
  /** Immutable key used in CDN paths and the client SDK (config value, not a secret). */
  deploymentKey: string;
  createdAt: string;
  updatedAt: string;
}
