// The native bundle-selection hook: AppDelegate prefers the OTA bundle and
// MainApplication feeds the OTA bundle path to React Native. The same seam
// the Expo config plugin wires at prebuild, transformed here for projects
// that maintain their native code — with the conflict checks a prebuild
// template never needed: another OTA integration, a hand-written override,
// or an anchor that is not where the template put it all make the step the
// developer's rather than silently stacking a second update mechanism.
//
// Every search runs on comment-stripped text, which keeps the original's
// length, so a match index is spliced straight into the original source.

import path from "node:path";

import {
  scanNativeSources,
  withoutComments,
  withoutLiterals,
} from "../doctor/discovery";
import { isFile } from "./fs";

export type HookTransform =
  | { kind: "changed"; contents: string }
  | { kind: "already-configured" }
  /** Names the foreign bundle hook or update system that blocks the edit. */
  | { kind: "manual"; reason: string; otaSymbol?: string };

/** Symbols that mean another OTA system already owns bundle selection. */
const OTHER_OTA_SYMBOLS = [
  "CodePush",
  "EXUpdates",
  "UpdatesController",
  "expo.modules.updates",
  "HotUpdater",
  "ReactNativeHotUpdate",
  "UpdateModule",
];

/**
 * Checked before any Patch call is trusted: a host that calls both, as in
 * `CodePush.bundleURL() ?? CodemagicPatch.bundleURL()`, is still the other
 * system's while it runs first, so `alongsidePatch` only changes the wording.
 */
function otherOtaConflict(code: string, alongsidePatch = false): HookTransform | undefined {
  const symbol = OTHER_OTA_SYMBOLS.find((name) =>
    new RegExp(`\\b${name.replace(/\./g, "\\.")}\\b`).test(code),
  );
  return symbol === undefined
    ? undefined
    : {
        kind: "manual",
        reason: alongsidePatch
          ? `another OTA integration (${symbol}) still controls bundle selection alongside CodemagicPatch`
          : `another OTA integration (${symbol}) already controls bundle selection`,
        otaSymbol: symbol,
      };
}

function manual(reason: string): HookTransform {
  return { kind: "manual", reason };
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function splice(text: string, index: number, insertion: string): string {
  return `${text.slice(0, index)}${insertion}${text.slice(index)}`;
}

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}

