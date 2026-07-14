import type { UploadPolicy } from "@codemagic/patch-shared";

import type {
  AppSelector,
  CommandDefaultFlagValues,
  DeploymentSelector,
  MemberInviteTarget,
  MemberUserSelector,
  OutputFormat,
  ParseCliError,
  ParseCliResult,
  ReleasePatchCommand,
  ReleaseSelector,
  TeamSelector,
} from "./commandTypes";

/** Build-identity flags that a `.cmpatch` artifact supplies from its descriptor. */
const ARTIFACT_FORBIDDEN_FLAGS: ReadonlyArray<
  [internal: string, publicName: string]
> = [
    ["targetBinaryVersion", "target-binary-version"],
    ["fingerprint", "fingerprint"],
    ["privateKeyPath", "private-key-path"],
    ["sourcemap", "sourcemap"],
  ];

type BooleanFlagSchema = {
  kind: "boolean";
};

type IntegerFlagSchema = {
  kind: "integer";
};

type StringFlagSchema = {
  kind: "string";
};

type StringListFlagSchema = {
  kind: "stringList";
};

type FlagSchema =
  | BooleanFlagSchema
  | IntegerFlagSchema
  | StringFlagSchema
  | StringListFlagSchema;

type FlagValue = boolean | number | string | string[];

type FlagDescriptor = {
  descriptor: FlagSchema;
  key: string;
};

type FlagSchemaDefinition = {
  byInternalKey: Record<string, FlagSchema>;
  byPublicName: Map<string, FlagDescriptor>;
};

const flagSchemaDefinitions = new WeakMap<
  Record<string, FlagSchema>,
  FlagSchemaDefinition
>();

const BOOLEAN_FLAG: BooleanFlagSchema = { kind: "boolean" };
const INTEGER_FLAG: IntegerFlagSchema = { kind: "integer" };
const STRING_FLAG: StringFlagSchema = { kind: "string" };
const STRING_LIST_FLAG: StringListFlagSchema = { kind: "stringList" };
const globalFlagSchema: Record<string, FlagSchema> = {
  format: STRING_FLAG,
};

const contextSchema: Record<string, FlagSchema> = {
  projectRoot: STRING_FLAG,
  remote: BOOLEAN_FLAG,
  token: STRING_FLAG,
};

const releaseCreateSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  bundlePath: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  disabled: BOOLEAN_FLAG,
  dryRun: BOOLEAN_FLAG,
  fingerprint: STRING_FLAG,
  mandatory: BOOLEAN_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  noDuplicateReleaseError: BOOLEAN_FLAG,
  privateKeyPath: STRING_FLAG,
  releaseNotes: STRING_FLAG,
  rolloutPercentage: INTEGER_FLAG,
  platform: STRING_FLAG,
  projectRoot: STRING_FLAG,
  serverUrl: STRING_FLAG,
  sourcemap: STRING_FLAG,
  targetBinaryVersion: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const releaseReactSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  baseBytecode: STRING_FLAG,
  buildConfigurationName: STRING_FLAG,
  bundler: STRING_FLAG,
  bundlerArgs: STRING_LIST_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  disabled: BOOLEAN_FLAG,
  dryRun: BOOLEAN_FLAG,
  entryFile: STRING_FLAG,
  extraHermesFlag: STRING_LIST_FLAG,
  hermes: STRING_FLAG,
  mandatory: BOOLEAN_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  noDuplicateReleaseError: BOOLEAN_FLAG,
  platform: STRING_FLAG,
  plistFile: STRING_FLAG,
  plistFilePrefix: STRING_FLAG,
  privateKeyPath: STRING_FLAG,
  projectRoot: STRING_FLAG,
  releaseNotes: STRING_FLAG,
  rolloutPercentage: INTEGER_FLAG,
  gradleFile: STRING_FLAG,
  serverUrl: STRING_FLAG,
  sourcemapOutput: STRING_FLAG,
  targetBinaryVersion: STRING_FLAG,
  token: STRING_FLAG,
  xcodeProjectFile: STRING_FLAG,
  xcodeTargetName: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const bundleSchema: Record<string, FlagSchema> = {
  baseBytecode: STRING_FLAG,
  buildConfigurationName: STRING_FLAG,
  bundler: STRING_FLAG,
  bundlerArgs: STRING_LIST_FLAG,
  disabled: BOOLEAN_FLAG,
  entryFile: STRING_FLAG,
  extraHermesFlag: STRING_LIST_FLAG,
  gradleFile: STRING_FLAG,
  hermes: STRING_FLAG,
  mandatory: BOOLEAN_FLAG,
  noDuplicateReleaseError: BOOLEAN_FLAG,
  output: STRING_FLAG,
  platform: STRING_FLAG,
  plistFile: STRING_FLAG,
  plistFilePrefix: STRING_FLAG,
  privateKeyPath: STRING_FLAG,
  projectRoot: STRING_FLAG,
  releaseNotes: STRING_FLAG,
  rolloutPercentage: INTEGER_FLAG,
  sourcemapOutput: STRING_FLAG,
  targetBinaryVersion: STRING_FLAG,
  xcodeProjectFile: STRING_FLAG,
  xcodeTargetName: STRING_FLAG,
};

const releaseShowSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  label: STRING_FLAG,
  releaseId: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const releaseMetricsSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  format: STRING_FLAG,
  label: STRING_FLAG,
  releaseId: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const releaseInspectSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  format: STRING_FLAG,
  label: STRING_FLAG,
  logs: BOOLEAN_FLAG,
  releaseId: STRING_FLAG,
  serverUrl: STRING_FLAG,
  timeout: INTEGER_FLAG,
  timeoutSeconds: INTEGER_FLAG,
  token: STRING_FLAG,
  wait: BOOLEAN_FLAG,
};

const releaseListSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  format: STRING_FLAG,
  include: STRING_FLAG,
  limit: INTEGER_FLAG,
  offset: INTEGER_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const releasePatchSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  label: STRING_FLAG,
  mandatory: BOOLEAN_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  notMandatory: BOOLEAN_FLAG,
  releaseId: STRING_FLAG,
  releaseNotes: STRING_FLAG,
  rolloutPercentage: INTEGER_FLAG,
  serverUrl: STRING_FLAG,
  status: STRING_FLAG,
  targetBinaryVersion: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const releaseStatusSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  label: STRING_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  releaseId: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const releasePromoteSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  destDeployment: STRING_FLAG,
  destDeploymentId: STRING_FLAG,
  disabled: BOOLEAN_FLAG,
  label: STRING_FLAG,
  mandatory: BOOLEAN_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  noDuplicateReleaseError: BOOLEAN_FLAG,
  notMandatory: BOOLEAN_FLAG,
  releaseId: STRING_FLAG,
  releaseNotes: STRING_FLAG,
  rolloutPercentage: INTEGER_FLAG,
  serverUrl: STRING_FLAG,
  sourceDeployment: STRING_FLAG,
  sourceDeploymentId: STRING_FLAG,
  targetBinaryVersion: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const releaseRollbackSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  label: STRING_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const appCreateSchema: Record<string, FlagSchema> = {
  name: STRING_FLAG,
  requireCodeSigning: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const whoamiSchema: Record<string, FlagSchema> = {
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const tokenCreateSchema: Record<string, FlagSchema> = {
  expiresInDays: INTEGER_FLAG,
  name: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const tokenListSchema: Record<string, FlagSchema> = {
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const tokenRevokeSchema: Record<string, FlagSchema> = {
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  tokenId: STRING_FLAG,
};

const loginSchema: Record<string, FlagSchema> = {
  nonInteractive: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  timeoutSeconds: INTEGER_FLAG,
  token: STRING_FLAG,
};

const logoutSchema: Record<string, FlagSchema> = {
  serverUrl: STRING_FLAG,
};

const memberListSchema: Record<string, FlagSchema> = {
  format: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const memberAddSchema: Record<string, FlagSchema> = {
  email: STRING_FLAG,
  role: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  userId: STRING_FLAG,
};

const memberInviteSchema: Record<string, FlagSchema> = {
  email: STRING_FLAG,
  expiresInDays: INTEGER_FLAG,
  githubHandle: STRING_FLAG,
  role: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const memberProvisionSchema: Record<string, FlagSchema> = {
  displayName: STRING_FLAG,
  email: STRING_FLAG,
  expiresInDays: INTEGER_FLAG,
  role: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  tokenDisplayName: STRING_FLAG,
};

const memberInviteListSchema: Record<string, FlagSchema> = {
  format: STRING_FLAG,
  serverUrl: STRING_FLAG,
  status: STRING_FLAG,
  token: STRING_FLAG,
};

const memberInviteRevokeSchema: Record<string, FlagSchema> = {
  invitationId: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const memberRemoveSchema: Record<string, FlagSchema> = {
  bindingId: STRING_FLAG,
  email: STRING_FLAG,
  role: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  userId: STRING_FLAG,
};

const appListSchema: Record<string, FlagSchema> = {
  format: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const appShowSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const appRenameSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  newName: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const appSettingSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  requireCodeSigning: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const appRemoveSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const MAX_TOKEN_EXPIRATION_DAYS = 3650;

const deploymentListSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  format: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const deploymentCreateSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  name: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const deploymentRenameSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  newName: STRING_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const deploymentRemoveSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const deploymentClearSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  nonInteractive: BOOLEAN_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const deploymentHistorySchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  limit: INTEGER_FLAG,
  offset: INTEGER_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
  yes: BOOLEAN_FLAG,
};

const deploymentMetricsSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  format: STRING_FLAG,
  limit: INTEGER_FLAG,
  offset: INTEGER_FLAG,
  serverUrl: STRING_FLAG,
  token: STRING_FLAG,
};

const fingerprintSchema: Record<string, FlagSchema> = {
  format: STRING_FLAG,
  platform: STRING_FLAG,
  projectRoot: STRING_FLAG,
  verbose: BOOLEAN_FLAG,
};

const debugSchema: Record<string, FlagSchema> = {};

const doctorSchema: Record<string, FlagSchema> = {
  app: STRING_FLAG,
  appId: STRING_FLAG,
  bundler: STRING_FLAG,
  downloadBaseUrl: STRING_FLAG,
  currentPackageHash: STRING_FLAG,
  deployment: STRING_FLAG,
  deploymentId: STRING_FLAG,
  deploymentKey: STRING_FLAG,
  format: STRING_FLAG,
  platform: STRING_FLAG,
  projectRoot: STRING_FLAG,
  serverUrl: STRING_FLAG,
  targetBinaryVersion: STRING_FLAG,
  token: STRING_FLAG,
  verbose: BOOLEAN_FLAG,
};

function toKebabCase(flagName: string): string {
  return flagName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function flagSchemaDefinition(
  schema: Record<string, FlagSchema>,
): FlagSchemaDefinition {
  const cached = flagSchemaDefinitions.get(schema);
  if (cached) {
    return cached;
  }

  const byPublicName = new Map<string, FlagDescriptor>();
  for (const [key, descriptor] of Object.entries(schema)) {
    const publicName = toKebabCase(key);
    if (byPublicName.has(publicName)) {
      throw new Error(`Duplicate flag name --${publicName}`);
    }
    byPublicName.set(publicName, { descriptor, key });
  }

  const definition = {
    byInternalKey: schema,
    byPublicName,
  };
  flagSchemaDefinitions.set(schema, definition);
  return definition;
}

function ensureString(
  flags: Record<string, FlagValue>,
  key: string,
  label: string,
): string | ParseCliError {
  const value = flags[key];

  if (typeof value !== "string" || value.length === 0) {
    return {
      error: `Missing required flag --${label}`,
      ok: false,
      showHelp: true,
    };
  }

  return value;
}

function ensureNonBlankString(
  flags: Record<string, FlagValue>,
  key: string,
  label: string,
): string | ParseCliError {
  const value = ensureString(flags, key, label);

  if (isParseError(value)) {
    return value;
  }

  if (value.trim().length === 0) {
    return {
      error: `Missing required flag --${label}`,
      ok: false,
      showHelp: true,
    };
  }

  return value;
}

function isParseError(value: unknown): value is ParseCliError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false
  );
}

function parseOutputFormat(
  flags: Record<string, FlagValue>,
): OutputFormat | undefined | ParseCliError {
  const format = typeof flags.format === "string" ? flags.format : undefined;

  if (format === undefined) {
    return undefined;
  }

  if (format !== "json" && format !== "table") {
    return {
      error: "--format must be either json or table",
      ok: false,
      showHelp: true,
    };
  }

  return format;
}

function parsePagination(
  flags: Record<string, FlagValue>,
  defaults: { limit?: number } = {},
): { limit?: number; offset?: number } | ParseCliError {
  const limit =
    typeof flags.limit === "number" ? flags.limit : defaults.limit;

  if (limit !== undefined && (limit < 1 || limit > 100)) {
    return {
      error: "--limit must be an integer between 1 and 100",
      ok: false,
      showHelp: true,
    };
  }

  const offset = typeof flags.offset === "number" ? flags.offset : undefined;

  if (offset !== undefined && offset < 0) {
    return {
      error: "--offset must be an integer greater than or equal to 0",
      ok: false,
      showHelp: true,
    };
  }

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

function parseRolloutPercentage(
  flags: Record<string, FlagValue>,
): number | undefined | ParseCliError {
  const rolloutPercentageValue = flags.rolloutPercentage;

  const value =
    typeof rolloutPercentageValue === "number"
      ? rolloutPercentageValue
      : undefined;

  if (value !== undefined && (value < 1 || value > 100)) {
    return {
      error: "--rollout-percentage must be an integer between 1 and 100",
      ok: false,
      showHelp: true,
    };
  }

  return value;
}

function hasFlag(flags: Record<string, FlagValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key);
}

function readStringFlag(
  flags: Record<string, FlagValue>,
  key: string,
): string | undefined {
  return typeof flags[key] === "string" ? flags[key] : undefined;
}

function parseBundlePath(
  flags: Record<string, FlagValue>,
): string | ParseCliError {
  const bundlePath =
    typeof flags.bundlePath === "string" ? flags.bundlePath : undefined;

  if (bundlePath !== undefined && bundlePath.length > 0) {
    return bundlePath;
  }

  return {
    error: "Missing required flag --bundle-path",
    ok: false,
    showHelp: true,
  };
}

function parseFlags(
  args: string[],
  schema: Record<string, FlagSchema>,
  defaults: CommandDefaultFlagValues = {},
):
  | { flags: Record<string, FlagValue>; ok: true }
  | { error: string; ok: false } {
  const commandSchema = flagSchemaDefinition(schema);
  const globalSchema = flagSchemaDefinition(globalFlagSchema);
  const flags: Record<string, FlagValue> = Object.fromEntries(
    Object.entries(defaults).filter(
      ([key]) =>
        commandSchema.byInternalKey[key] !== undefined ||
        globalSchema.byInternalKey[key] !== undefined,
    ),
  );

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!token.startsWith("--")) {
      return {
        error: `Unexpected positional argument: ${token}`,
        ok: false,
      };
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const rawName =
      equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);
    const flag =
      commandSchema.byPublicName.get(rawName) ??
      globalSchema.byPublicName.get(rawName);

    if (!flag) {
      return {
        error: `Unknown flag --${rawName}`,
        ok: false,
      };
    }

    const { descriptor, key: schemaKey } = flag;

    if (descriptor.kind === "boolean") {
      if (equalsIndex !== -1) {
        const explicitValue = withoutPrefix.slice(equalsIndex + 1);

        if (explicitValue === "true") {
          flags[schemaKey] = true;
          continue;
        }

        if (explicitValue === "false") {
          flags[schemaKey] = false;
          continue;
        }

        return {
          error: `Boolean flag --${rawName} only accepts true or false`,
          ok: false,
        };
      }

      flags[schemaKey] = true;
      continue;
    }

    const rawValue =
      equalsIndex === -1
        ? args[index + 1]
        : withoutPrefix.slice(equalsIndex + 1);

    if (
      rawValue === undefined ||
      (equalsIndex === -1 && rawValue.startsWith("--"))
    ) {
      return {
        error: `Flag --${rawName} requires a value`,
        ok: false,
      };
    }

    if (equalsIndex === -1) {
      index += 1;
    }

    if (descriptor.kind === "integer") {
      if (!/^-?\d+$/.test(rawValue)) {
        return {
          error: `Flag --${rawName} requires an integer value`,
          ok: false,
        };
      }

      const parsed = Number.parseInt(rawValue, 10);

      if (!Number.isInteger(parsed)) {
        return {
          error: `Flag --${rawName} requires an integer value`,
          ok: false,
        };
      }

      flags[schemaKey] = parsed;
      continue;
    }

    if (descriptor.kind === "stringList") {
      const previous = flags[schemaKey];
      flags[schemaKey] = [
        ...(Array.isArray(previous) ? previous : []),
        rawValue,
      ];
      continue;
    }

    flags[schemaKey] = rawValue;
  }

  return {
    flags,
    ok: true,
  };
}

function parseDeploymentSelector(
  flags: Record<string, FlagValue>,
): DeploymentSelector | ParseCliError {
  const deploymentId =
    typeof flags.deploymentId === "string" ? flags.deploymentId : undefined;
  const teamId = typeof flags.teamId === "string" ? flags.teamId : undefined;
  const teamName = typeof flags.team === "string" ? flags.team : undefined;
  const appName = typeof flags.app === "string" ? flags.app : undefined;
  const deploymentName =
    typeof flags.deployment === "string" ? flags.deployment : undefined;
  const blankSelectorError =
    emptyStringFlagError(deploymentId, "deployment-id") ??
    emptyStringFlagError(teamId, "team-id") ??
    emptyStringFlagError(teamName, "team") ??
    emptyStringFlagError(appName, "app") ??
    emptyStringFlagError(deploymentName, "deployment");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  const nameFlagCount = [teamId, teamName, appName, deploymentName].filter(
    (value) => value !== undefined,
  ).length;

  if (deploymentId !== undefined && nameFlagCount > 0) {
    return {
      error: "--deployment-id cannot be combined with --app or --deployment",
      ok: false,
      showHelp: true,
    };
  }

  if (teamId !== undefined && teamName !== undefined) {
    return {
      error: "--team-id cannot be combined with --team",
      ok: false,
      showHelp: true,
    };
  }

  if (deploymentId !== undefined) {
    return { deploymentId };
  }

  if (
    teamId !== undefined &&
    appName !== undefined &&
    deploymentName !== undefined
  ) {
    return { appName, deploymentName, teamId };
  }

  if (
    teamId === undefined &&
    teamName === undefined &&
    appName !== undefined &&
    deploymentName !== undefined
  ) {
    return { appName, deploymentName };
  }

  if (
    teamName !== undefined &&
    appName !== undefined &&
    deploymentName !== undefined
  ) {
    return { appName, deploymentName, teamName };
  }

  if (nameFlagCount > 0) {
    return {
      error: "--app and --deployment must be provided together",
      ok: false,
      showHelp: true,
    };
  }

  return {
    error: "Missing required flag --deployment-id or --app/--deployment",
    ok: false,
    showHelp: true,
  };
}

function addParseErrorHelp(
  error: ParseCliError,
  details: {
    examples?: string[];
    helpTopic: string;
    suggestion?: string;
  },
): ParseCliError {
  return {
    ...error,
    ...details,
  };
}

function describeDeploymentHistorySelectorError(
  flags: Record<string, FlagValue>,
  error: ParseCliError,
): ParseCliError {
  const deploymentId =
    typeof flags.deploymentId === "string" ? flags.deploymentId : undefined;
  const appName = typeof flags.app === "string" ? flags.app : undefined;
  const deploymentName =
    typeof flags.deployment === "string" ? flags.deployment : undefined;
  const hasNameSelectorFlag =
    flags.teamId !== undefined ||
    flags.team !== undefined ||
    appName !== undefined ||
    deploymentName !== undefined;
  const missingFlags = [
    appName === undefined ? "--app" : null,
    deploymentName === undefined ? "--deployment" : null,
  ].filter((flag): flag is string => flag !== null);
  const examples = deploymentHistorySelectorExamples(flags);

  if (deploymentId === undefined && hasNameSelectorFlag && missingFlags.length > 0) {
    return addParseErrorHelp(
      {
        ...error,
        error:
          missingFlags.length === 1
            ? `Missing required flag ${missingFlags[0]}`
            : `Missing required flags ${missingFlags.join(" and ")}`,
      },
      {
        examples,
        helpTopic: "deployment history",
      },
    );
  }

  return addParseErrorHelp(error, {
    examples,
    helpTopic: "deployment history",
  });
}

function deploymentHistorySelectorExamples(
  flags: Record<string, FlagValue>,
): string[] {
  const nameSelectorParts = ["cmpatch deployment history"];
  const idSelectorParts = ["cmpatch deployment history"];
  const serverUrl =
    typeof flags.serverUrl === "string" ? flags.serverUrl : undefined;
  const teamId = typeof flags.teamId === "string" ? flags.teamId : undefined;
  const teamName = typeof flags.team === "string" ? flags.team : undefined;
  const appName = typeof flags.app === "string" ? flags.app : "<app>";
  const deploymentName =
    typeof flags.deployment === "string" ? flags.deployment : "Staging";

  if (serverUrl !== undefined) {
    nameSelectorParts.push("--server-url", serverUrl);
    idSelectorParts.push("--server-url", serverUrl);
  }

  if (teamId !== undefined) {
    nameSelectorParts.push("--team-id", teamId);
  } else if (teamName !== undefined) {
    nameSelectorParts.push("--team", teamName);
  }

  nameSelectorParts.push("--app", appName, "--deployment", deploymentName);
  idSelectorParts.push("--deployment-id", "<id>");

  return [nameSelectorParts.join(" "), idSelectorParts.join(" ")];
}

function parseReleaseSelector(
  flags: Record<string, FlagValue>,
): ReleaseSelector | ParseCliError {
  const releaseId =
    typeof flags.releaseId === "string" ? flags.releaseId : undefined;
  const releaseLabel =
    typeof flags.label === "string" ? flags.label : undefined;
  const hasDeploymentSelectorFlag =
    flags.deploymentId !== undefined ||
    flags.team !== undefined ||
    flags.app !== undefined ||
    flags.deployment !== undefined;
  const blankSelectorError =
    emptyStringFlagError(releaseId, "release-id") ??
    emptyStringFlagError(releaseLabel, "label");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (
    releaseId !== undefined &&
    (releaseLabel !== undefined || hasDeploymentSelectorFlag)
  ) {
    return {
      error:
        "--release-id cannot be combined with --deployment-id, --app, --deployment, or --label",
      ok: false,
      showHelp: true,
    };
  }

  if (releaseId !== undefined) {
    return { releaseId };
  }

  if (hasDeploymentSelectorFlag) {
    const deployment = parseDeploymentSelector(flags);

    if (isParseError(deployment)) {
      return deployment;
    }

    if (releaseLabel === undefined) {
      return {
        error: "Missing required flag --label",
        ok: false,
        showHelp: true,
      };
    }

    return {
      deployment,
      releaseLabel,
    };
  }

  if (releaseLabel !== undefined) {
    return {
      error: "Missing required flag --deployment-id or --app/--deployment",
      ok: false,
      showHelp: true,
    };
  }

  return {
    error:
      "Missing required flag --release-id or --deployment-id/--label or --app/--deployment/--label",
    ok: false,
    showHelp: true,
  };
}

function emptyStringFlagError(
  value: string | undefined,
  label: string,
): ParseCliError | null {
  if (value !== undefined && value.trim().length === 0) {
    return {
      error: `Missing required flag --${label}`,
      ok: false,
      showHelp: true,
    };
  }

  return null;
}

function parseTeamSelector(
  flags: Record<string, FlagValue>,
): TeamSelector | ParseCliError {
  const teamId = typeof flags.teamId === "string" ? flags.teamId : undefined;
  const teamName = typeof flags.team === "string" ? flags.team : undefined;
  const blankSelectorError =
    emptyStringFlagError(teamId, "team-id") ??
    emptyStringFlagError(teamName, "team");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (teamId !== undefined && teamName !== undefined) {
    return {
      error: "--team-id cannot be combined with --team",
      ok: false,
      showHelp: true,
    };
  }

  if (teamId !== undefined) {
    return { teamId };
  }

  if (teamName !== undefined) {
    return { teamName };
  }

  return {};
}

function parseMemberUserSelector(
  flags: Record<string, FlagValue>,
): MemberUserSelector | ParseCliError {
  const userId = typeof flags.userId === "string" ? flags.userId : undefined;
  const email = typeof flags.email === "string" ? flags.email : undefined;
  const blankSelectorError =
    emptyStringFlagError(userId, "user-id") ??
    emptyStringFlagError(email, "email");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (userId !== undefined && email !== undefined) {
    return {
      error: "--user-id cannot be combined with --email",
      ok: false,
      showHelp: true,
    };
  }

  if (userId !== undefined) {
    return { userId };
  }

  if (email !== undefined) {
    return { email };
  }

  return {
    error: "Missing required flag --user-id or --email",
    ok: false,
    showHelp: true,
  };
}

function parseMemberInviteTarget(
  flags: Record<string, FlagValue>,
): MemberInviteTarget | ParseCliError {
  const email = typeof flags.email === "string" ? flags.email : undefined;
  const githubHandle =
    typeof flags.githubHandle === "string" ? flags.githubHandle : undefined;
  const blankSelectorError =
    emptyStringFlagError(email, "email") ??
    emptyStringFlagError(githubHandle, "github-handle");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (email !== undefined && githubHandle !== undefined) {
    return {
      error: "--email cannot be combined with --github-handle",
      ok: false,
      showHelp: true,
    };
  }

  if (email !== undefined) {
    return { email };
  }

  if (githubHandle !== undefined) {
    return { githubHandle };
  }

  return {
    error: "Missing required flag --email or --github-handle",
    ok: false,
    showHelp: true,
  };
}

function parseInvitationStatus(
  value: FlagValue | undefined,
):
  | "pending"
  | "accepted"
  | "revoked"
  | "expired"
  | "all"
  | undefined
  | ParseCliError {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "pending" ||
    value === "accepted" ||
    value === "revoked" ||
    value === "expired" ||
    value === "all"
  ) {
    return value;
  }

  return {
    error: "--status must be one of: pending, accepted, revoked, expired, all",
    ok: false,
    showHelp: true,
  };
}

function parseAppSelector(
  flags: Record<string, FlagValue>,
): AppSelector | ParseCliError {
  const appId = typeof flags.appId === "string" ? flags.appId : undefined;
  const teamId = typeof flags.teamId === "string" ? flags.teamId : undefined;
  const teamName = typeof flags.team === "string" ? flags.team : undefined;
  const appName = typeof flags.app === "string" ? flags.app : undefined;
  const blankSelectorError =
    emptyStringFlagError(appId, "app-id") ??
    emptyStringFlagError(teamId, "team-id") ??
    emptyStringFlagError(teamName, "team") ??
    emptyStringFlagError(appName, "app");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  const nameFlagCount = [teamId, teamName, appName].filter(
    (value) => value !== undefined,
  ).length;

  if (appId !== undefined && nameFlagCount > 0) {
    return {
      error: "--app-id cannot be combined with --app",
      ok: false,
      showHelp: true,
    };
  }

  if (teamId !== undefined && teamName !== undefined) {
    return {
      error: "--team-id cannot be combined with --team",
      ok: false,
      showHelp: true,
    };
  }

  if (appId !== undefined) {
    return { appId };
  }

  if (teamId !== undefined && appName !== undefined) {
    return { appName, teamId };
  }

  if (teamId === undefined && teamName === undefined && appName !== undefined) {
    return { appName };
  }

  if (teamName !== undefined && appName !== undefined) {
    return { appName, teamName };
  }

  if (nameFlagCount > 0) {
    return {
      error: "--app must be provided with exactly one of --team-id or --team",
      ok: false,
      showHelp: true,
    };
  }

  return {
    error: "Missing required flag --app-id or --app",
    ok: false,
    showHelp: true,
  };
}

export function parseReleaseCreate(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseCreateSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);
  const bundlePath = parseBundlePath(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  if (isParseError(bundlePath)) {
    return bundlePath;
  }

  // A `.cmpatch` artifact already carries its build identity; flags supply only the
  // deployment target and upload policy. Detection is by extension (no I/O here);
  // the executor validates the descriptor.
  const isArtifactUpload = bundlePath.toLowerCase().endsWith(".cmpatch");

  if (isArtifactUpload) {
    for (const [internalKey, publicName] of ARTIFACT_FORBIDDEN_FLAGS) {
      if (hasFlag(parsedFlags.flags, internalKey)) {
        return {
          error: `--${publicName} cannot be combined with a .cmpatch artifact; it is read from the artifact`,
          ok: false,
          showHelp: true,
        };
      }
    }
  }

  // `--platform` may be injected from project config, so it is ignored (not
  // rejected) on the artifact path, where the descriptor is authoritative.
  const platform =
    !isArtifactUpload && typeof parsedFlags.flags.platform === "string"
      ? ensureNonBlankString(parsedFlags.flags, "platform", "platform")
      : undefined;
  if (isParseError(platform)) {
    return platform;
  }

  if (
    platform !== undefined &&
    platform !== "ios" &&
    platform !== "android"
  ) {
    return {
      error: "--platform must be either ios or android",
      ok: false,
      showHelp: true,
    };
  }

  const targetBinaryVersion = isArtifactUpload
    ? undefined
    : ensureString(
        parsedFlags.flags,
        "targetBinaryVersion",
        "target-binary-version",
      );
  if (isParseError(targetBinaryVersion)) {
    return targetBinaryVersion;
  }

  const projectRoot =
    typeof parsedFlags.flags.projectRoot === "string"
      ? ensureNonBlankString(parsedFlags.flags, "projectRoot", "project-root")
      : ".";
  if (isParseError(projectRoot)) {
    return projectRoot;
  }

  const fingerprint =
    !isArtifactUpload && typeof parsedFlags.flags.fingerprint === "string"
      ? ensureNonBlankString(parsedFlags.flags, "fingerprint", "fingerprint")
      : undefined;
  if (isParseError(fingerprint)) {
    return fingerprint;
  }

  if (!isArtifactUpload && fingerprint === undefined && platform === undefined) {
    return {
      error: "Missing required flag --platform",
      ok: false,
      showHelp: true,
    };
  }

  const rolloutPercentage = parseRolloutPercentage(parsedFlags.flags);
  if (isParseError(rolloutPercentage)) {
    return rolloutPercentage;
  }

  const privateKeyPath =
    !isArtifactUpload && typeof parsedFlags.flags.privateKeyPath === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "privateKeyPath",
          "private-key-path",
        )
      : undefined;
  if (isParseError(privateKeyPath)) {
    return privateKeyPath;
  }

  const policyOverrides = isArtifactUpload
    ? collectArtifactPolicyOverrides(parsedFlags.flags, rolloutPercentage)
    : undefined;

  return {
    command: {
      ...(isArtifactUpload ? { artifactUpload: true } : {}),
      bundlePath,
      deployment,
      disabled: parsedFlags.flags.disabled === true,
      dryRun: parsedFlags.flags.dryRun === true,
      isMandatory: parsedFlags.flags.mandatory === true,
      kind: "release-create",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      noDuplicateReleaseError:
        parsedFlags.flags.noDuplicateReleaseError === true,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ...(platform !== undefined ? { platform } : {}),
      ...(policyOverrides !== undefined &&
      Object.keys(policyOverrides).length > 0
        ? { policyOverrides }
        : {}),
      projectRoot,
      releaseNotes:
        typeof parsedFlags.flags.releaseNotes === "string"
          ? parsedFlags.flags.releaseNotes
          : undefined,
      rolloutPercentage: rolloutPercentage ?? 100,
      serverUrl,
      ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
      sourcemapPath:
        !isArtifactUpload && typeof parsedFlags.flags.sourcemap === "string"
          ? parsedFlags.flags.sourcemap
          : undefined,
      ...(targetBinaryVersion !== undefined ? { targetBinaryVersion } : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

/**
 * Collect the policy flags the caller set explicitly. On the artifact path these
 * override the artifact's baked-in defaults; everything left out falls back to
 * those defaults. Booleans honor an explicit `--flag=false` (these flags are never
 * config-injected for `release create`, so presence means the caller set them).
 */
function collectArtifactPolicyOverrides(
  flags: Record<string, FlagValue>,
  rolloutPercentage: number | undefined,
): Partial<UploadPolicy> {
  const overrides: Partial<UploadPolicy> = {};
  if (hasFlag(flags, "rolloutPercentage") && rolloutPercentage !== undefined) {
    overrides.rolloutPercentage = rolloutPercentage;
  }
  if (hasFlag(flags, "mandatory")) {
    overrides.isMandatory = flags.mandatory === true;
  }
  if (hasFlag(flags, "disabled")) {
    overrides.disabled = flags.disabled === true;
  }
  if (hasFlag(flags, "noDuplicateReleaseError")) {
    overrides.noDuplicateReleaseError = flags.noDuplicateReleaseError === true;
  }
  if (typeof flags.releaseNotes === "string") {
    overrides.releaseNotes = flags.releaseNotes;
  }
  return overrides;
}

export function parseFingerprint(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, fingerprintSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const platform = ensureString(parsedFlags.flags, "platform", "platform");

  if (isParseError(platform)) {
    return platform;
  }

  if (platform !== "ios" && platform !== "android") {
    return {
      error: "--platform must be either ios or android",
      ok: false,
      showHelp: true,
    };
  }

  const projectRoot =
    typeof parsedFlags.flags.projectRoot === "string"
      ? ensureNonBlankString(parsedFlags.flags, "projectRoot", "project-root")
      : ".";
  if (isParseError(projectRoot)) {
    return projectRoot;
  }

  const format =
    typeof parsedFlags.flags.format === "string"
      ? parsedFlags.flags.format
      : "text";
  if (format !== "text" && format !== "json" && format !== "table") {
    return {
      error: "--format must be either text, json, or table",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      format,
      kind: "fingerprint",
      platform,
      projectRoot,
      verbose: parsedFlags.flags.verbose === true,
    },
    ok: true,
  };
}

export function parseDebug(args: string[]): ParseCliResult {
  const platform = args[0];

  if (platform !== "ios" && platform !== "android") {
    return {
      error: "Usage: cmpatch debug <ios|android>",
      ok: false,
      showHelp: true,
    };
  }

  if (args.length > 1) {
    const parsedFlags = parseFlags(args.slice(1), debugSchema);
    if (!parsedFlags.ok) {
      return {
        error: parsedFlags.error,
        ok: false,
        showHelp: true,
      };
    }
  }

  return {
    command: {
      kind: "debug",
      platform,
    },
    ok: true,
  };
}

export function parseDoctor(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, doctorSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const app = readStringFlag(parsedFlags.flags, "app");
  const appId = readStringFlag(parsedFlags.flags, "appId");
  const bundler = readStringFlag(parsedFlags.flags, "bundler");
  const downloadBaseUrl = readStringFlag(parsedFlags.flags, "downloadBaseUrl");
  const currentPackageHash = readStringFlag(
    parsedFlags.flags,
    "currentPackageHash",
  );
  const deployment = readStringFlag(parsedFlags.flags, "deployment");
  const deploymentId = readStringFlag(parsedFlags.flags, "deploymentId");
  const deploymentKey = readStringFlag(parsedFlags.flags, "deploymentKey");
  const projectRoot = readStringFlag(parsedFlags.flags, "projectRoot") ?? ".";
  const serverUrl = readStringFlag(parsedFlags.flags, "serverUrl");
  const targetBinaryVersion = readStringFlag(
    parsedFlags.flags,
    "targetBinaryVersion",
  );
  const team = readStringFlag(parsedFlags.flags, "team");
  const teamId = readStringFlag(parsedFlags.flags, "teamId");
  const token = readStringFlag(parsedFlags.flags, "token");

  const blankSelectorError =
    emptyStringFlagError(serverUrl, "server-url") ??
    emptyStringFlagError(team, "team") ??
    emptyStringFlagError(teamId, "team-id") ??
    emptyStringFlagError(app, "app") ??
    emptyStringFlagError(appId, "app-id") ??
    emptyStringFlagError(deployment, "deployment") ??
    emptyStringFlagError(deploymentId, "deployment-id") ??
    emptyStringFlagError(deploymentKey, "deployment-key") ??
    emptyStringFlagError(targetBinaryVersion, "target-binary-version") ??
    emptyStringFlagError(downloadBaseUrl, "download-base-url") ??
    emptyStringFlagError(currentPackageHash, "current-package-hash") ??
    emptyStringFlagError(projectRoot, "project-root") ??
    emptyStringFlagError(bundler, "bundler") ??
    emptyStringFlagError(token, "token");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (team !== undefined && teamId !== undefined) {
    return {
      error: "--team-id cannot be combined with --team",
      ok: false,
      showHelp: true,
    };
  }

  if (app !== undefined && appId !== undefined) {
    return {
      error: "--app-id cannot be combined with --app",
      ok: false,
      showHelp: true,
    };
  }

  if (
    deployment !== undefined &&
    deploymentId !== undefined
  ) {
    return {
      error: "--deployment-id cannot be combined with --deployment",
      ok: false,
      showHelp: true,
    };
  }

  const platform = readStringFlag(parsedFlags.flags, "platform");
  if (
    platform !== undefined &&
    platform !== "ios" &&
    platform !== "android"
  ) {
    return {
      error: "--platform must be either ios or android",
      ok: false,
      showHelp: true,
    };
  }

  const format = parseOutputFormat(parsedFlags.flags);
  if (isParseError(format)) {
    return format;
  }

  return {
    command: {
      kind: "doctor",
      ...(app !== undefined ? { app } : {}),
      ...(appId !== undefined ? { appId } : {}),
      ...(bundler !== undefined ? { bundler } : {}),
      ...(downloadBaseUrl !== undefined ? { downloadBaseUrl } : {}),
      ...(currentPackageHash !== undefined ? { currentPackageHash } : {}),
      ...(deployment !== undefined ? { deployment } : {}),
      ...(deploymentId !== undefined ? { deploymentId } : {}),
      ...(deploymentKey !== undefined ? { deploymentKey } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(platform !== undefined ? { platform } : {}),
      projectRoot,
      ...(serverUrl !== undefined ? { serverUrl } : {}),
      ...(targetBinaryVersion !== undefined ? { targetBinaryVersion } : {}),
      ...(team !== undefined ? { team } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
      ...(token !== undefined ? { token } : {}),
      verbose: parsedFlags.flags.verbose === true,
    },
    ok: true,
  };
}

function parseBaseBytecode(
  flags: Record<string, FlagValue>,
): "auto" | "off" | ParseCliError {
  const value =
    typeof flags.baseBytecode === "string" ? flags.baseBytecode : "auto";
  if (value !== "auto" && value !== "off") {
    return {
      error: "--base-bytecode must be one of auto or off",
      ok: false,
      showHelp: true,
    };
  }

  return value;
}

export function parseReleaseReact(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseReactSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const baseBytecode = parseBaseBytecode(parsedFlags.flags);
  if (isParseError(baseBytecode)) {
    return baseBytecode;
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);
  const platform = ensureString(parsedFlags.flags, "platform", "platform");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  if (isParseError(platform)) {
    return platform;
  }

  if (platform !== "ios" && platform !== "android") {
    return {
      error: "--platform must be either ios or android",
      ok: false,
      showHelp: true,
    };
  }

  const bundler =
    typeof parsedFlags.flags.bundler === "string"
      ? parsedFlags.flags.bundler
      : "auto";
  if (bundler.trim().length === 0) {
    return {
      error: "Missing required flag --bundler",
      ok: false,
      showHelp: true,
    };
  }

  if (bundler !== "auto" && bundler !== "metro" && bundler !== "expo") {
    return {
      error: "--bundler must be one of auto, metro, or expo",
      ok: false,
      showHelp: true,
    };
  }

  const entryFile =
    typeof parsedFlags.flags.entryFile === "string"
      ? ensureNonBlankString(parsedFlags.flags, "entryFile", "entry-file")
      : undefined;
  if (isParseError(entryFile)) {
    return entryFile;
  }

  const hermes =
    typeof parsedFlags.flags.hermes === "string"
      ? parsedFlags.flags.hermes
      : "auto";
  if (hermes !== "auto" && hermes !== "true" && hermes !== "false") {
    return {
      error: "--hermes must be one of auto, true, or false",
      ok: false,
      showHelp: true,
    };
  }
  if (
    bundler === "expo" &&
    typeof parsedFlags.flags.hermes === "string" &&
    hermes !== "auto"
  ) {
    return {
      error:
        "--hermes true|false is only supported with --bundler metro; Expo uses Expo config jsEngine",
      ok: false,
      showHelp: true,
    };
  }

  const extraHermesFlags = Array.isArray(parsedFlags.flags.extraHermesFlag)
    ? parsedFlags.flags.extraHermesFlag
    : [];
  if (bundler === "expo" && extraHermesFlags.length > 0) {
    return {
      error: "--extra-hermes-flag is only supported with --bundler metro",
      ok: false,
      showHelp: true,
    };
  }

  const bundlerArgs = Array.isArray(parsedFlags.flags.bundlerArgs)
    ? parsedFlags.flags.bundlerArgs
    : [];

  const projectRoot =
    typeof parsedFlags.flags.projectRoot === "string"
      ? ensureNonBlankString(parsedFlags.flags, "projectRoot", "project-root")
      : ".";
  if (isParseError(projectRoot)) {
    return projectRoot;
  }

  const targetBinaryVersion =
    typeof parsedFlags.flags.targetBinaryVersion === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "targetBinaryVersion",
          "target-binary-version",
        )
      : undefined;
  if (isParseError(targetBinaryVersion)) {
    return targetBinaryVersion;
  }

  const plistFile =
    typeof parsedFlags.flags.plistFile === "string"
      ? ensureNonBlankString(parsedFlags.flags, "plistFile", "plist-file")
      : undefined;
  if (isParseError(plistFile)) {
    return plistFile;
  }

  const plistFilePrefix =
    typeof parsedFlags.flags.plistFilePrefix === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "plistFilePrefix",
          "plist-file-prefix",
        )
      : undefined;
  if (isParseError(plistFilePrefix)) {
    return plistFilePrefix;
  }

  const gradleFile =
    typeof parsedFlags.flags.gradleFile === "string"
      ? ensureNonBlankString(parsedFlags.flags, "gradleFile", "gradle-file")
      : undefined;
  if (isParseError(gradleFile)) {
    return gradleFile;
  }

  const xcodeProjectFile =
    typeof parsedFlags.flags.xcodeProjectFile === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "xcodeProjectFile",
          "xcode-project-file",
        )
      : undefined;
  if (isParseError(xcodeProjectFile)) {
    return xcodeProjectFile;
  }

  const xcodeTargetName =
    typeof parsedFlags.flags.xcodeTargetName === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "xcodeTargetName",
          "xcode-target-name",
        )
      : undefined;
  if (isParseError(xcodeTargetName)) {
    return xcodeTargetName;
  }

  const buildConfigurationName =
    typeof parsedFlags.flags.buildConfigurationName === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "buildConfigurationName",
          "build-configuration-name",
        )
      : undefined;
  if (isParseError(buildConfigurationName)) {
    return buildConfigurationName;
  }

  const sourcemapOutputPath =
    typeof parsedFlags.flags.sourcemapOutput === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "sourcemapOutput",
          "sourcemap-output",
        )
      : undefined;
  if (isParseError(sourcemapOutputPath)) {
    return sourcemapOutputPath;
  }

  const rolloutPercentage = parseRolloutPercentage(parsedFlags.flags);
  if (isParseError(rolloutPercentage)) {
    return rolloutPercentage;
  }

  const privateKeyPath =
    typeof parsedFlags.flags.privateKeyPath === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "privateKeyPath",
          "private-key-path",
        )
      : undefined;
  if (isParseError(privateKeyPath)) {
    return privateKeyPath;
  }

  return {
    command: {
      ...(bundlerArgs.length > 0 ? { bundlerArgs } : {}),
      ...(buildConfigurationName !== undefined
        ? { buildConfigurationName }
        : {}),
      baseBytecode,
      bundler,
      deployment,
      disabled: parsedFlags.flags.disabled === true,
      dryRun: parsedFlags.flags.dryRun === true,
      ...(entryFile !== undefined ? { entryFile } : {}),
      extraHermesFlags,
      ...(gradleFile !== undefined ? { gradleFile } : {}),
      hermes,
      isMandatory: parsedFlags.flags.mandatory === true,
      kind: "release-react",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      noDuplicateReleaseError:
        parsedFlags.flags.noDuplicateReleaseError === true,
      platform,
      ...(plistFile !== undefined ? { plistFile } : {}),
      ...(plistFilePrefix !== undefined ? { plistFilePrefix } : {}),
      projectRoot,
      releaseNotes:
        typeof parsedFlags.flags.releaseNotes === "string"
          ? parsedFlags.flags.releaseNotes
          : undefined,
      rolloutPercentage: rolloutPercentage ?? 100,
      serverUrl,
      ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
      sourcemapOutputPath,
      ...(targetBinaryVersion !== undefined ? { targetBinaryVersion } : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(xcodeProjectFile !== undefined ? { xcodeProjectFile } : {}),
      ...(xcodeTargetName !== undefined ? { xcodeTargetName } : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseBundle(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, bundleSchema, defaults);

  if (!parsedFlags.ok) {
    return { error: parsedFlags.error, ok: false, showHelp: true };
  }

  const baseBytecode = parseBaseBytecode(parsedFlags.flags);
  if (isParseError(baseBytecode)) {
    return baseBytecode;
  }

  const platform = ensureString(parsedFlags.flags, "platform", "platform");
  if (isParseError(platform)) {
    return platform;
  }
  if (platform !== "ios" && platform !== "android") {
    return {
      error: "--platform must be either ios or android",
      ok: false,
      showHelp: true,
    };
  }

  const bundler =
    typeof parsedFlags.flags.bundler === "string"
      ? parsedFlags.flags.bundler
      : "auto";
  if (bundler !== "auto" && bundler !== "metro" && bundler !== "expo") {
    return {
      error: "--bundler must be one of auto, metro, or expo",
      ok: false,
      showHelp: true,
    };
  }

  const entryFile =
    typeof parsedFlags.flags.entryFile === "string"
      ? ensureNonBlankString(parsedFlags.flags, "entryFile", "entry-file")
      : undefined;
  if (isParseError(entryFile)) {
    return entryFile;
  }

  const hermes =
    typeof parsedFlags.flags.hermes === "string"
      ? parsedFlags.flags.hermes
      : "auto";
  if (hermes !== "auto" && hermes !== "true" && hermes !== "false") {
    return {
      error: "--hermes must be one of auto, true, or false",
      ok: false,
      showHelp: true,
    };
  }
  if (
    bundler === "expo" &&
    typeof parsedFlags.flags.hermes === "string" &&
    hermes !== "auto"
  ) {
    return {
      error:
        "--hermes true|false is only supported with --bundler metro; Expo uses Expo config jsEngine",
      ok: false,
      showHelp: true,
    };
  }

  const extraHermesFlags = Array.isArray(parsedFlags.flags.extraHermesFlag)
    ? parsedFlags.flags.extraHermesFlag
    : [];
  if (bundler === "expo" && extraHermesFlags.length > 0) {
    return {
      error: "--extra-hermes-flag is only supported with --bundler metro",
      ok: false,
      showHelp: true,
    };
  }

  const bundlerArgs = Array.isArray(parsedFlags.flags.bundlerArgs)
    ? parsedFlags.flags.bundlerArgs
    : [];

  const projectRoot =
    typeof parsedFlags.flags.projectRoot === "string"
      ? ensureNonBlankString(parsedFlags.flags, "projectRoot", "project-root")
      : ".";
  if (isParseError(projectRoot)) {
    return projectRoot;
  }

  const targetBinaryVersion =
    typeof parsedFlags.flags.targetBinaryVersion === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "targetBinaryVersion",
          "target-binary-version",
        )
      : undefined;
  if (isParseError(targetBinaryVersion)) {
    return targetBinaryVersion;
  }

  const plistFile =
    typeof parsedFlags.flags.plistFile === "string"
      ? ensureNonBlankString(parsedFlags.flags, "plistFile", "plist-file")
      : undefined;
  if (isParseError(plistFile)) {
    return plistFile;
  }

  const plistFilePrefix =
    typeof parsedFlags.flags.plistFilePrefix === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "plistFilePrefix",
          "plist-file-prefix",
        )
      : undefined;
  if (isParseError(plistFilePrefix)) {
    return plistFilePrefix;
  }

  const gradleFile =
    typeof parsedFlags.flags.gradleFile === "string"
      ? ensureNonBlankString(parsedFlags.flags, "gradleFile", "gradle-file")
      : undefined;
  if (isParseError(gradleFile)) {
    return gradleFile;
  }

  const xcodeProjectFile =
    typeof parsedFlags.flags.xcodeProjectFile === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "xcodeProjectFile",
          "xcode-project-file",
        )
      : undefined;
  if (isParseError(xcodeProjectFile)) {
    return xcodeProjectFile;
  }

  const xcodeTargetName =
    typeof parsedFlags.flags.xcodeTargetName === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "xcodeTargetName",
          "xcode-target-name",
        )
      : undefined;
  if (isParseError(xcodeTargetName)) {
    return xcodeTargetName;
  }

  const buildConfigurationName =
    typeof parsedFlags.flags.buildConfigurationName === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "buildConfigurationName",
          "build-configuration-name",
        )
      : undefined;
  if (isParseError(buildConfigurationName)) {
    return buildConfigurationName;
  }

  const sourcemapOutputPath =
    typeof parsedFlags.flags.sourcemapOutput === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "sourcemapOutput",
          "sourcemap-output",
        )
      : undefined;
  if (isParseError(sourcemapOutputPath)) {
    return sourcemapOutputPath;
  }

  const outputPath =
    typeof parsedFlags.flags.output === "string"
      ? ensureNonBlankString(parsedFlags.flags, "output", "output")
      : undefined;
  if (isParseError(outputPath)) {
    return outputPath;
  }

  const rolloutPercentage = parseRolloutPercentage(parsedFlags.flags);
  if (isParseError(rolloutPercentage)) {
    return rolloutPercentage;
  }

  const privateKeyPath =
    typeof parsedFlags.flags.privateKeyPath === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "privateKeyPath",
          "private-key-path",
        )
      : undefined;
  if (isParseError(privateKeyPath)) {
    return privateKeyPath;
  }

  return {
    command: {
      ...(bundlerArgs.length > 0 ? { bundlerArgs } : {}),
      ...(buildConfigurationName !== undefined
        ? { buildConfigurationName }
        : {}),
      baseBytecode,
      bundler,
      disabled: parsedFlags.flags.disabled === true,
      ...(entryFile !== undefined ? { entryFile } : {}),
      extraHermesFlags,
      ...(gradleFile !== undefined ? { gradleFile } : {}),
      hermes,
      isMandatory: parsedFlags.flags.mandatory === true,
      kind: "bundle",
      noDuplicateReleaseError:
        parsedFlags.flags.noDuplicateReleaseError === true,
      ...(outputPath !== undefined ? { outputPath } : {}),
      platform,
      ...(plistFile !== undefined ? { plistFile } : {}),
      ...(plistFilePrefix !== undefined ? { plistFilePrefix } : {}),
      ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
      projectRoot,
      releaseNotes:
        typeof parsedFlags.flags.releaseNotes === "string"
          ? parsedFlags.flags.releaseNotes
          : undefined,
      rolloutPercentage: rolloutPercentage ?? 100,
      ...(sourcemapOutputPath !== undefined ? { sourcemapOutputPath } : {}),
      ...(targetBinaryVersion !== undefined ? { targetBinaryVersion } : {}),
      ...(xcodeProjectFile !== undefined ? { xcodeProjectFile } : {}),
      ...(xcodeTargetName !== undefined ? { xcodeTargetName } : {}),
    },
    ok: true,
  };
}

