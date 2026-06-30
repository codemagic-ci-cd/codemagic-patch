// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Server `Date` fields serialize to ISO strings on the wire; branded ids flatten to plain strings.

export type UserStatus = "active" | "disabled";

/** Wire shape of the server's `UserAccount` entity, as emitted by `GET /v1/users/me`. */
export interface User {
  id: string;
  email: string;
  displayName: string | null;
  status: UserStatus;
  oauthProvider: string | null;
  oauthSubject: string | null;
  createdAt: string;
  updatedAt: string;
}
