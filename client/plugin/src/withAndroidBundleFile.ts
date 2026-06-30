import { type ConfigPlugin, withMainApplication } from 'expo/config-plugins';

/**
 * Rewrites the host MainApplication so React Native boots the OTA bundle picked
 * by `CodemagicPatch.getJSBundleFile(applicationContext)`, falling back to the
 * embedded bundle when it returns null.
 *
 * Two host shapes are handled:
 *  - RN <= 0.81 (Expo SDK <= 54): the `DefaultReactNativeHost` object exposes
 *    `getJSBundleFile()`, so we insert an override. Expo wraps the host in
 *    `ReactNativeHostWrapper`, which delegates `getJSBundleFile()` to the wrapped
 *    host, so the override still fires. The override is anchored on the
 *    `isHermesEnabled` member when present (Expo SDK <= 53), falling back to the
 *    `isNewArchEnabled` member (Expo SDK 54 dropped the `isHermesEnabled`
 *    override from its MainApplication template).
 *  - RN >= 0.82: the host exposes only `reactHost` via `getDefaultReactHost(...)`,
 *    which takes a `jsBundleFilePath` argument.
 *
 * Mirrors the seam the bare-RN fixtures wire by hand; see
 * `client/android/src/main/java/com/codemagic-patch/sdk/CodemagicPatch.kt` `getJSBundleFile`.
 */

const IMPORT_LINE = 'import io.codemagic.patch.CodemagicPatch';
const HERMES_ANCHOR = 'override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED';
const NEWARCH_ANCHOR = 'override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED';
const GET_JS_BUNDLE_OVERRIDE =
  '        override fun getJSBundleFile(): String? =\n          CodemagicPatch.getJSBundleFile(applicationContext)';
const REACT_HOST_ANCHOR = 'getDefaultReactHost(';
const JS_BUNDLE_FILE_PATH_ARG = '\n        jsBundleFilePath = CodemagicPatch.getJSBundleFile(applicationContext),';

function addKotlinImport(contents: string): string {
  if (contents.includes(IMPORT_LINE)) {
    return contents;
  }
  const importRegex = /^import .*$/gm;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(contents)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error('[codemagic-patch] no import statements found in MainApplication; cannot wire CodemagicPatch bundle file.');
  }
  const idx = last.index + last[0].length;
  return contents.slice(0, idx) + `\n${IMPORT_LINE}` + contents.slice(idx);
}

/**
 * Pure string transform applied to the MainApplication contents. Exported so
 * the behavior can be unit-tested against representative template sources
 * without the Expo mod runtime. Idempotent; throws when the host shape is
 * unrecognized (no silent skip).
 */
export function transformAndroidMainApplication(contents: string, language: string): string {
  if (language !== 'kt') {
    throw new Error('[codemagic-patch] MainApplication must be Kotlin (.kt) for the CodemagicPatch plugin.');
  }
  if (contents.includes('CodemagicPatch.getJSBundleFile')) {
    return contents;
  }
  let next = addKotlinImport(contents);
  if (next.includes(HERMES_ANCHOR)) {
    // RN <= 0.79 ReactNativeHost path: anchor on the isHermesEnabled override.
    return next.replace(HERMES_ANCHOR, `${HERMES_ANCHOR}\n${GET_JS_BUNDLE_OVERRIDE}`);
  }
  if (next.includes(REACT_HOST_ANCHOR)) {
    // RN >= 0.82 reactHost path.
    const idx = next.indexOf(REACT_HOST_ANCHOR) + REACT_HOST_ANCHOR.length;
    return next.slice(0, idx) + JS_BUNDLE_FILE_PATH_ARG + next.slice(idx);
  }
  if (next.includes(NEWARCH_ANCHOR)) {
    // RN 0.81 ReactNativeHost path: Expo SDK 54 dropped the isHermesEnabled
    // override from the template, so anchor on the isNewArchEnabled override.
    return next.replace(NEWARCH_ANCHOR, `${NEWARCH_ANCHOR}\n${GET_JS_BUNDLE_OVERRIDE}`);
  }
  throw new Error('[codemagic-patch] MainApplication bundle anchor not found; cannot wire CodemagicPatch bundle file.');
}

export const withAndroidBundleFile: ConfigPlugin = (config) =>
  withMainApplication(config, (cfg) => {
    cfg.modResults.contents = transformAndroidMainApplication(cfg.modResults.contents, cfg.modResults.language);
    return cfg;
  });