export function parseReleaseShow(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseShowSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const release = parseReleaseSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(release)) {
    return release;
  }

  return {
    command: {
      kind: "release-show",
      release,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseReleaseInspect(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseInspectSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const release = parseReleaseSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(release)) {
    return release;
  }

  if (isParseError(format)) {
    return format;
  }

  const timeoutSeconds =
    typeof parsedFlags.flags.timeoutSeconds === "number"
      ? parsedFlags.flags.timeoutSeconds
      : typeof parsedFlags.flags.timeout === "number"
        ? parsedFlags.flags.timeout
        : 300;

  if (timeoutSeconds <= 0) {
    return {
      error: "--timeout must be a positive integer",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      ...(format !== undefined ? { format } : {}),
      kind: "release-inspect",
      logs: parsedFlags.flags.logs === true,
      release,
      serverUrl,
      timeoutSeconds,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      wait: parsedFlags.flags.wait === true,
    },
    ok: true,
  };
}

export function parseReleaseList(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseListSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  if (isParseError(format)) {
    return format;
  }

  const pagination = parsePagination(parsedFlags.flags);

  if (isParseError(pagination)) {
    return pagination;
  }

  const include =
    typeof parsedFlags.flags.include === "string"
      ? parsedFlags.flags.include
      : undefined;

  if (include !== undefined && include !== "metrics") {
    return {
      error: "--include must be metrics when provided",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      deployment,
      ...(format !== undefined ? { format } : {}),
      ...(include === "metrics" ? { includeMetrics: true } : {}),
      kind: "release-list",
      ...pagination,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseDeploymentMetrics(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentMetricsSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  if (isParseError(format)) {
    return format;
  }

  const pagination = parsePagination(parsedFlags.flags);

  if (isParseError(pagination)) {
    return pagination;
  }

  return {
    command: {
      deployment,
      ...(format !== undefined ? { format } : {}),
      kind: "deployment-metrics",
      ...pagination,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseReleaseMetrics(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseMetricsSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const release = parseReleaseSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(release)) {
    return release;
  }

  if (isParseError(format)) {
    return format;
  }

  return {
    command: {
      ...(format !== undefined ? { format } : {}),
      kind: "release-metrics",
      release,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseReleasePatch(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releasePatchSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const release = parseReleaseSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(release)) {
    return release;
  }

  if (
    parsedFlags.flags.mandatory === true &&
    parsedFlags.flags.notMandatory === true
  ) {
    return {
      error: "--mandatory and --not-mandatory cannot be combined",
      ok: false,
      showHelp: true,
    };
  }

  const rolloutPercentage = parseRolloutPercentage(parsedFlags.flags);
  if (isParseError(rolloutPercentage)) {
    return rolloutPercentage;
  }

  const status =
    typeof parsedFlags.flags.status === "string"
      ? parsedFlags.flags.status
      : undefined;

  if (status !== undefined && status !== "disabled" && status !== "published") {
    return {
      error: "--status must be either disabled or published",
      ok: false,
      showHelp: true,
    };
  }

  const patch: ReleasePatchCommand["patch"] = {};

  if (typeof parsedFlags.flags.releaseNotes === "string") {
    patch.release_notes = parsedFlags.flags.releaseNotes;
  }

  if (typeof rolloutPercentage === "number") {
    patch.rollout_percentage = rolloutPercentage;
  }

  if (parsedFlags.flags.mandatory === true) {
    patch.is_mandatory = true;
  }

  if (parsedFlags.flags.notMandatory === true) {
    patch.is_mandatory = false;
  }

  if (typeof parsedFlags.flags.targetBinaryVersion === "string") {
    patch.target_binary_version = parsedFlags.flags.targetBinaryVersion;
  }

  if (status !== undefined) {
    if (Object.keys(patch).length > 0) {
      return {
        error: "--status cannot be combined with other patch flags",
        ok: false,
        showHelp: true,
      };
    }

    patch.status = status;
  }

  return {
    command: {
      kind: "release-patch",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      patch,
      release,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseReleaseStatus(
  args: string[],
  status: "disabled" | "published",
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseStatusSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const release = parseReleaseSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(release)) {
    return release;
  }

  return {
    command: {
      commandLabel:
        status === "disabled" ? "release disable" : "release enable",
      kind: "release-patch",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      patch: {
        status,
      },
      release,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseReleasePromote(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releasePromoteSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const sourceRelease = parsePromoteSourceReleaseSelector(parsedFlags.flags);
  const destinationDeployment = parsePromoteDestinationDeploymentSelector(
    parsedFlags.flags,
  );

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(sourceRelease)) {
    return sourceRelease;
  }

  if (isParseError(destinationDeployment)) {
    return destinationDeployment;
  }

  if (
    parsedFlags.flags.mandatory === true &&
    parsedFlags.flags.notMandatory === true
  ) {
    return {
      error: "--mandatory and --not-mandatory cannot be combined",
      ok: false,
      showHelp: true,
    };
  }

  const rolloutPercentage = parseRolloutPercentage(parsedFlags.flags);
  if (isParseError(rolloutPercentage)) {
    return rolloutPercentage;
  }

  const targetBinaryVersion =
    typeof parsedFlags.flags.targetBinaryVersion === "string"
      ? ensureNonBlankString(
          parsedFlags.flags,
          "targetBinaryVersion",
          "target-binary-version",
        )
      : undefined;
  if (isParseError(targetBinaryVersion)) {
    return targetBinaryVersion;
  }

  return {
    command: {
      destinationDeployment,
      disabled: parsedFlags.flags.disabled === true,
      ...(parsedFlags.flags.mandatory === true
        ? { isMandatory: true }
        : {}),
      ...(parsedFlags.flags.notMandatory === true
        ? { isMandatory: false }
        : {}),
      kind: "release-promote",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      noDuplicateReleaseError:
        parsedFlags.flags.noDuplicateReleaseError === true,
      releaseNotes:
        typeof parsedFlags.flags.releaseNotes === "string"
          ? parsedFlags.flags.releaseNotes
          : undefined,
      rolloutPercentage: rolloutPercentage ?? 100,
      serverUrl,
      sourceRelease,
      ...(targetBinaryVersion !== undefined ? { targetBinaryVersion } : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

function parsePromoteSourceReleaseSelector(
  flags: Record<string, FlagValue>,
): ReleaseSelector | ParseCliError {
  const releaseId =
    typeof flags.releaseId === "string" ? flags.releaseId : undefined;
  const sourceDeploymentId =
    typeof flags.sourceDeploymentId === "string"
      ? flags.sourceDeploymentId
      : undefined;
  const teamName = typeof flags.team === "string" ? flags.team : undefined;
  const appName = typeof flags.app === "string" ? flags.app : undefined;
  const sourceDeploymentName =
    typeof flags.sourceDeployment === "string"
      ? flags.sourceDeployment
      : undefined;
  const releaseLabel =
    typeof flags.label === "string" ? flags.label : undefined;
  const blankSelectorError =
    emptyStringFlagError(releaseId, "release-id") ??
    emptyStringFlagError(sourceDeploymentId, "source-deployment-id") ??
    emptyStringFlagError(teamName, "team") ??
    emptyStringFlagError(appName, "app") ??
    emptyStringFlagError(sourceDeploymentName, "source-deployment") ??
    emptyStringFlagError(releaseLabel, "label");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (
    releaseId !== undefined &&
    (sourceDeploymentId !== undefined ||
      sourceDeploymentName !== undefined ||
      releaseLabel !== undefined)
  ) {
    return {
      error:
        "--release-id cannot be combined with --source-deployment-id, --source-deployment, or --label",
      ok: false,
      showHelp: true,
    };
  }

  if (releaseId !== undefined) {
    return { releaseId };
  }

  if (
    sourceDeploymentId !== undefined &&
    sourceDeploymentName !== undefined
  ) {
    return {
      error: "--source-deployment-id cannot be combined with --source-deployment",
      ok: false,
      showHelp: true,
    };
  }

  if (sourceDeploymentId !== undefined) {
    if (releaseLabel === undefined) {
      return {
        error: "Missing required flag --label",
        ok: false,
        showHelp: true,
      };
    }

    return {
      deployment: { deploymentId: sourceDeploymentId },
      releaseLabel,
    };
  }

  const nameFlagCount = [appName, sourceDeploymentName].filter(
    (value) => value !== undefined,
  ).length;

  if (nameFlagCount === 1) {
    return {
      error: "--app and --source-deployment must be provided together",
      ok: false,
      showHelp: true,
    };
  }

  if (appName !== undefined && sourceDeploymentName !== undefined) {
    if (releaseLabel === undefined) {
      return {
        error: "Missing required flag --label",
        ok: false,
        showHelp: true,
      };
    }

    return {
      deployment:
        teamName !== undefined
          ? { appName, deploymentName: sourceDeploymentName, teamName }
          : { appName, deploymentName: sourceDeploymentName },
      releaseLabel,
    };
  }

  return {
    error:
      "Missing required flag --release-id or --source-deployment-id/--label or --app/--source-deployment/--label",
    ok: false,
    showHelp: true,
  };
}

function parsePromoteDestinationDeploymentSelector(
  flags: Record<string, FlagValue>,
): DeploymentSelector | ParseCliError {
  const destDeploymentId =
    typeof flags.destDeploymentId === "string"
      ? flags.destDeploymentId
      : undefined;
  const teamName = typeof flags.team === "string" ? flags.team : undefined;
  const appName = typeof flags.app === "string" ? flags.app : undefined;
  const destDeploymentName =
    typeof flags.destDeployment === "string"
      ? flags.destDeployment
      : undefined;
  const blankSelectorError =
    emptyStringFlagError(destDeploymentId, "dest-deployment-id") ??
    emptyStringFlagError(teamName, "team") ??
    emptyStringFlagError(appName, "app") ??
    emptyStringFlagError(destDeploymentName, "dest-deployment");

  if (blankSelectorError) {
    return blankSelectorError;
  }

  if (destDeploymentId !== undefined && destDeploymentName !== undefined) {
    return {
      error: "--dest-deployment-id cannot be combined with --dest-deployment",
      ok: false,
      showHelp: true,
    };
  }

  if (destDeploymentId !== undefined) {
    return { deploymentId: destDeploymentId };
  }

  const nameFlagCount = [appName, destDeploymentName].filter(
    (value) => value !== undefined,
  ).length;

  if (appName !== undefined && destDeploymentName !== undefined) {
    return teamName !== undefined
      ? { appName, deploymentName: destDeploymentName, teamName }
      : { appName, deploymentName: destDeploymentName };
  }

  if (nameFlagCount > 0) {
    return {
      error: "--app and --dest-deployment must be provided together",
      ok: false,
      showHelp: true,
    };
  }

  return {
    error: "Missing required flag --dest-deployment-id or --app/--dest-deployment",
    ok: false,
    showHelp: true,
  };
}

export function parseReleaseRollback(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, releaseRollbackSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);
  const targetReleaseLabel =
    typeof parsedFlags.flags.label === "string"
      ? ensureNonBlankString(parsedFlags.flags, "label", "label")
      : undefined;

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  if (isParseError(targetReleaseLabel)) {
    return targetReleaseLabel;
  }

  return {
    command: {
      deployment,
      kind: "release-rollback",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      serverUrl,
      ...(targetReleaseLabel !== undefined ? { targetReleaseLabel } : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseAppCreate(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, appCreateSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const name = ensureNonBlankString(parsedFlags.flags, "name", "name");
  const team = parseTeamSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(name)) {
    return name;
  }

  if (isParseError(team)) {
    return team;
  }

  return {
    command: {
      kind: "app-create",
      name,
      requireCodeSigning: parsedFlags.flags.requireCodeSigning === true,
      serverUrl,
      team,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseWhoami(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, whoamiSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  return {
    command: {
      kind: "whoami",
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseLogin(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, loginSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  const timeoutSeconds =
    typeof parsedFlags.flags.timeoutSeconds === "number"
      ? parsedFlags.flags.timeoutSeconds
      : undefined;
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
    return {
      error: "--timeout-seconds must be a positive integer",
      ok: false,
      showHelp: true,
    };
  }

  const token =
    typeof parsedFlags.flags.token === "string"
      ? parsedFlags.flags.token
      : undefined;
  if (token !== undefined && token.trim().length === 0) {
    return {
      error: "--token must not be empty",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      kind: "login",
      serverUrl,
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(token === undefined ? {} : { token }),
    },
    ok: true,
  };
}

export function parseLogout(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, logoutSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  return {
    command: {
      kind: "logout",
      serverUrl,
    },
    ok: true,
  };
}

export function parseTokenCreate(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, tokenCreateSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const name = ensureNonBlankString(parsedFlags.flags, "name", "name");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(name)) {
    return name;
  }

  const expiresInDays =
    typeof parsedFlags.flags.expiresInDays === "number"
      ? parsedFlags.flags.expiresInDays
      : undefined;

  if (
    expiresInDays !== undefined &&
    (expiresInDays <= 0 || expiresInDays > MAX_TOKEN_EXPIRATION_DAYS)
  ) {
    return {
      error:
        "--expires-in-days must be a positive integer no greater than 3650",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
      kind: "token-create",
      name,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseTokenList(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, tokenListSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  return {
    command: {
      kind: "token-list",
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseTokenRevoke(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, tokenRevokeSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const tokenId = ensureNonBlankString(
    parsedFlags.flags,
    "tokenId",
    "token-id",
  );

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(tokenId)) {
    return tokenId;
  }

  return {
    command: {
      kind: "token-revoke",
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      tokenId,
    },
    ok: true,
  };
}

export function parseMemberList(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberListSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const team = parseTeamSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(format)) {
    return format;
  }

  return {
    command: {
      kind: "member-list",
      ...(format !== undefined ? { format } : {}),
      serverUrl,
      team,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseMemberAdd(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberAddSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const team = parseTeamSelector(parsedFlags.flags);
  const roleKey = ensureNonBlankString(parsedFlags.flags, "role", "role");
  const user = parseMemberUserSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(roleKey)) {
    return roleKey;
  }

  if (isParseError(user)) {
    return user;
  }

  return {
    command: {
      kind: "member-add",
      roleKey,
      serverUrl,
      team,
      user,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseMemberInvite(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberInviteSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const team = parseTeamSelector(parsedFlags.flags);
  const roleKey = ensureNonBlankString(parsedFlags.flags, "role", "role");
  const target = parseMemberInviteTarget(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(roleKey)) {
    return roleKey;
  }

  if (isParseError(target)) {
    return target;
  }

  return {
    command: {
      kind: "member-invite",
      roleKey,
      serverUrl,
      target,
      team,
      ...(typeof parsedFlags.flags.expiresInDays === "number"
        ? { expiresInDays: parsedFlags.flags.expiresInDays }
        : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseMemberProvision(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberProvisionSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const team = parseTeamSelector(parsedFlags.flags);
  const roleKey = ensureNonBlankString(parsedFlags.flags, "role", "role");
  const email = ensureNonBlankString(parsedFlags.flags, "email", "email");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(roleKey)) {
    return roleKey;
  }

  if (isParseError(email)) {
    return email;
  }

  return {
    command: {
      email,
      kind: "member-provision",
      roleKey,
      serverUrl,
      team,
      ...(typeof parsedFlags.flags.displayName === "string"
        ? { displayName: parsedFlags.flags.displayName }
        : {}),
      ...(typeof parsedFlags.flags.expiresInDays === "number"
        ? { expiresInDays: parsedFlags.flags.expiresInDays }
        : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(typeof parsedFlags.flags.tokenDisplayName === "string"
        ? { tokenDisplayName: parsedFlags.flags.tokenDisplayName }
        : {}),
    },
    ok: true,
  };
}

export function parseMemberInviteList(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberInviteListSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const team = parseTeamSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);
  const status = parseInvitationStatus(parsedFlags.flags.status);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(format)) {
    return format;
  }

  if (isParseError(status)) {
    return status;
  }

  return {
    command: {
      kind: "member-invite-list",
      ...(format !== undefined ? { format } : {}),
      serverUrl,
      team,
      ...(status !== undefined ? { status } : {}),
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseMemberInviteRevoke(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberInviteRevokeSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const invitationId = ensureNonBlankString(
    parsedFlags.flags,
    "invitationId",
    "invitation-id",
  );

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(invitationId)) {
    return invitationId;
  }

  return {
    command: {
      invitationId,
      kind: "member-invite-revoke",
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseMemberRemove(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, memberRemoveSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const bindingId =
    typeof parsedFlags.flags.bindingId === "string"
      ? ensureNonBlankString(parsedFlags.flags, "bindingId", "binding-id")
      : undefined;

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(bindingId)) {
    return bindingId;
  }

  const selectorFlagCount = [
    parsedFlags.flags.teamId,
    parsedFlags.flags.team,
    parsedFlags.flags.userId,
    parsedFlags.flags.email,
    parsedFlags.flags.role,
  ].filter((value) => value !== undefined).length;

  if (bindingId !== undefined) {
    if (selectorFlagCount > 0) {
      return {
        error:
          "--binding-id cannot be combined with --user-id, --email, or --role",
        ok: false,
        showHelp: true,
      };
    }

    return {
      command: {
        bindingId,
        kind: "member-remove",
        serverUrl,
        ...(typeof parsedFlags.flags.token === "string"
          ? { token: parsedFlags.flags.token }
          : {}),
      },
      ok: true,
    };
  }

  const team = parseTeamSelector(parsedFlags.flags);
  const roleKey = ensureNonBlankString(parsedFlags.flags, "role", "role");
  const user = parseMemberUserSelector(parsedFlags.flags);

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(roleKey)) {
    return roleKey;
  }

  if (isParseError(user)) {
    return user;
  }

  return {
    command: {
      kind: "member-remove",
      roleKey,
      serverUrl,
      team,
      user,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseAppList(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, appListSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const team = parseTeamSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(team)) {
    return team;
  }

  if (isParseError(format)) {
    return format;
  }

  return {
    command: {
      kind: "app-list",
      ...(format !== undefined ? { format } : {}),
      serverUrl,
      team,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseAppShow(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, appShowSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const app = parseAppSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(app)) {
    return app;
  }

  return {
    command: {
      app,
      kind: "app-show",
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseAppRename(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, appRenameSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const app = parseAppSelector(parsedFlags.flags);
  const name = ensureNonBlankString(parsedFlags.flags, "newName", "new-name");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(app)) {
    return app;
  }

  if (isParseError(name)) {
    return name;
  }

  return {
    command: {
      app,
      kind: "app-rename",
      name,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseAppSetting(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, appSettingSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const app = parseAppSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(app)) {
    return app;
  }

  if (!hasFlag(parsedFlags.flags, "requireCodeSigning")) {
    return {
      error: "Missing required flag --require-code-signing",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      app,
      kind: "app-setting",
      requireCodeSigning: parsedFlags.flags.requireCodeSigning === true,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}


export function parseAppRemove(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, appRemoveSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const app = parseAppSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(app)) {
    return app;
  }

  return {
    command: {
      app,
      kind: "app-remove",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseDeploymentList(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentListSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const app = parseAppSelector(parsedFlags.flags);
  const format = parseOutputFormat(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(app)) {
    return app;
  }

  if (isParseError(format)) {
    return format;
  }

  return {
    command: {
      app,
      kind: "deployment-list",
      ...(format !== undefined ? { format } : {}),
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseDeploymentCreate(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentCreateSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const app = parseAppSelector(parsedFlags.flags);
  const name = ensureNonBlankString(parsedFlags.flags, "name", "name");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(app)) {
    return app;
  }

  if (isParseError(name)) {
    return name;
  }

  return {
    command: {
      app,
      kind: "deployment-create",
      name,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseDeploymentRename(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentRenameSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);
  const name = ensureNonBlankString(parsedFlags.flags, "newName", "new-name");

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  if (isParseError(name)) {
    return name;
  }

  return {
    command: {
      deployment,
      kind: "deployment-rename",
      name,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseDeploymentRemove(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentRemoveSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  return {
    command: {
      deployment,
      kind: "deployment-remove",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseDeploymentClear(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentClearSchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return deployment;
  }

  return {
    command: {
      deployment,
      kind: "deployment-clear",
      ...(parsedFlags.flags.nonInteractive === true
        ? { nonInteractive: true }
        : {}),
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
      ...(parsedFlags.flags.yes === true ? { yes: true } : {}),
    },
    ok: true,
  };
}

export function parseDeploymentHistory(
  args: string[],
  defaults: CommandDefaultFlagValues = {},
): ParseCliResult {
  const parsedFlags = parseFlags(args, deploymentHistorySchema, defaults);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const serverUrl = ensureString(parsedFlags.flags, "serverUrl", "server-url");
  const deployment = parseDeploymentSelector(parsedFlags.flags);

  if (isParseError(serverUrl)) {
    return serverUrl;
  }

  if (isParseError(deployment)) {
    return describeDeploymentHistorySelectorError(parsedFlags.flags, deployment);
  }

  const pagination = parsePagination(parsedFlags.flags, { limit: 50 });

  if (isParseError(pagination)) {
    return pagination;
  }

  return {
    command: {
      deployment,
      includeMetrics: true,
      kind: "release-list",
      ...pagination,
      serverUrl,
      ...(typeof parsedFlags.flags.token === "string"
        ? { token: parsedFlags.flags.token }
        : {}),
    },
    ok: true,
  };
}

export function parseRawArgvCommand(
  args: string[],
  kind: "config" | "init",
): ParseCliResult {
  const stripped = stripGlobalFormatArgs(args);

  if (!stripped.ok) {
    return {
      error: stripped.error,
      ok: false,
      showHelp: true,
    };
  }

  return { command: { argv: stripped.args, kind }, ok: true };
}

export function parseContext(args: string[]): ParseCliResult {
  const parsedFlags = parseFlags(args, contextSchema);

  if (!parsedFlags.ok) {
    return {
      error: parsedFlags.error,
      ok: false,
      showHelp: true,
    };
  }

  const projectRoot = readStringFlag(parsedFlags.flags, "projectRoot");
  if (projectRoot !== undefined && projectRoot.trim().length === 0) {
    return {
      error: "--project-root must not be empty",
      ok: false,
      showHelp: true,
    };
  }

  const remote = parsedFlags.flags.remote === true;
  const token = readStringFlag(parsedFlags.flags, "token");
  if (token !== undefined && token.trim().length === 0) {
    return {
      error: "--token must not be empty",
      ok: false,
      showHelp: true,
    };
  }

  if (token !== undefined && !remote) {
    return {
      error: "--token requires --remote",
      ok: false,
      showHelp: true,
    };
  }

  return {
    command: {
      kind: "context",
      remote,
      ...(projectRoot === undefined ? {} : { projectRoot }),
      ...(token === undefined ? {} : { token }),
    },
    ok: true,
  };
}

function stripGlobalFormatArgs(
  args: string[],
): { args: string[]; ok: true } | { error: string; ok: false } {
  const strippedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--format") {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        return {
          error: "Flag --format requires a value",
          ok: false,
        };
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      continue;
    }

    strippedArgs.push(arg);
  }

  return { args: strippedArgs, ok: true };
}
