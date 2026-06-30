import { AndroidConfig, type ConfigPlugin, withStringsXml } from 'expo/config-plugins';
import type { CodemagicPatchPlatformConfig } from './types';

type ResourceXML = AndroidConfig.Resources.ResourceXML;

/**
 * Writes the Android CodemagicPatch configuration into res/values/strings.xml. These
 * are the exact string resource names the native SDK reads via
 * `resources.getIdentifier(key, "string", packageName)` (see
 * `client/android/.../CodemagicPatchModule.kt` `config(...)`), so no native change is
 * required — the plugin only supplies the values.
 */
export function applyAndroidStrings(stringsXml: ResourceXML, android: CodemagicPatchPlatformConfig): ResourceXML {
  const entries: { name: string; value: string }[] = [
    { name: 'CodemagicPatchDeploymentKey', value: android.deploymentKey },
    { name: 'CodemagicPatchDownloadBaseUrl', value: android.downloadBaseUrl },
    { name: 'CodemagicPatchApiUrl', value: android.apiUrl },
  ];
  if (android.publicKey) {
    entries.push({ name: 'CodemagicPatchPublicKey', value: android.publicKey });
  }
  return AndroidConfig.Strings.setStringItem(
    entries.map((entry) => ({ $: { name: entry.name, translatable: 'false' }, _: entry.value })),
    stringsXml,
  );
}

export const withAndroidConfig: ConfigPlugin<CodemagicPatchPlatformConfig> = (config, android) =>
  withStringsXml(config, (cfg) => {
    cfg.modResults = applyAndroidStrings(cfg.modResults, android);
    return cfg;
  });
