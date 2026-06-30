// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Token endpoints emit `ApiTokenResponse` (server/src/plugins/api/routeTypes.ts
// via `toApiTokenResponse`): the domain `ApiTokenMetadata` minus `userId`,
// dates as ISO strings. The plaintext secret travels separately (show-once).

export interface ApiTokenMetadata {
  id: string;
  displayName: string;
  maskedPrefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
