import { workerMvpMigration } from "./0001_workerMvp";
import { controlPlaneAuthMigration } from "./0002_controlPlaneAuth";
import { nullableReleaseFingerprintMigration } from "./0003_nullableReleaseFingerprint";
import { releaseBundleSourceMigration } from "./0004_releaseBundleSource";
import { phase4FoundationsMigration } from "./0005_phase4Foundations";
import { releaseRolloutRangeMigration } from "./0006_releaseRolloutRange";
import { phase6ManagementCrudPermissionsMigration } from "./0007_phase6ManagementCrudPermissions";
import { oauthSessionAuthMigration } from "./0008_oauthSessionAuth";
import { teamInvitationMigration } from "./0009_teamInvitation";
import { metricEventClientSpecAlignmentMigration } from "./0010_metricEventClientSpecAlignment";
import { teamInvitationGithubHandleMigration } from "./0011_teamInvitationGithubHandle";
import { teamInvitationStatusFieldsMigration } from "./0012_teamInvitationStatusFields";
import { githubActionsIntegrationMigration } from "./0013_githubActionsIntegration";

export interface SqlMigration {
  name: string;
  sql: string;
}

export const dbMigrations: readonly SqlMigration[] = [
  workerMvpMigration,
  controlPlaneAuthMigration,
  nullableReleaseFingerprintMigration,
  releaseBundleSourceMigration,
  phase4FoundationsMigration,
  releaseRolloutRangeMigration,
  phase6ManagementCrudPermissionsMigration,
  oauthSessionAuthMigration,
  teamInvitationMigration,
  metricEventClientSpecAlignmentMigration,
  teamInvitationGithubHandleMigration,
  teamInvitationStatusFieldsMigration,
  githubActionsIntegrationMigration,
];
