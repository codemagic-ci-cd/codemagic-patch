import type { UploadPolicy } from "@codemagic/patch-shared";

export type OutputFormat = "json" | "table";

export type DeploymentSelector =
  | {
      deploymentId: string;
      teamId?: never;
      teamName?: never;
      appName?: never;
      deploymentName?: never;
    }
  | {
      deploymentId?: never;
      teamId?: never;
      teamName?: never;
      appName: string;
      deploymentName: string;
    }
  | {
      deploymentId?: never;
      teamId?: never;
      teamName: string;
      appName: string;
      deploymentName: string;
    }
  | {
      deploymentId?: never;
      teamId: string;
      teamName?: never;
      appName: string;
      deploymentName: string;
    };

export type ReleaseSelector =
  | {
      releaseId: string;
      deployment?: never;
      releaseLabel?: never;
    }
  | {
      releaseId?: never;
      deployment: DeploymentSelector;
      releaseLabel: string;
    };

export type ReleaseCreateCommand = {
  /**
   * Set when `--bundle-path` points at a `.cmpatch` artifact. Build identity
   * (fingerprint, target binary version, signature, sourcemap) is then read from
   * the artifact's descriptor rather than from flags, and the upload policy is
   * seeded from the artifact's baked-in defaults (see {@link policyOverrides}).
   */
  artifactUpload?: true;
  bundlePath: string;
  deployment: DeploymentSelector;
  disabled: boolean;
  dryRunBundleGenerated?: true;
  dryRunBundlePath?: string;
  dryRun: boolean;
  fingerprint?: string;
  isMandatory: boolean;
  kind: "release-create";
  nonInteractive?: true;
  noDuplicateReleaseError: boolean;
  platform?: "android" | "ios";
  /**
   * The policy flags the caller set explicitly, used only on the artifact path to
   * override the artifact's baked-in defaults. Absent flags fall back to those
   * defaults rather than to the CLI's own defaults.
   */
  policyOverrides?: Partial<UploadPolicy>;
  privateKeyPath?: string;
  projectRoot: string;
  releaseNotes?: string;
  rolloutPercentage: number;
  serverUrl: string;
  sourcemapPath?: string;
  /** Optional only on the artifact path, where it comes from the descriptor. */
  targetBinaryVersion?: string;
  token?: string;
  yes?: true;
};

export type ReactBuildOptions = {
  baseBytecode: "auto" | "off";
  bundlerArgs?: string[];
  buildConfigurationName?: string;
  bundler: "auto" | "expo" | "metro";
  entryFile?: string;
  extraHermesFlags: string[];
  gradleFile?: string;
  hermes: "auto" | "false" | "true";
  platform: "android" | "ios";
  plistFile?: string;
  plistFilePrefix?: string;
  privateKeyPath?: string;
  projectRoot: string;
  sourcemapOutputPath?: string;
  targetBinaryVersion?: string;
  xcodeProjectFile?: string;
  xcodeTargetName?: string;
};

export type ReleaseReactCommand = {
  baseBytecode: "auto" | "off";
  bundlerArgs?: string[];
  buildConfigurationName?: string;
  bundler: "auto" | "expo" | "metro";
  deployment: DeploymentSelector;
  disabled: boolean;
  dryRun: boolean;
  entryFile?: string;
  extraHermesFlags: string[];
  gradleFile?: string;
  hermes: "auto" | "false" | "true";
  isMandatory: boolean;
  kind: "release-react";
  nonInteractive?: true;
  noDuplicateReleaseError: boolean;
  platform: "android" | "ios";
  plistFile?: string;
  plistFilePrefix?: string;
  privateKeyPath?: string;
  projectRoot: string;
  releaseNotes?: string;
  rolloutPercentage: number;
  serverUrl: string;
  sourcemapOutputPath?: string;
  targetBinaryVersion?: string;
  token?: string;
  xcodeProjectFile?: string;
  xcodeTargetName?: string;
  yes?: true;
};

export type BundleCommand = ReactBuildOptions & {
  disabled: boolean;
  isMandatory: boolean;
  kind: "bundle";
  noDuplicateReleaseError: boolean;
  outputPath?: string;
  releaseNotes?: string;
  rolloutPercentage: number;
};

export type TeamSelector =
  | {
      teamId: string;
      teamName?: never;
    }
  | {
      teamId?: never;
      teamName: string;
    }
  | {
      teamId?: never;
      teamName?: never;
    };

export type AppTeamSelector = TeamSelector;

export type AppSelector =
  | {
      appId: string;
      appName?: never;
      teamId?: never;
      teamName?: never;
    }
  | {
      appId?: never;
      appName: string;
      teamId?: never;
      teamName?: never;
    }
  | {
      appId?: never;
      appName: string;
      teamId?: never;
      teamName: string;
    }
  | {
      appId?: never;
      appName: string;
      teamId: string;
      teamName?: never;
    };

