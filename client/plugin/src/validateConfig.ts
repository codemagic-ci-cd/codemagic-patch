import type { CodemagicPatchPlatformConfig, CodemagicPatchPluginProps } from './types';

/**
 * Config values the native SDK cannot function without. `publicKey` is optional
 * (only needed for client-side signature enforcement) and is intentionally not
 * required here.
 */
const REQUIRED_KEYS = ['deploymentKey', 'downloadBaseUrl', 'apiUrl'] as const;

/** Largest `maxLaunchAttempts` both native readers accept (Int32). */
const MAX_LAUNCH_ATTEMPTS_LIMIT = 2147483647;

/**
 * Fails the prebuild when a *provided* platform block is missing a required
 * config value.
 *
 * The native SDK reads these values from `Info.plist` / `strings.xml` and treats
 * a missing resource as an empty string, which silently disables OTA. Catching
 * it here keeps the plugin fail-loud, matching the bundle-wiring transforms that
 * throw on an unrecognized host (see `withIosBundleURL` / `withAndroidBundleFile`).
 *
 * This only runs for platform blocks the host actually supplies. A single
 * platform may be omitted (that platform is simply not wired for OTA); omitting
 * *both* is rejected separately by {@link validatePluginProps}.
 *
 * `app.json` is plain JSON with no compile-time checking, so the values are
 * treated as untrusted: a non-string or whitespace-only value counts as missing.
 */
export function assertPlatformConfig(
  platform: 'ios' | 'android',
  block: CodemagicPatchPlatformConfig,
): void {
  const values = block as Partial<Record<(typeof REQUIRED_KEYS)[number], unknown>>;
  const missing = REQUIRED_KEYS.filter((key) => {
    const value = values[key];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `[codemagic-patch] ${platform} config is missing required value(s): ${missing.join(', ')}. ` +
        `Set them in app config under plugins → "@codemagic/react-native-patch" → ${platform} ` +
        `(deploymentKey, downloadBaseUrl, and apiUrl are all required; publicKey is optional). ` +
        `To disable OTA for ${platform}, omit the ${platform} block entirely.`,
    );
  }

  // The native SDK tolerates a malformed value at runtime by falling back to
  // its default, but silently ignoring what the developer wrote in app config
  // would hide the mistake until a rollback happens at the wrong launch.
  // Prebuild is the place to fail loudly.
  // Int32 is the range the Android reader accepts, so it is the range both
  // platforms accept.
  const attempts = (block as { maxLaunchAttempts?: unknown }).maxLaunchAttempts;
  if (
    attempts !== undefined &&
    !(Number.isInteger(attempts) && (attempts as number) >= 1 && (attempts as number) <= MAX_LAUNCH_ATTEMPTS_LIMIT)
  ) {
    throw new Error(
      `[codemagic-patch] ${platform} config value maxLaunchAttempts must be a positive integer ` +
        `up to ${MAX_LAUNCH_ATTEMPTS_LIMIT}, got ${JSON.stringify(attempts)}. Omit it to keep the SDK default of 3.`,
    );
  }
}

/**
 * Validates the whole plugin props at prebuild time.
 *
 * Per-platform blocks are opt-in: a host may configure `ios` only, `android`
 * only, or both. But the plugin does nothing useful with no platform at all, so
 * omitting *both* blocks (or listing the plugin with no props) is rejected here
 * rather than producing an app with OTA silently disabled everywhere. Every
 * provided block is then checked for its required values.
 */
export function validatePluginProps(props: CodemagicPatchPluginProps): void {
  if (!props.ios && !props.android) {
    throw new Error(
      `[codemagic-patch] no platform is configured. Provide an "ios" and/or "android" block under ` +
        `plugins → "@codemagic/react-native-patch" (each with deploymentKey, downloadBaseUrl, and apiUrl). ` +
        `At least one platform is required.`,
    );
  }

  if (props.ios) {
    assertPlatformConfig('ios', props.ios);
  }
  if (props.android) {
    assertPlatformConfig('android', props.android);
  }
}
