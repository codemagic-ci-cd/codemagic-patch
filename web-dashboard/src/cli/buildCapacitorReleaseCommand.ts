// Assembles a `cmpatch-capacitor release create` snippet for the dashboard CLI
// builder. Mirrors flag names from cli-capacitor/src/commands/releaseCreate.ts
// and the flag groups in cli-capacitor/src/command.ts — string only, no CLI
// import. There is no `--platform`: a Capacitor release is web assets, and the
// app (one per platform) already says which platform it is for.

import { pushBooleanFlag, pushFlag } from "./commandFlags";

export interface CapacitorReleaseCommandInput {
  serverUrl: string;
  appName: string;
  deploymentName: string;
  /** The built webDir, or a ZIP of its contents. Required by the CLI. */
  bundlePath: string;
  /** Exact native app version, never a range — the CLI rejects those. */
  targetBinaryVersion?: string;
  releaseNotes?: string;
  rolloutPercentage?: number;
  mandatory?: boolean;
  disabled?: boolean;
  dryRun?: boolean;
  privateKeyPath?: string;
}

// What the CLI's usage line calls the two required values. pushFlag quotes them,
// and they depend on it: bare, `<` and `|` would be the shell's. Quoted, a command
// pasted with one still in it reaches the CLI as a literal and is refused there.
const BUNDLE_PATH_PLACEHOLDER = "<dir|zip>";
const TARGET_BINARY_VERSION_PLACEHOLDER = "<version>";

/**
 * Flag order follows the command's own usage line. `--bundle-path` and
 * `--target-binary-version` are required, so a blank field shows as a
 * placeholder instead of dropping out: a deployment with no release yet has no
 * version to suggest, and that is where a new app's first command is copied.
 */
export function buildCapacitorReleaseCommand(
  input: CapacitorReleaseCommandInput,
): string {
  const parts: string[] = [];
  pushFlag(
    parts,
    "bundle-path",
    valueOrPlaceholder(input.bundlePath, BUNDLE_PATH_PLACEHOLDER),
  );
  pushFlag(
    parts,
    "target-binary-version",
    valueOrPlaceholder(input.targetBinaryVersion, TARGET_BINARY_VERSION_PLACEHOLDER),
  );

  pushFlag(parts, "app", input.appName);
  pushFlag(parts, "deployment", input.deploymentName);

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

  if (input.releaseNotes !== undefined) {
    pushFlag(parts, "release-notes", input.releaseNotes);
  }
  if (input.privateKeyPath !== undefined) {
    pushFlag(parts, "private-key-path", input.privateKeyPath);
  }

  if (input.dryRun === true) {
    pushBooleanFlag(parts, "dry-run");
  }

  pushFlag(parts, "server-url", input.serverUrl);

  // No --yes, as in the README's own examples: it is only needed off a
  // terminal, and a pasted command should still stop at the confirmation.
  return ["cmpatch-capacitor release create", ...parts].join(" ");
}

function valueOrPlaceholder(value: string | undefined, placeholder: string): string {
  return value === undefined || value.trim().length === 0 ? placeholder : value;
}
