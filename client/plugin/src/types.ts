/**
 * Public prop shape for the `@codemagic/react-native-patch` Expo config plugin.
 *
 * Deployment keys differ per platform, so the plugin takes a separate config
 * block for iOS and Android. Each block is written verbatim into the native
 * config resource the SDK already reads at runtime (Info.plist / strings.xml);
 * see `withIosConfig` / `withAndroidConfig`.
 */
export interface CodemagicPatchPlatformConfig {
  /** `CodemagicPatchDeploymentKey` — deployment identifier for manifest fetches. */
  deploymentKey: string;
  /** `CodemagicPatchDownloadBaseUrl` — base URL for manifest and artifact downloads. */
  downloadBaseUrl: string;
  /** `CodemagicPatchApiUrl` — base URL for metrics event submission. */
  apiUrl: string;
  /** `CodemagicPatchPublicKey` — optional PEM key; only needed for client-side signature enforcement. */
  publicKey?: string;
}

export interface CodemagicPatchPluginProps {
  ios?: CodemagicPatchPlatformConfig;
  android?: CodemagicPatchPlatformConfig;
}
