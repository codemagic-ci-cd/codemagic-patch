// Assembles a `cmpatch release-react` snippet for the dashboard CLI builder.
// Mirrors flag names from cli/src/commandParsers.ts — string only, no CLI import.

export type ReleaseReactPlatform = "android" | "ios";

export interface ReleaseReactCommandInput {
  serverUrl: string;
  appName: string;
  deploymentName: string;
  platform: ReleaseReactPlatform;
  targetBinaryVersion?: string;
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

function pushFlag(parts: string[], flag: string, value?: string): void {
  if (value === undefined) {
    parts.push(`--${flag}`);
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  parts.push(`--${flag} ${shellQuote(trimmed)}`);
}

export function buildReleaseReactCommand(
  input: ReleaseReactCommandInput,
): string {
  const parts: string[] = [];
  pushFlag(parts, "server-url", input.serverUrl);
  pushFlag(parts, "app", input.appName);
  pushFlag(parts, "deployment", input.deploymentName);
  pushFlag(parts, "platform", input.platform);

  const targetVersion = input.targetBinaryVersion?.trim();
  if (targetVersion !== undefined && targetVersion.length > 0) {
    pushFlag(parts, "target-binary-version", targetVersion);
  }

  const rollout = input.rolloutPercentage ?? 100;
  if (rollout !== 100) {
    pushFlag(parts, "rollout-percentage", String(rollout));
  }

  if (input.mandatory === true) {
    pushFlag(parts, "mandatory");
  }
  if (input.disabled === true) {
    pushFlag(parts, "disabled");
  }
  if (input.dryRun === true) {
    pushFlag(parts, "dry-run");
  }

  const privateKeyPath = input.privateKeyPath?.trim();
  if (privateKeyPath !== undefined && privateKeyPath.length > 0) {
    pushFlag(parts, "private-key-path", privateKeyPath);
  }

  return ["cmpatch release-react", ...parts].join(" ");
}
