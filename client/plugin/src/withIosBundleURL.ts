import { type ConfigPlugin, withAppDelegate } from 'expo/config-plugins';

/**
 * Rewrites the host AppDelegate so the boot bundle URL prefers the OTA bundle
 * (`CodemagicPatch.bundleURL()`) and falls back to the embedded bundle. Handles both
 * the Objective-C(++) AppDelegate (Expo SDK <= 52) and the Swift AppDelegate
 * (Expo SDK >= 53). The DEBUG / Metro branch (`.expo/.virtual-metro-entry`) is
 * left untouched so local development keeps working.
 *
 * Mirrors the seam the bare-RN fixtures wire by hand; see
 * `client/ios/CodemagicPatch.swift` `bundleURL()`.
 */

// ObjC: forward-declare the CodemagicPatch class (same approach as the bare fixtures)
// so we don't depend on the umbrella header import path.
const OBJC_FORWARD_DECL = `@interface CodemagicPatch : NSObject
+ (NSURL *_Nullable)bundleURL;
@end

`;
const OBJC_EMBEDDED = '[[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"]';
const OBJC_REPLACEMENT = `([CodemagicPatch bundleURL] ?: ${OBJC_EMBEDDED})`;

const SWIFT_IMPORT = 'import CodemagicPatchClient';
const SWIFT_EMBEDDED = 'Bundle.main.url(forResource: "main", withExtension: "jsbundle")';
const SWIFT_REPLACEMENT = `CodemagicPatch.bundleURL() ?? ${SWIFT_EMBEDDED}`;

function alreadyWired(contents: string): boolean {
  return contents.includes('[CodemagicPatch bundleURL]') || contents.includes('CodemagicPatch.bundleURL()');
}

function addObjcForwardDecl(contents: string): string {
  if (contents.includes('@interface CodemagicPatch')) {
    return contents;
  }
  const anchor = contents.indexOf('@implementation');
  if (anchor === -1) {
    throw new Error('[codemagic-patch] @implementation not found in AppDelegate; cannot wire CodemagicPatch bundle URL.');
  }
  return contents.slice(0, anchor) + OBJC_FORWARD_DECL + contents.slice(anchor);
}

function addSwiftImport(contents: string): string {
  if (new RegExp(`^${SWIFT_IMPORT}$`, 'm').test(contents)) {
    return contents;
  }
  const importRegex = /^import .*$/gm;
  let last: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(contents)) !== null) {
    last = match;
  }
  if (!last) {
    throw new Error('[codemagic-patch] no import statements found in Swift AppDelegate; cannot wire CodemagicPatch bundle URL.');
  }
  const idx = last.index + last[0].length;
  return contents.slice(0, idx) + `\n${SWIFT_IMPORT}` + contents.slice(idx);
}

/**
 * Pure string transform applied to the AppDelegate contents. Exported so the
 * behavior can be unit-tested against representative template sources without
 * the Expo mod runtime. Idempotent; throws when the expected anchor is missing
 * (no silent skip).
 */
export function transformIosAppDelegate(contents: string, language: string): string {
  if (alreadyWired(contents)) {
    return contents;
  }
  if (language === 'swift') {
    if (!contents.includes(SWIFT_EMBEDDED)) {
      throw new Error(
        '[codemagic-patch] Swift AppDelegate embedded-bundle anchor not found; cannot wire CodemagicPatch bundle URL.',
      );
    }
    return addSwiftImport(contents.replace(SWIFT_EMBEDDED, SWIFT_REPLACEMENT));
  }
  // objc / objcpp
  if (!contents.includes(OBJC_EMBEDDED)) {
    throw new Error(
      '[codemagic-patch] Objective-C AppDelegate embedded-bundle anchor not found; cannot wire CodemagicPatch bundle URL.',
    );
  }
  return addObjcForwardDecl(contents.replace(OBJC_EMBEDDED, OBJC_REPLACEMENT));
}

export const withIosBundleURL: ConfigPlugin = (config) =>
  withAppDelegate(config, (cfg) => {
    cfg.modResults.contents = transformIosAppDelegate(cfg.modResults.contents, cfg.modResults.language);
    return cfg;
  });
