import type { Pool } from "pg";

import type { DatabasePool } from "../db";
import { withTransaction } from "../db";
import type { RoleDefinitionId, Team } from "../domain";
import {
  createTeamForUserInTransaction,
  type CreateTeamForUserInput,
  type CreateTeamForUserResult,
} from "./authRepository";
import {
  createTeamInvitationInTransaction,
  type CreateTeamInvitationInput,
  type CreateTeamInvitationResult,
} from "./iamInvitationRepository";
import {
  createTeamInTransaction,
  type CreateTeamInput,
} from "./managementRepository";

const OWNER_ROLE_DEFINITION_ID = "role_owner" as RoleDefinitionId;

export interface CreateTeamWithOwnerInvitationInput {
  invitation: Omit<CreateTeamInvitationInput, "roleId" | "teamId">;
  /** With `userId` the caller also becomes owner and member (createTeamForUser). */
  team: CreateTeamForUserInput | CreateTeamInput;
}

export type CreateTeamWithOwnerInvitationResult =
  | {
      invitation: CreateTeamInvitationResult;
      outcome: "created";
      team: Team;
    }
  | {
      // Rolled back: no team row was written.
      invitation: CreateTeamInvitationResult;
      outcome: "invitation_refused";
    }
  | Exclude<CreateTeamForUserResult, { outcome: "created" }>;

export interface TeamOwnerInvitationRepository {
  createTeamWithOwnerInvitation(
    input: CreateTeamWithOwnerInvitationInput,
  ): Promise<CreateTeamWithOwnerInvitationResult>;
}

// withTransaction commits whatever the callback returns, so a refused
// invitation is thrown to roll the new team back.
class OwnerInvitationRefused extends Error {
  constructor(readonly result: CreateTeamInvitationResult) {
    super("owner invitation refused");
  }
}

export function createPostgresTeamOwnerInvitationRepository(
  pool: DatabasePool | Pool,
): TeamOwnerInvitationRepository {
  return {
    async createTeamWithOwnerInvitation(input) {
      try {
        return await withTransaction(pool, async (client) => {
          const created =
            "userId" in input.team
              ? await createTeamForUserInTransaction(client, input.team)
              : await createTeamInTransaction(client, input.team);
          if (created.outcome !== "created") {
            return created;
          }

          const invitation = await createTeamInvitationInTransaction(client, {
            ...input.invitation,
            roleId: OWNER_ROLE_DEFINITION_ID,
            teamId: created.team.id,
          });
          if (!grantsOwner(invitation)) {
            throw new OwnerInvitationRefused(invitation);
          }

          return {
            invitation,
            outcome: "created",
            team: created.team,
          };
        });
      } catch (error) {
        if (error instanceof OwnerInvitationRefused) {
          return {
            invitation: error.result,
            outcome: "invitation_refused",
          };
        }

        throw error;
      }
    },
  };
}

function grantsOwner(result: CreateTeamInvitationResult): boolean {
  return (
    result.outcome === "accepted_existing_user" ||
    result.outcome === "already_exists" ||
    result.outcome === "already_granted" ||
    result.outcome === "created"
  );
}