export type AppCreateCommand = {
  kind: "app-create";
  name: string;
  requireCodeSigning: boolean;
  serverUrl: string;
  team: AppTeamSelector;
  token?: string;
};

export type AppRenameCommand = {
  app: AppSelector;
  kind: "app-rename";
  name: string;
  serverUrl: string;
  token?: string;
};

export type AppSettingCommand = {
  app: AppSelector;
  kind: "app-setting";
  requireCodeSigning: boolean;
  serverUrl: string;
  token?: string;
};

export type AppRemoveCommand = {
  app: AppSelector;
  kind: "app-remove";
  serverUrl: string;
  token?: string;
};

export type WhoamiCommand = {
  kind: "whoami";
  serverUrl: string;
  token?: string;
};

export type TokenCreateCommand = {
  expiresInDays?: number;
  kind: "token-create";
  name: string;
  serverUrl: string;
  token?: string;
};

export type TokenListCommand = {
  kind: "token-list";
  serverUrl: string;
  token?: string;
};

export type TokenRevokeCommand = {
  kind: "token-revoke";
  serverUrl: string;
  token?: string;
  tokenId: string;
};

export type LoginCommand = {
  kind: "login";
  nonInteractive?: true;
  serverUrl: string;
  timeoutSeconds?: number;
  token?: string;
};

export type LogoutCommand = {
  kind: "logout";
  serverUrl: string;
};

export type MemberUserSelector =
  | {
      email: string;
      userId?: never;
    }
  | {
      email?: never;
      userId: string;
    };

export type MemberListCommand = {
  format?: OutputFormat;
  kind: "member-list";
  serverUrl: string;
  team: TeamSelector;
  token?: string;
};

export type MemberAddCommand = {
  kind: "member-add";
  roleKey: string;
  serverUrl: string;
  team: TeamSelector;
  token?: string;
  user: MemberUserSelector;
};

// Exactly one of email | githubHandle, mirroring MemberUserSelector.
export type MemberInviteTarget =
  | {
      email: string;
      githubHandle?: never;
    }
  | {
      email?: never;
      githubHandle: string;
    };

export type MemberInviteCommand = {
  expiresInDays?: number;
  kind: "member-invite";
  roleKey: string;
  serverUrl: string;
  target: MemberInviteTarget;
  team: TeamSelector;
  token?: string;
};

export type MemberProvisionCommand = {
  displayName?: string;
  email: string;
  expiresInDays?: number;
  kind: "member-provision";
  roleKey: string;
  serverUrl: string;
  team: TeamSelector;
  token?: string;
  tokenDisplayName?: string;
};

export type MemberInviteListCommand = {
  format?: OutputFormat;
  kind: "member-invite-list";
  serverUrl: string;
  status?: "pending" | "accepted" | "revoked" | "expired" | "all";
  team: TeamSelector;
  token?: string;
};

export type MemberInviteRevokeCommand = {
  invitationId: string;
  kind: "member-invite-revoke";
  serverUrl: string;
  token?: string;
};

export type MemberRemoveCommand =
  | {
      bindingId: string;
      kind: "member-remove";
      roleKey?: never;
      serverUrl: string;
      team?: never;
      token?: string;
      user?: never;
    }
  | {
      bindingId?: never;
      kind: "member-remove";
      roleKey: string;
      serverUrl: string;
      team: TeamSelector;
      token?: string;
      user: MemberUserSelector;
    };

export type ReleaseShowCommand = {
  kind: "release-show";
  release: ReleaseSelector;
  serverUrl: string;
  token?: string;
};

export type ReleaseInspectCommand = {
  format?: OutputFormat;
  kind: "release-inspect";
  logs: boolean;
  release: ReleaseSelector;
  serverUrl: string;
  timeoutSeconds: number;
  token?: string;
  wait: boolean;
};

export type ReleaseListCommand = {
  deployment: DeploymentSelector;
  format?: OutputFormat;
  includeMetrics?: boolean;
  kind: "release-list";
  limit?: number;
  offset?: number;
  serverUrl: string;
  token?: string;
};

export type DeploymentMetricsCommand = {
  deployment: DeploymentSelector;
  format?: OutputFormat;
  kind: "deployment-metrics";
  limit?: number;
  offset?: number;
  serverUrl: string;
  token?: string;
};

export type ReleaseMetricsCommand = {
  format?: OutputFormat;
  kind: "release-metrics";
  release: ReleaseSelector;
  serverUrl: string;
  token?: string;
};

export type AppListCommand = {
  format?: OutputFormat;
  kind: "app-list";
  serverUrl: string;
  team: TeamSelector;
  token?: string;
};

export type AppShowCommand = {
  app: AppSelector;
  kind: "app-show";
  serverUrl: string;
  token?: string;
};

