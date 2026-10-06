// Standalone build-time check, not part of the runtime plugin surface (see bin/check-
// deployment-keys.mjs and specs/adr/0003-configuration-via-capacitor-config.md's "Warn if
// both platforms resolve to the same deploymentKey"). `PROTOCOL.md`'s manifest path
// carries no platform segment, so a deploymentKey shared between iOS and Android lets
// one platform's release silently overwrite the other's manifest — this is checkable
// entirely from the plugin config object, with no native code or running app involved,
// so it runs at build time instead of waiting to surface as a runtime bug report.
export interface DeploymentKeyCheckResult {
  ok: boolean;
  /** Present only when {@link DeploymentKeyCheckResult.ok} is `false`. */
  message?: string;
}

/**
 * Checks a parsed `capacitor.config.json` (or equivalent) for a `deploymentKey` shared
 * between the `ios` and `android` blocks of `plugins.CodemagicPatch`. Any shape other
 * than "both present, both non-blank, both equal" is `ok: true` — including a config
 * missing one or both blocks entirely, which is a separate configuration error the
 * native `CodemagicPatchConfigResolver` already reports on its own.
 */
export function checkDeploymentKeys(capacitorConfig: unknown): DeploymentKeyCheckResult {
  const iosKey = readDeploymentKey(capacitorConfig, 'ios');
  const androidKey = readDeploymentKey(capacitorConfig, 'android');

  if (iosKey !== undefined && androidKey !== undefined && iosKey === androidKey) {
    return {
      ok: false,
      message:
        `CodemagicPatch: plugins.CodemagicPatch.ios.deploymentKey and .android.deploymentKey ` +
        `are both "${iosKey}". PROTOCOL.md requires separate deployment keys per platform — the ` +
        `manifest path carries no platform segment, so releases for one platform will silently ` +
        `overwrite the manifest the other platform reads. Set two different deploymentKey values ` +
        `in capacitor.config.ts.`,
    };
  }
  return { ok: true };
}

function readDeploymentKey(capacitorConfig: unknown, platform: 'ios' | 'android'): string | undefined {
  const plugins = asRecord(capacitorConfig)?.plugins;
  const codemagicPatch = asRecord(plugins)?.CodemagicPatch;
  const block = asRecord(codemagicPatch)?.[platform];
  const key = asRecord(block)?.deploymentKey;
  return typeof key === 'string' && key.trim() !== '' ? key : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
