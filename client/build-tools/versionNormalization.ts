// Bare version normalization (specs/build-metadata.md §6 rule 3 and §6.2).
// Before hashing, literal app-version and build-number values in the native
// project files are replaced with a constant, so a version bump alone does not
// change a Bare project's fingerprint, as it already does not for a CNG
// project under the engine's `balanced` preset.
//
// Runs through the engine's `fileHookTransform`. The engine streams a file in
// 1024-byte chunks and calls one shared hook for every file, concurrently, so
// matching files are buffered per stream and transformed once at end of file.
//
// `project.pbxproj` and `Info.plist` each have a small scanner that knows the
// file's comments and strings and matches a key only outside them. When a case
// is unclear the value is left alone: normalizing too little makes a version
// bump change the fingerprint (visible, safe); normalizing too much gives two
// different native projects one fingerprint (invisible, unsafe).
//
// `build.gradle`, `build.gradle.kts` and `.xcconfig` files under `ios/` are
// matched line by line instead: a line is replaced only when it holds nothing
// but one of the file's keys (`versionCode`/`versionName`, or
// `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`) and a literal. The Gradle
// patterns do not know comments or strings, so such a line inside a
// multi-line comment or string is replaced too. That is acceptable: what such
// a replacement can hide is only ever a number or a one-line string after one
// of the two keys. An xcconfig has no multi-line comments or strings.
//
// All of it works on Latin-1 text (one char per byte), so every byte outside
// a replaced value round-trips, whether or not the file is valid UTF-8. Only
// ASCII characters are ever syntax.

import type { FileHookTransformFunction, FileHookTransformSource } from "@expo/fingerprint";

/**
 * The value written in place of every normalized literal. Changing it changes
 * fingerprints the way an engine bump does: only with an SDK release.
 */
export const NORMALIZED_VERSION_VALUE = "0";

/**
 * The version of these normalization rules (specs/build-metadata.md §6.2),
 * recorded in the calculator's `engine` string. Bump it whenever a rule change
 * can change the output for any input.
 */
export const VERSION_NORMALIZATION_RULES_VERSION = 1;

type Rule = {
  /** Matches the engine's project-relative, `/`-separated file path. */
  matchesPath: (filePath: string) => boolean;
  normalize: (contents: string) => string;
};

/** Replace `text.slice(start, end)` with `value`. */
type Replacement = { start: number; end: number; value: string };

function segmentsOf(filePath: string): string[] {
  return filePath.split("/");
}

function underNativeDirectory(filePath: string, directory: "ios" | "android"): boolean {
  const segments = segmentsOf(filePath);
  return segments.length > 1 && segments[0] === directory;
}

function basenameOf(filePath: string): string {
  const segments = segmentsOf(filePath);
  return segments[segments.length - 1]!;
}