/** Adds `line` after the last import unless the module is already imported. */
function ensureImport(
  contents: string,
  importLine: RegExp,
  line: string,
): string | null {
  const code = withoutComments(contents);
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^[ \\t]*(?:@\\w+\\s+|\\w+\\s+)*${escaped}\\b`, "m").test(code)) {
    return contents;
  }
  const last = lastMatch(code, importLine);
  if (last === null) return null;
  return splice(contents, last.index + last[0].length, `${eolOf(contents)}${line}`);
}

// --- iOS -------------------------------------------------------------------

const SWIFT_IMPORT = "import CodemagicPatchClient";
/** `internal import Expo`, `@_exported import X`: modifiers come before `import`. */
const SWIFT_IMPORT_LINE = /^[ \t]*(?:@\w+\s+|\w+\s+)*import .*$/gm;
const SWIFT_EMBEDDED =
  'Bundle.main.url(forResource: "main", withExtension: "jsbundle")';
const SWIFT_CALL = "CodemagicPatch.bundleURL()";
const OBJC_EMBEDDED =
  '[[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"]';
const OBJC_CALL = "[CodemagicPatch bundleURL]";
const OBJC_FORWARD_DECLARATION = [
  "@interface CodemagicPatch : NSObject",
  "+ (NSURL *_Nullable)bundleURL;",
  "@end",
  "",
];

export function transformIosAppDelegate(
  contents: string,
  language: "objc" | "swift",
): HookTransform {
  const code = withoutLiterals(contents);
  const uncommented = withoutComments(contents);
  const eol = eolOf(contents);
  const patched = code.includes(
    language === "swift" ? "CodemagicPatch.bundleURL" : "[CodemagicPatch bundleURL]",
  );
  const conflict = otherOtaConflict(code, patched);
  if (conflict !== undefined) return conflict;
  if (patched) {
    const declared =
      language === "swift"
        ? ensureImport(contents, SWIFT_IMPORT_LINE, SWIFT_IMPORT)
        : declareObjcClass(contents, uncommented, code, eol);
    if (declared === null) return manual("no import to place the module import after");
    return declared === contents
      ? { kind: "already-configured" }
      : { kind: "changed", contents: declared };
  }

  const embedded = language === "swift" ? SWIFT_EMBEDDED : OBJC_EMBEDDED;
  const anchors = [...uncommented.matchAll(new RegExp(embedded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  if (anchors.length !== 1) {
    return manual(
      anchors.length === 0
        ? "the embedded-bundle expression the template uses was not found"
        : "the embedded-bundle expression appears more than once",
    );
  }
  const anchor = anchors[0]!;
  // The statement around the anchor, from the last brace, semicolon or
  // preprocessor line before it to the end of its line: a `??` / `?:` there
  // means the embedded bundle is already somebody's fallback.
  const before = uncommented.slice(0, anchor.index);
  const boundary = Math.max(
    before.lastIndexOf("{"),
    before.lastIndexOf("}"),
    before.lastIndexOf(";"),
    lastMatch(before, /^[ \t]*#[^\n]*$/gm)?.index ?? -1,
  );
  const lineEnd = uncommented.indexOf("\n", anchor.index);
  const statement = uncommented.slice(boundary + 1, lineEnd === -1 ? undefined : lineEnd);
  if (statement.includes(language === "swift" ? "??" : "?:")) {
    return { kind: "manual", reason: "the embedded bundle is already a fallback of another expression", otaSymbol: "custom bundle fallback" };
  }

  const replacement =
    language === "swift" ? `${SWIFT_CALL} ?? ${embedded}` : `(${OBJC_CALL} ?: ${embedded})`;
  const wired = `${contents.slice(0, anchor.index)}${replacement}${contents.slice(anchor.index + embedded.length)}`;
  const declared =
    language === "swift"
      ? ensureImport(wired, SWIFT_IMPORT_LINE, SWIFT_IMPORT)
      : declareObjcClass(wired, withoutComments(wired), withoutLiterals(wired), eol);
  return declared === null
    ? manual(language === "swift" ? "no import to place the module import after" : "no @implementation to declare CodemagicPatch before")
    : { kind: "changed", contents: declared };
}

/**
 * The class is known either through the module's umbrella header or through
 * a forward declaration placed before the implementation; a second
 * declaration would not compile.
 */
function declareObjcClass(
  contents: string,
  uncommented: string,
  code: string,
  eol: string,
): string | null {
  if (
    code.includes("@interface CodemagicPatch") ||
    /#import\s*[<"]CodemagicPatchClient/.test(uncommented)
  ) {
    return contents;
  }
  const implementation = uncommented.indexOf("@implementation");
  return implementation === -1
    ? null
    : splice(contents, implementation, OBJC_FORWARD_DECLARATION.join(eol) + eol);
}

export type IosAppDelegate =
  | { kind: "resolved"; file: string; language: "objc" | "swift" }
  | { kind: "unresolved"; reason: string };

/**
 * The delegate among the app target's sources; when Xcode's synchronized
 * folders hide the file list, the one next to the target's Info.plist.
 */
export async function locateIosAppDelegate(
  sources: string[],
  plistDirectory: string,
): Promise<IosAppDelegate> {
  let candidates = sources.filter((file) => /AppDelegate\.(swift|mm|m)$/.test(file));
  if (candidates.length === 0) {
    candidates = [];
    for (const name of ["AppDelegate.swift", "AppDelegate.mm", "AppDelegate.m"]) {
      const file = path.join(plistDirectory, name);
      if (await isFile(file)) candidates.push(file);
    }
  }
  if (candidates.length !== 1) {
    return {
      kind: "unresolved",
      reason:
        candidates.length === 0
          ? "no AppDelegate source was found in the application target"
          : `several AppDelegate sources: ${candidates.map((file) => path.basename(file)).join(", ")}`,
    };
  }
  const file = candidates[0]!;
  return {
    kind: "resolved",
    file,
    language: file.endsWith(".swift") ? "swift" : "objc",
  };
}

// --- Android ---------------------------------------------------------------

const KOTLIN_IMPORT = "import io.codemagic.patch.CodemagicPatch";
const KOTLIN_IMPORT_LINE = /^[ \t]*import .*$/gm;
const KOTLIN_CALL = "CodemagicPatch.getJSBundleFile(applicationContext)";

export function transformAndroidMainApplication(
  contents: string,
  language: "java" | "kt",
): HookTransform {
  if (language === "java") {
    return manual("MainApplication is Java; only the Kotlin template is transformed");
  }
  const code = withoutLiterals(contents);
  const eol = eolOf(contents);
  const imported = (text: string): HookTransform => {
    const result = ensureImport(text, KOTLIN_IMPORT_LINE, KOTLIN_IMPORT);
    return result === null
      ? manual("no import to place the SDK import after")
      : result === contents
        ? { kind: "already-configured" }
        : { kind: "changed", contents: result };
  };
  const patched = code.includes("CodemagicPatch.getJSBundleFile");
  const conflict = otherOtaConflict(code, patched);
  if (conflict !== undefined) return conflict;
  if (patched) {
    return imported(contents);
  }
  if (/\bgetJSBundleFile\s*\(/.test(code)) {
    return { kind: "manual", reason: "MainApplication already overrides getJSBundleFile()", otaSymbol: "getJSBundleFile" };
  }
  if (/\bjsBundleFilePath\s*=/.test(code)) {
    return { kind: "manual", reason: "the React host already receives a jsBundleFilePath", otaSymbol: "jsBundleFilePath" };
  }

  if (/\bDefaultReactNativeHost\s*\(/.test(code)) {
    // Only insert after a complete template initializer, never between a
    // property and its getter or a continuation of its initializer.
    const anchor = /^([ \t]*)override val is(?:NewArch|Hermes)Enabled:[ \t]*Boolean[ \t]*=[ \t]*(?:BuildConfig\.IS_(?:NEW_ARCHITECTURE|HERMES)_ENABLED|true|false)[ \t]*(?=\r?$)(?=\s*(?:override\b|}))/m.exec(code);
    if (anchor === null) {
      return manual(
        "the DefaultReactNativeHost object has no complete template isNewArchEnabled or isHermesEnabled declaration to anchor on",
      );
    }
    const indent = anchor[1] ?? "";
    const override = `${eol}${eol}${indent}override fun getJSBundleFile(): String? =${eol}${indent}    ${KOTLIN_CALL}`;
    return imported(splice(contents, anchor.index + anchor[0].length, override));
  }
  const hosts = [...code.matchAll(/\bgetDefaultReactHost\s*\(/g)];
  if (hosts.length > 1) {
    return manual("getDefaultReactHost is called more than once");
  }
  const host = hosts[0];
  const argument =
    host === undefined
      ? null
      : /^\s*\n([ \t]*)\w+\s*=/.exec(code.slice(host.index + host[0].length));
  if (host === undefined || argument === null) {
    return manual(
      "neither a DefaultReactNativeHost object nor a named-argument getDefaultReactHost call was found",
    );
  }
  return imported(
    splice(
      contents,
      host.index + host[0].length,
      `${eol}${argument[1]}jsBundleFilePath = ${KOTLIN_CALL},`,
    ),
  );
}

export type AndroidMainApplication =
  | { kind: "resolved"; file: string; language: "java" | "kt" }
  | { kind: "unresolved"; reason: string };

/** The application class named by the manifest, via doctor's bounded scan. */
export async function locateAndroidMainApplication(
  projectRoot: string,
): Promise<AndroidMainApplication> {
  const scan = await scanNativeSources(
    path.join(projectRoot, "android", "app", "src"),
    "android",
  );
  const hosts = scan.files.filter((file) => /\.(kt|java)$/.test(file));
  if (scan.sourcesLimited === true) {
    return { kind: "unresolved", reason: "the Android source tree could not be scanned completely" };
  }
  // An empty list, as opposed to none, is the scan saying the manifest names
  // an application class it could not resolve to a file.
  if (scan.nativeSources?.length === 0) {
    return { kind: "unresolved", reason: "the application class named in AndroidManifest.xml could not be resolved" };
  }
  if (hosts.length !== 1) {
    return {
      kind: "unresolved",
      reason:
        hosts.length === 0
          ? "no application class source was found under android/app/src"
          : `several application class sources: ${hosts.map((file) => path.relative(projectRoot, file)).join(", ")}`,
    };
  }
  const file = hosts[0]!;
  return {
    kind: "resolved",
    file,
    language: file.endsWith(".kt") ? "kt" : "java",
  };
}
