// Import from `expo/config-plugins` (NOT `@expo/config-plugins`) on purpose.
// `expo/config-plugins` is a thin re-export that ships inside the `expo` package
// (`module.exports = require('@expo/config-plugins')`), version-locked to the host
// app's Expo SDK. Resolving through it means:
//   1. The config-plugins version always matches the host's SDK (no 9.x-vs-56.x skew).
//   2. It resolves reliably for consumers — `expo` is always a *direct* dependency of
//      any project that runs `expo prebuild`, so the lookup succeeds even on
//      pnpm/isolated linkers (the old `@expo/config-plugins` import only resolved when
//      it happened to be hoisted; see contract audit EXPO-03).
// `expo` is declared ONLY as a devDependency of this package (see package.json
// "//expo"): it is never shipped to consumers, so the SDK stays usable in bare React
// Native (which never loads this plugin). The devDependency exists so this file builds,
// vitest can load it, and the monorepo E2E lanes — where the plugin is portal-linked and
// Node resolves its requires from the client tree, not the fixture — can run prebuild.
// Do NOT switch this back to `@expo/config-plugins`, and do NOT make `expo` a real
// dependency/peerDependency.
import { type ConfigPlugin, createRunOncePlugin, withPlugins } from 'expo/config-plugins';
import type { CodemagicPatchPluginProps } from './types';
import { validatePluginProps } from './validateConfig';
import { withIosBundleURL } from './withIosBundleURL';
import { withIosConfig } from './withIosConfig';
import { withAndroidBundleFile } from './withAndroidBundleFile';
import { withAndroidConfig } from './withAndroidConfig';

/**
 * Expo config plugin for `@codemagic/patch-client`.
 *
 * Adds, at prebuild time, the native bundle-selection seam the SDK needs (the
 * one bare-RN hosts wire by hand) plus the per-platform CodemagicPatch config values.
 * The bundle-override mods are run-once (idempotent across the plugin chain);
 * the config mods run every prebuild so prop changes always apply.
 *
 */
const withCodemagicPatch: ConfigPlugin<CodemagicPatchPluginProps> = (config, props = {}) => {
  validatePluginProps(props);

  const plugins: Parameters<typeof withPlugins>[1] = [];

  if (props.ios) {
    plugins.push(createRunOncePlugin(withIosBundleURL, '@codemagic/patch-client:ios-bundle'));
    plugins.push([withIosConfig, props.ios]);
  }
  if (props.android) {
    plugins.push(createRunOncePlugin(withAndroidBundleFile, '@codemagic/patch-client:android-bundle'));
    plugins.push([withAndroidConfig, props.android]);
  }

  return withPlugins(config, plugins);
};

export default withCodemagicPatch;
