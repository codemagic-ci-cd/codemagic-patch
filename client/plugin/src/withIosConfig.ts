import { type ConfigPlugin, withInfoPlist } from 'expo/config-plugins';
import type { CodemagicPatchPlatformConfig } from './types';

/**
 * Writes the iOS CodemagicPatch configuration into Info.plist. These are the exact
 * keys the native SDK reads via `Bundle.main.object(forInfoDictionaryKey:)`
 * (see `client/ios/CodemagicPatchModule.swift` `config(_:)`), so no native change is
 * required — the plugin only supplies the values.
 */
export function applyIosInfoPlist(
  plist: Record<string, unknown>,
  ios: CodemagicPatchPlatformConfig,
): Record<string, unknown> {
  plist.CodemagicPatchDeploymentKey = ios.deploymentKey;
  plist.CodemagicPatchDownloadBaseUrl = ios.downloadBaseUrl;
  plist.CodemagicPatchApiUrl = ios.apiUrl;
  if (ios.publicKey) {
    plist.CodemagicPatchPublicKey = ios.publicKey;
  }
  return plist;
}

export const withIosConfig: ConfigPlugin<CodemagicPatchPlatformConfig> = (config, ios) =>
  withInfoPlist(config, (cfg) => {
    applyIosInfoPlist(cfg.modResults as Record<string, unknown>, ios);
    return cfg;
  });
