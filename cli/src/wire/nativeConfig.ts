// The destination configuration group — deployment key, API URL, download
// base URL — as it lives in Info.plist and strings.xml: read for comparison,
// written as targeted text edits so an unchanged file stays byte-identical.

import { readdir } from "node:fs/promises";
import path from "node:path";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parsePlist } from "plist";

import { FIELDS as DESTINATION_KEYS, readDoctorSource } from "../doctor/discovery";
import { discoverIosTargets } from "../doctor/iosTargets";
import { isRecord } from "../output";
import { isDirectory, readTextFile } from "./fs";

export type DestinationField = "apiUrl" | "deploymentKey" | "downloadBaseUrl";
export type DestinationValues = Record<DestinationField, string>;
export type PartialDestination = Partial<DestinationValues>;

export { DESTINATION_KEYS };
export const DESTINATION_FIELDS = Object.keys(
  DESTINATION_KEYS,
) as DestinationField[];

export type DestinationComparison =
  /** Every value present and equal to the selected destination. */
  | { kind: "complete" }
  /** Nothing contradicts the selected destination; these fields are absent. */
  | { kind: "fill"; missing: DestinationField[] }
  /** At least one present value names another destination. */
  | { kind: "conflict"; current: PartialDestination; differing: DestinationField[] }
  /** A build-time placeholder (`$(VAR)`, `@string/x`) that cannot be compared. */
  | { kind: "unresolved"; field: DestinationField; value: string };

