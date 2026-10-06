// Standalone build-time check, alongside ./checkDeploymentKeys.ts (see
// bin/check-deployment-keys.mjs). At runtime the native resolvers tolerate an invalid
// `maxLaunchAttempts` by warning and falling back to the default of 3, so a typo can
// never block boot — but silently ignoring what the developer wrote would hide the
// mistake until a rollback happens at the wrong launch. Build time is the place to fail
// loudly, as upstream's Expo config plugin does at prebuild.

import type { DeploymentKeyCheckResult } from './checkDeploymentKeys';

/** Largest value both native readers accept (Int32). */
export const MAX_LAUNCH_ATTEMPTS_LIMIT = 2147483647;

/**
 * Checks `plugins.CodemagicPatch.{ios,android}.maxLaunchAttempts` in a parsed
 * `capacitor.config.json`. Absent (or `null`/blank) is fine — the SDK default applies.
 * Anything else must be a whole number from 1 to {@link MAX_LAUNCH_ATTEMPTS_LIMIT},
 * given as a number or a decimal string, exactly what the native resolvers accept.
 */
export function checkMaxLaunchAttempts(capacitorConfig: unknown): DeploymentKeyCheckResult {
  const problems: string[] = [];
  for (const platform of ['ios', 'android'] as const) {
    const value = readMaxLaunchAttempts(capacitorConfig, platform);
    if (value !== undefined && !isValidMaxLaunchAttempts(value)) {
      problems.push(
        `CodemagicPatch: plugins.CodemagicPatch.${platform}.maxLaunchAttempts must be a positive integer ` +
          `up to ${MAX_LAUNCH_ATTEMPTS_LIMIT}, got ${JSON.stringify(value)}. Omit it to keep the SDK default of 3.`,
      );
    }
  }
  return problems.length === 0 ? { ok: true } : { ok: false, message: problems.join('\n') };
}

function isValidMaxLaunchAttempts(value: unknown): boolean {
  const parsed = typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LAUNCH_ATTEMPTS_LIMIT;
}

function readMaxLaunchAttempts(capacitorConfig: unknown, platform: 'ios' | 'android'): unknown {
  const plugins = asRecord(capacitorConfig)?.plugins;
  const block = asRecord(asRecord(asRecord(plugins)?.CodemagicPatch)?.[platform]);
  const value = block?.maxLaunchAttempts;
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