function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  let out = "";
  let cursor = 0;
  for (const { start, end, value } of replacements) {
    out += text.slice(cursor, start) + value;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** ASCII white space only: Latin-1 0x85 and 0xA0 are bytes of UTF-8 text, not spaces. */
function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipSpaces(text: string, index: number): number {
  while (isSpace(text[index])) index++;
  return index;
}

/** Index of the `\n` (or `\r\n`) that ends the line `index` is on, or the text length. */
function lineEnd(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  if (newline === -1) return text.length;
  return text[newline - 1] === "\r" ? newline - 1 : newline;
}

/** Index after a non-nesting `/* … *\/` that starts at `index`, or the text length. */
function flatBlockCommentEnd(text: string, index: number): number {
  const close = text.indexOf("*/", index + 2);
  return close === -1 ? text.length : close + 2;
}

/** Applies a sticky pattern at `index`; returns the match or null. */
function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

// ---------------------------------------------------------------------------
// Line rules: build.gradle, build.gradle.kts and .xcconfig

// What may follow the literal on a matched line: optional `;`, then an
// optional `//` comment. `s` lets `.` take a lone CR, which is not a line end.
const LINE_TAIL = String.raw`[ \t]*;?[ \t]*(?:\/\/.*)?`;

/**
 * Maps every line through `normalizeLine`, which gets the line's text without
 * its line end and the next line, if any. A line ends at LF; a CR directly
 * before that LF belongs to the line end; a lone CR does not end a line.
 */
function mapLines(contents: string, normalizeLine: (text: string, next: string | undefined) => string): string {
  const lines = contents.split("\n");
  return lines
    .map((line, index) => {
      const cr = index < lines.length - 1 && line.endsWith("\r") ? "\r" : "";
      return normalizeLine(line.slice(0, line.length - cr.length), lines[index + 1]) + cr;
    })
    .join("\n");
}

/** `text` with the literal between a pattern's two groups replaced, or unchanged. */
function replaceLiteral(text: string, forms: readonly { pattern: RegExp; value: string }[]): string {
  for (const { pattern, value } of forms) {
    const match = pattern.exec(text);
    if (match !== null) return match[1] + value + match[2];
  }
  return text;
}

// build.gradle / build.gradle.kts: a line whose whole text is the key and a
// literal in one of three forms (`key = literal`, `key(literal)`,
// `key literal`), then the tail.
function gradleForms(key: string, literal: string, value: string): { pattern: RegExp; value: string }[] {
  return [
    String.raw`^([ \t]*${key}(?:[ \t]*=[ \t]*|[ \t]+))(?:${literal})(${LINE_TAIL})$`,
    String.raw`^([ \t]*${key}[ \t]*\([ \t]*)(?:${literal})([ \t]*\)${LINE_TAIL})$`,
  ].map((source) => ({ pattern: new RegExp(source, "s"), value }));
}

const GRADLE_FORMS = [
  ...gradleForms("versionCode", "[0-9](?:[0-9_]*[0-9])?", NORMALIZED_VERSION_VALUE),
  ...gradleForms("versionName", String.raw`"[^"$\\\n]*"|'[^'$\\\n]*'`, `"${NORMALIZED_VERSION_VALUE}"`),
];

// A next line that starts like this may continue the expression (`.plus(1)`,
// `?: 1`, `+ 1`, `/ 2`, …); a `//` or `/*` comment does not.
const GRADLE_CONTINUATION = /^[ \t]*(?:[.?:&|+\-*%=<>!^]|\/(?![/*]))/;

function normalizeGradle(contents: string): string {
  return mapLines(contents, (text, next) =>
    next !== undefined && GRADLE_CONTINUATION.test(next) ? text : replaceLiteral(text, GRADLE_FORMS),
  );
}

// .xcconfig: `KEY = literal`, then the tail. The literal is unquoted and has
// no `$`, so `$(inherited)`, `1.$(BUILD)` and a quoted value (whose quotes
// are part of an xcconfig value) are left alone, and so is a conditional
// setting (`KEY[sdk=…] = …`). An xcconfig value never continues on the next line.
const XCCONFIG_FORMS = [
  {
    pattern: new RegExp(
      String.raw`^([ \t]*(?:MARKETING_VERSION|CURRENT_PROJECT_VERSION)[ \t]*=[ \t]*)[A-Za-z0-9._-]+(${LINE_TAIL})$`,
      "s",
    ),
    value: NORMALIZED_VERSION_VALUE,
  },
];

function normalizeXcconfig(contents: string): string {
  return mapLines(contents, (text) => replaceLiteral(text, XCCONFIG_FORMS));
}

// ---------------------------------------------------------------------------
// project.pbxproj

// `MARKETING_VERSION = 1.2.3;` or `= "1.2.3";`. A literal is an unquoted
// pbxproj token (a `/` only between token characters, so a comment is never
// part of it) or a quoted string without `$` or a backslash (a `$(...)` build
// setting reference is not a literal and is left alone).
const PBXPROJ_STATEMENT =
  /(?:MARKETING_VERSION|CURRENT_PROJECT_VERSION)[ \t\r\n]*=[ \t\r\n]*([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|"[^"\\$\r\n]*")[ \t\r\n]*;/y;
const PBXPROJ_LEAD = new Set([" ", "\t", "\n", "\r", "{", ";"]);

function normalizePbxproj(contents: string): string {
  const replacements: Replacement[] = [];
  let i = 0;
  while (i < contents.length) {
    if (contents.startsWith("/*", i)) {
      i = flatBlockCommentEnd(contents, i);
      continue;
    }
    if (contents.startsWith("//", i)) {
      i = lineEnd(contents, i);
      continue;
    }
    if (contents[i] === '"') {
      i++;
      while (i < contents.length && contents[i] !== '"') i += contents[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (i === 0 || PBXPROJ_LEAD.has(contents[i - 1]!)) {
      const match = matchAt(PBXPROJ_STATEMENT, contents, i);
      if (match !== null) {
        const valueStart = i + match[0].indexOf(match[1]!, match[0].indexOf("="));
        replacements.push({
          start: valueStart,
          end: valueStart + match[1]!.length,
          value: NORMALIZED_VERSION_VALUE,
        });
        i += match[0].length;
        continue;
      }
    }
    i++;
  }
  return applyReplacements(contents, replacements);
}

// ---------------------------------------------------------------------------
// Info.plist (XML)

// `<key>CFBundleVersion</key>`, then white space and XML comments, then
// `<string>…</string>` whose text contains no `<`, `$` or `&` (so
// `$(MARKETING_VERSION)` stays as it is, also when written `&#36;(…)`).
// The key element holds the name and nothing else: a plist parser keeps
// white space inside `<key>`, so `<key> CFBundleVersion </key>` is another key.
const PLIST_KEY = /<key>(?:CFBundleShortVersionString|CFBundleVersion)<\/key>/y;
const PLIST_STRING = /<string>([^<$&]*)<\/string>/y;

function xmlCommentEnd(text: string, index: number): number {
  const close = text.indexOf("-->", index + 4);
  return close === -1 ? text.length : close + 3;
}

function normalizeInfoPlist(contents: string): string {
  // A binary property list is not changed: its string values can hold text
  // that looks like the XML form.
  if (contents.startsWith("bplist")) return contents;
  // Neither is one with a zero byte (every UTF-16 or UTF-32 XML file): the
  // scan matches bytes, and code units of a string value can spell the key.
  if (contents.includes("\0")) return contents;
  const replacements: Replacement[] = [];
  let i = 0;
  while (i < contents.length) {
    if (contents.startsWith("<!--", i)) {
      i = xmlCommentEnd(contents, i);
      continue;
    }
    if (contents.startsWith("<![CDATA[", i)) {
      const close = contents.indexOf("]]>", i + 9);
      i = close === -1 ? contents.length : close + 3;
      continue;
    }
    const key = matchAt(PLIST_KEY, contents, i);
    if (key === null) {
      i++;
      continue;
    }
    i += key[0].length;
    let gap = i;
    for (;;) {
      gap = skipSpaces(contents, gap);
      if (!contents.startsWith("<!--", gap)) break;
      gap = xmlCommentEnd(contents, gap);
    }
    const string = matchAt(PLIST_STRING, contents, gap);
    if (string !== null) {
      const textStart = gap + "<string>".length;
      replacements.push({
        start: textStart,
        end: textStart + string[1]!.length,
        value: NORMALIZED_VERSION_VALUE,
      });
      i = gap + string[0].length;
    }
  }
  return applyReplacements(contents, replacements);
}

const RULES: readonly Rule[] = [
  {
    matchesPath: (filePath) =>
      underNativeDirectory(filePath, "ios") && basenameOf(filePath) === "project.pbxproj",
    normalize: normalizePbxproj,
  },
  {
    matchesPath: (filePath) =>
      underNativeDirectory(filePath, "ios") && basenameOf(filePath).endsWith(".plist"),
    normalize: normalizeInfoPlist,
  },
  {
    matchesPath: (filePath) => underNativeDirectory(filePath, "ios") && basenameOf(filePath).endsWith(".xcconfig"),
    normalize: normalizeXcconfig,
  },
  {
    matchesPath: (filePath) =>
      underNativeDirectory(filePath, "android") && basenameOf(filePath) === "build.gradle",
    normalize: normalizeGradle,
  },
  {
    matchesPath: (filePath) =>
      underNativeDirectory(filePath, "android") && basenameOf(filePath) === "build.gradle.kts",
    normalize: normalizeGradle,
  },
];

function ruleFor(source: FileHookTransformSource): Rule | undefined {
  if (source.type !== "file") {
    return undefined;
  }
  return RULES.find((rule) => rule.matchesPath(source.filePath));
}

/**
 * A `fileHookTransform` that runs `projectHook` (the project's own hook from
 * fingerprint.config.js, if any) first and applies the version normalization
 * to its output. Files no rule matches pass through after the project hook,
 * chunk by chunk, untouched.
 */
export function createVersionNormalizingHook(
  projectHook?: FileHookTransformFunction,
): FileHookTransformFunction {
  // Keyed by the engine's per-stream source object: one shared hook serves
  // every file, and chunks of different files interleave. Matched file chunks
  // are held back (null) and the whole transformed file is returned at end of
  // file, Latin-1 so every byte outside the replaced values round-trips.
  const buffers = new WeakMap<FileHookTransformSource, Buffer[]>();

  return (source, chunk, isEndOfFile, encoding) => {
    const output = projectHook ? projectHook(source, chunk, isEndOfFile, encoding) : chunk;
    const rule = ruleFor(source);
    if (rule === undefined) {
      return output;
    }

    let parts = buffers.get(source);
    if (parts === undefined) {
      parts = [];
      buffers.set(source, parts);
    }
    if (output !== null && output !== undefined) {
      // A string from the project hook is pushed by the engine as UTF-8.
      parts.push(typeof output === "string" ? Buffer.from(output, "utf8") : output);
    }
    if (!isEndOfFile) {
      return null;
    }

    buffers.delete(source);
    const whole = Buffer.concat(parts);
    return Buffer.from(rule.normalize(whole.toString("latin1")), "latin1");
  };
}
