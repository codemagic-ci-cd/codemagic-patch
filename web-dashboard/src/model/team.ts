// Wire-shape DTOs derived from server/src/domain/types.ts @ 25b9477
// Server `Date` fields serialize to ISO strings on the wire.

export type TeamStatus = "active" | "disabled";

export interface Team {
  id: string;
  name: string;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
}