export function compareDestination(
  current: PartialDestination,
  selected: DestinationValues,
): DestinationComparison {
  for (const field of DESTINATION_FIELDS) {
    const value = current[field];
    if (value !== undefined && /^\s*(\$\(|\$\{|@)/.test(value)) {
      return { kind: "unresolved", field, value };
    }
  }
  const differing = DESTINATION_FIELDS.filter(
    (field) =>
      current[field] !== undefined && current[field] !== selected[field],
  );
  if (differing.length > 0) {
    return { kind: "conflict", current, differing };
  }
  const missing = DESTINATION_FIELDS.filter(
    (field) => current[field] === undefined,
  );
  return missing.length === 0 ? { kind: "complete" } : { kind: "fill", missing };
}

// --- Info.plist -----------------------------------------------------------

export function readPlistDestination(text: string): PartialDestination | null {
  const parsed = parsePlistDocument(text);
  return parsed === null
    ? null
    : pickDestination((field) => parsed[DESTINATION_KEYS[field]]);
}

/**
 * Replaces or inserts the given keys in the top-level dict. Existing keys are
 * edited in place; new ones go before the closing `</dict>` with the file's
 * own indentation. Throws when a key is present but not a plain string, or
 * appears more than once — those are for the developer to sort out.
 */
export function writePlistDestination(
  text: string,
  values: PartialDestination,
): string {
  const parsed = parsePlistDocument(text);
  if (parsed === null || !text.includes("</dict>")) {
    throw new Error("not a property list with a top-level dict");
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const keyIndent = /\n([ \t]*)<key>/.exec(text)?.[1] ?? "\t";
  const insertions: string[] = [];
  let next = text;
  for (const field of DESTINATION_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    const key = DESTINATION_KEYS[field];
    const keyMatch = findOnce(next, new RegExp(`<key>${key}</key>`, "g"), key);
    if (keyMatch === null) {
      insertions.push(
        `${keyIndent}<key>${key}</key>${eol}${keyIndent}<string>${escapeXml(value)}</string>${eol}`,
      );
      continue;
    }
    const valueStart = keyMatch.index + keyMatch[0].length;
    const valueMatch = /^\s*(<string>[^<]*<\/string>|<string\s*\/>)/.exec(
      maskXmlNonMarkup(next).slice(valueStart),
    );
    if (typeof parsed[key] !== "string" || valueMatch === null) {
      throw new Error(`${key} is not a top-level string value`);
    }
    const elementStart = valueStart + valueMatch[0].length - valueMatch[1].length;
    next = `${next.slice(0, elementStart)}<string>${escapeXml(value)}</string>${next.slice(valueStart + valueMatch[0].length)}`;
  }
  return insertBeforeClosingTag(next, "</dict>", insertions, eol);
}

function parsePlistDocument(text: string): Record<string, unknown> | null {
  if (XMLValidator.validate(text) !== true || !/<plist[\s>]/.test(text)) {
    return null;
  }
  try {
    const parsed: unknown = parsePlist(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The single match of `pattern` outside XML comments, or null when there is
 * none. A pasted-and-commented-out example must neither count as configured
 * nor be edited in place, and a key that appears twice is not ours to pick.
 */
function findOnce(
  text: string,
  pattern: RegExp,
  key: string,
): RegExpExecArray | null {
  const matches = [...maskXmlNonMarkup(text).matchAll(pattern)];
  if (matches.length > 1) {
    throw new Error(`${key} appears more than once`);
  }
  return matches[0] ?? null;
}

/** Comments and CDATA are not XML markup; preserve offsets when masking them. */
function maskXmlNonMarkup(text: string): string {
  return text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (comment) => " ".repeat(comment.length));
}

function splice(text: string, match: RegExpExecArray, replacement: string): string {
  return `${text.slice(0, match.index)}${replacement}${text.slice(match.index + match[0].length)}`;
}

/**
 * Inserts whole lines above the closing tag's own line, so the tag keeps
 * its indentation and the file its line endings.
 */
function insertBeforeClosingTag(
  text: string,
  tag: string,
  lines: string[],
  eol: string,
): string {
  if (lines.length === 0) return text;
  const closing = maskXmlNonMarkup(text).lastIndexOf(tag);
  if (closing < 0) throw new Error(`missing ${tag}`);
  const lineStart = text.lastIndexOf("\n", closing) + 1;
  const sameLine = text.slice(lineStart, closing).trim().length > 0;
  return sameLine
    ? `${text.slice(0, closing)}${eol}${lines.join("")}${text.slice(closing)}`
    : `${text.slice(0, lineStart)}${lines.join("")}${text.slice(lineStart)}`;
}

export type IosAppTarget =
  | { kind: "resolved"; name: string; plist: string; sources: string[]; sourcesUnresolved: boolean }
  | { kind: "unresolved"; reason: string };

/**
 * The one application target of the Xcode project, by target membership.
 * Test bundles and extensions are not candidates; two application targets
 * are, and that is for the developer to choose between. So is a target whose
 * Info.plist could not be resolved for every build configuration: editing
 * the one plist that did resolve would leave the other configurations
 * without the destination while the step reports done.
 */
export async function locateIosAppTarget(iosRoot: string): Promise<IosAppTarget> {
  const targets = await discoverIosTargets(iosRoot, readDoctorSource);
  if (!targets.present) {
    return { kind: "unresolved", reason: `No .xcodeproj found in ${iosRoot}` };
  }
  if (targets.targets.length > 1) {
    return {
      kind: "unresolved",
      reason: `Several application targets: ${targets.targets.map((target) => target.name).join(", ")}`,
    };
  }
  const candidates: Array<{
    name: string;
    plist: string;
    sources: string[];
    sourcesUnresolved: boolean;
    settingsUnresolved: boolean;
  }> = [];
  for (const target of targets.targets) {
    if (target.plist === undefined) continue;
    const text = await readTextFile(target.plist);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = parsePlist(text);
    } catch {
      continue;
    }
    if (
      !isRecord(parsed) ||
      parsed.CFBundlePackageType === "BNDL" ||
      parsed.NSExtension !== undefined
    ) {
      continue;
    }
    candidates.push({
      name: target.name,
      plist: target.plist,
      sources: target.sources,
      sourcesUnresolved: target.sourcesUnresolved,
      settingsUnresolved: target.settingsUnresolved,
    });
  }
  if (candidates.length === 1 && !targets.limited) {
    const { settingsUnresolved, ...candidate } = candidates[0]!;
    if (settingsUnresolved) {
      return {
        kind: "unresolved",
        reason: `Info.plist could not be resolved for every build configuration of ${candidate.name}; set the destination in each configuration's Info.plist yourself`,
      };
    }
    return { kind: "resolved", ...candidate };
  }
  return {
    kind: "unresolved",
    reason: targets.limited
      ? "The Xcode project could not be read completely"
      : candidates.length === 0
        ? "No application target with a resolvable Info.plist was found"
        : `Several application targets: ${candidates.map((c) => c.name).join(", ")}`,
  };
}

// --- strings.xml -----------------------------------------------------------

export function readStringsDestination(text: string): PartialDestination | null {
  const strings = parseStrings(text);
  return typeof strings === "string" ? null : pickDestination((field) => strings.get(DESTINATION_KEYS[field]));
}

/** Why `readStringsDestination` returned null, for the plan's manual step. */
export function stringsDestinationProblem(text: string): string | null {
  const strings = parseStrings(text);
  return typeof strings === "string" ? strings : null;
}

/** The `<string>` resources by name, or the problem that makes the file unusable. */
function parseStrings(text: string): Map<string, string> | string {
  if (XMLValidator.validate(text) !== true) return "could not be parsed";
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  }).parse(text);
  if (!isRecord(parsed) || (!isRecord(parsed.resources) && parsed.resources !== "")) {
    return "is not a <resources> document";
  }
  const resources = isRecord(parsed.resources) ? parsed.resources : {};
  const nodes = [resources.string].flat().filter(isRecord);
  const strings = new Map<string, string>();
  for (const node of nodes) {
    const name = node["@_name"];
    const value = node["#text"];
    if (typeof name !== "string") continue;
    if (strings.has(name) && Object.values(DESTINATION_KEYS).some((key) => key === name)) {
      return `defines the string ${name} more than once`;
    }
    strings.set(name, typeof value === "string" ? unescapeAndroid(value) : "");
  }
  return strings;
}

/**
 * Same contract as the plist writer. `null` stands for a strings.xml that
 * does not exist yet; the result is then a new document.
 */
export function writeStringsDestination(
  text: string | null,
  values: PartialDestination,
): string {
  const eol = text?.includes("\r\n") ? "\r\n" : "\n";
  let next = text ?? "<resources/>\n";
  const emptyResources = /<resources\b([^>]*?)\s*\/>/.exec(maskXmlNonMarkup(next));
  if (emptyResources !== null) {
    next = splice(next, emptyResources, `<resources${emptyResources[1]}>${eol}</resources>`);
  }
  if (readStringsDestination(next) === null || !next.includes("</resources>")) {
    throw new Error("not a resources document");
  }
  const indent = /\n([ \t]*)<string\b/.exec(next)?.[1] ?? "    ";
  const insertions: string[] = [];
  for (const field of DESTINATION_FIELDS) {
    const value = values[field];
    if (value === undefined) continue;
    const key = DESTINATION_KEYS[field];
    const match = findOnce(
      next,
      new RegExp(
        `(<string\\b[^>]*?name=(["'])${key}\\2[^>]*?)(?:\\s*/>|>[^<]*</string>)`,
        "g",
      ),
      key,
    );
    const existing = findOnce(next, new RegExp(`<string\\b[^>]*?\\sname\\s*=\\s*(["'])${key}\\1(?:\\s|/?>)`, "g"), key);
    if (match === null && existing !== null) throw new Error(`${key} is not a plain string value`);
    if (match === null) {
      insertions.push(
        `${indent}<string name="${key}" translatable="false">${escapeAndroid(value)}</string>${eol}`,
      );
      continue;
    }
    if (next.slice(match.index, match.index + match[0].length).includes("<![CDATA[")) {
      throw new Error(`${key} is not a plain string value`);
    }
    next = splice(next, match, `${match[1]}>${escapeAndroid(value)}</string>`);
  }
  return insertBeforeClosingTag(next, "</resources>", insertions, eol);
}

export const ANDROID_STRINGS_FILE = path.join(
  "android",
  "app",
  "src",
  "main",
  "res",
  "values",
  "strings.xml",
);

/**
 * Where else the destination resources could come from. Any hit means the
 * effective value is not the one line in main/values/strings.xml, so the
 * step is the developer's: a flavor or qualified resource overrides it and a
 * Gradle `resValue` generates it.
 */
export async function findAndroidResourceOverrides(root: string): Promise<string[]> {
  const sources: string[] = [];
  const keys = Object.values(DESTINATION_KEYS);
  const mentions = new RegExp(keys.join("|"));
  const srcRoot = path.join(root, "android", "app", "src");
  const mainStrings = path.join(root, ANDROID_STRINGS_FILE);
  if (await isDirectory(srcRoot)) {
    for (const sourceSet of await listDirectories(srcRoot)) {
      const res = path.join(srcRoot, sourceSet, "res");
      if (!(await isDirectory(res))) continue;
      for (const valuesDir of await listDirectories(res)) {
        if (!/^values(-|$)/.test(valuesDir)) continue;
        const dir = path.join(res, valuesDir);
        for (const entry of await readdir(dir).catch(() => [] as string[])) {
          const file = path.join(dir, entry);
          if (!entry.endsWith(".xml") || file === mainStrings) continue;
          const text = await readTextFile(file);
          if (text !== null && mentions.test(text)) sources.push(file);
        }
      }
    }
  }
  // A parenthesised call (Kotlin DSL, or Groovy with parens) may spread its
  // arguments over several lines, so look up to the closing `)`; a bare
  // Groovy statement ends with the line unless a trailing comma continues
  // it. Neither form reads past its own statement, so a later mention of
  // the key elsewhere does not count.
  const resValue = new RegExp(
    `resValue\\s*(?:\\([^)]*|(?:[^\\n(,]*,\\s*)*[^\\n(]*)["'](${keys.join("|")})["']`,
  );
  for (const gradle of ["build.gradle", "build.gradle.kts"]) {
    const file = path.join(root, "android", "app", gradle);
    const text = await readTextFile(file);
    if (text !== null && resValue.test(text)) sources.push(file);
  }
  return sources;
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function pickDestination(
  read: (field: DestinationField) => unknown,
): PartialDestination {
  const result: PartialDestination = {};
  for (const field of DESTINATION_FIELDS) {
    const value = read(field);
    if (typeof value === "string" && value.trim().length > 0) {
      result[field] = value.trim();
    }
  }
  return result;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAndroid(value: string): string {
  return escapeXml(value)
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/^([@?])/, "\\$1");
}

function unescapeAndroid(value: string): string {
  return value.replace(/^"(.*)"$/s, "$1").replace(/\\(['"@?])/g, "$1");
}
