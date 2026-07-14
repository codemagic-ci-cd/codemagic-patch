// Assembles a `cmpatch release-react` snippet for the dashboard CLI builder.
// Mirrors flag names from cli/src/commandParsers.ts — string only, no CLI import.

export type ReleaseReactPlatform = "android" | "ios";

export interface ReleaseReactCommandInput {
  serverUrl: string;
  appName: string;
  deploymentName: string;
  platform: ReleaseReactPlatform;
  targetBinaryVersion?: string;
  releaseNotes?: string;
  rolloutPercentage?: number;
  mandatory?: boolean;
  disabled?: boolean;
  dryRun?: boolean;
  privateKeyPath?: string;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Value flags are string flags in the CLI parser: a bare `--flag` with no value
// is a parse error, so an absent or blank value must omit the flag entirely.
function pushFlag(parts: string[], flag: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  parts.push(`--${flag} ${shellQuote(trimmed)}`);
}

function pushBooleanFlag(parts: string[], flag: string): void {
  parts.push(`--${flag}`);
}

export function buildReleaseReactCommand(
  input: ReleaseReactCommandInput,
): string {
  const parts: string[] = [];
  pushFlag(parts, "server-url", input.serverUrl);
  pushFlag(parts, "app", input.appName);
  pushFlag(parts, "deployment", input.deploymentName);
  pushFlag(parts, "platform", input.platform);

  if (input.targetBinaryVersion !== undefined) {
    pushFlag(parts, "target-binary-version", input.targetBinaryVersion);
  }

  if (input.releaseNotes !== undefined) {
    pushFlag(parts, "release-notes", input.releaseNotes);
  }

  const rollout = input.rolloutPercentage ?? 100;
  if (rollout !== 100) {
    pushFlag(parts, "rollout-percentage", String(rollout));
  }

  if (input.mandatory === true) {
    pushBooleanFlag(parts, "mandatory");
  }
  if (input.disabled === true) {
    pushBooleanFlag(parts, "disabled");
  }
  if (input.dryRun === true) {
    pushBooleanFlag(parts, "dry-run");
  }

  if (input.privateKeyPath !== undefined) {
    pushFlag(parts, "private-key-path", input.privateKeyPath);
  }

  // No --yes: release-react mutates server state, so the pasted command should
  // still stop at the CLI's interactive confirmation.
  return ["cmpatch release-react", ...parts].join(" ");
}