export type DeploymentListCommand = {
  app: AppSelector;
  format?: OutputFormat;
  kind: "deployment-list";
  serverUrl: string;
  token?: string;
};

export type DeploymentCreateCommand = {
  app: AppSelector;
  kind: "deployment-create";
  name: string;
  serverUrl: string;
  token?: string;
};

export type DeploymentRenameCommand = {
  deployment: DeploymentSelector;
  kind: "deployment-rename";
  name: string;
  serverUrl: string;
  token?: string;
};

export type DeploymentRemoveCommand = {
  deployment: DeploymentSelector;
  kind: "deployment-remove";
  serverUrl: string;
  token?: string;
};

export type DeploymentClearCommand = {
  deployment: DeploymentSelector;
  kind: "deployment-clear";
  nonInteractive?: true;
  serverUrl: string;
  token?: string;
  yes?: true;
};

export type ConfigCommand = {
  argv: string[];
  kind: "config";
};

export type InitCommand = {
  argv: string[];
  kind: "init";
};

export type ContextCommand = {
  argv: string[];
  kind: "context";
};

export type FingerprintCommand = {
  format: "json" | "table" | "text";
  kind: "fingerprint";
  platform: "android" | "ios";
  projectRoot: string;
  verbose: boolean;
};

export type ReleasePatchCommand = {
  kind: "release-patch";
  nonInteractive?: true;
  patch: {
    is_mandatory?: boolean;
    release_notes?: string;
    rollout_percentage?: number;
    status?: "disabled" | "published";
    target_binary_version?: string;
  };
  release: ReleaseSelector;
  serverUrl: string;
  token?: string;
  yes?: true;
};

export type ReleasePromoteCommand = {
  destinationDeployment: DeploymentSelector;
  disabled: boolean;
  isMandatory?: boolean;
  kind: "release-promote";
  nonInteractive?: true;
  noDuplicateReleaseError: boolean;
  releaseNotes?: string;
  rolloutPercentage: number;
  serverUrl: string;
  sourceRelease: ReleaseSelector;
  targetBinaryVersion?: string;
  token?: string;
  yes?: true;
};

export type ReleaseRollbackCommand = {
  deployment: DeploymentSelector;
  kind: "release-rollback";
  nonInteractive?: true;
  serverUrl: string;
  targetReleaseLabel?: string;
  token?: string;
  yes?: true;
};

export type DebugCommand = {
  kind: "debug";
  platform: "android" | "ios";
};

export type DoctorCommand = {
  app?: string;
  appId?: string;
  bundler?: string;
  downloadBaseUrl?: string;
  currentPackageHash?: string;
  deployment?: string;
  deploymentId?: string;
  deploymentKey?: string;
  format?: OutputFormat;
  kind: "doctor";
  platform?: "android" | "ios";
  projectRoot: string;
  serverUrl?: string;
  targetBinaryVersion?: string;
  team?: string;
  teamId?: string;
  token?: string;
  verbose: boolean;
};

export type CliCommand =
  | AppCreateCommand
  | AppListCommand
  | AppRenameCommand
  | AppSettingCommand
  | AppShowCommand
  | AppRemoveCommand
  | BundleCommand
  | ConfigCommand
  | ContextCommand
  | DeploymentClearCommand
  | DeploymentCreateCommand
  | DeploymentListCommand
  | DeploymentMetricsCommand
  | DeploymentRenameCommand
  | DeploymentRemoveCommand
  | DebugCommand
  | DoctorCommand
  | FingerprintCommand
  | InitCommand
  | MemberAddCommand
  | MemberInviteCommand
  | MemberInviteListCommand
  | MemberInviteRevokeCommand
  | MemberListCommand
  | MemberProvisionCommand
  | MemberRemoveCommand
  | ReleaseCreateCommand
  | ReleaseInspectCommand
  | ReleaseReactCommand
  | ReleaseListCommand
  | ReleaseMetricsCommand
  | ReleasePatchCommand
  | ReleasePromoteCommand
  | ReleaseRollbackCommand
  | ReleaseShowCommand
  | TokenCreateCommand
  | TokenListCommand
  | TokenRevokeCommand
  | LoginCommand
  | LogoutCommand
  | WhoamiCommand
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | { argv: string[]; kind: "not-implemented" };

export type ParseCliResult =
  | { command: CliCommand; ok: true }
  | {
      error: string;
      examples?: string[];
      helpTopic?: string;
      ok: false;
      showHelp: boolean;
      suggestion?: string;
    };

export type ParseCliError = Extract<ParseCliResult, { ok: false }>;

export type CommandDefaultFlagValues = Partial<
  Record<
    | "app"
    | "bundler"
    | "deployment"
    | "platform"
    | "serverUrl"
    | "team"
    | "teamId",
    string
  >
>;
