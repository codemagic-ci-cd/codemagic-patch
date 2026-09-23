// The Patch config plugin entry in a static Expo config: what a project
// with generated native code (CNG) carries instead of Info.plist and
// strings.xml values. The entry holds one destination block per platform.

import { isRecord } from "../output";
import type { NativePlatform } from "../projectAnalysis";
import { SDK_PACKAGE } from "./project";
import {
  DESTINATION_FIELDS,
  type DestinationValues,
  type PartialDestination,
} from "./nativeConfig";

export type ExpoPluginBlocks = Partial<Record<NativePlatform, PartialDestination>>;
export type ExpoPluginUpdates = Partial<Record<NativePlatform, DestinationValues>>;

export type ExpoPluginEntry =
  | { kind: "absent" }
  | { kind: "present"; blocks: ExpoPluginBlocks }
  /** Listed more than once: which entry wins is Expo's business, not ours to edit. */
  | { kind: "duplicate" };

export function readExpoPluginEntry(data: Record<string, unknown>): ExpoPluginEntry {
  const entries = pluginEntries(expoSection(data));
  if (entries.length > 1) return { kind: "duplicate" };
  const entry = entries[0];
  if (entry === undefined) return { kind: "absent" };
  const props = Array.isArray(entry) && isRecord(entry[1]) ? entry[1] : {};
  const blocks: ExpoPluginBlocks = {};
  for (const platform of ["ios", "android"] as const) {
    const block = props[platform];
    if (!isRecord(block)) continue;
    const values: PartialDestination = {};
    for (const field of DESTINATION_FIELDS) {
      const value = block[field];
      if (typeof value === "string" && value.trim().length > 0) {
        values[field] = value.trim();
      }
    }
    blocks[platform] = values;
  }
  return { kind: "present", blocks };
}

/**
 * The document with the plugin entry added or its platform blocks updated,
 * serialised with the file's own indentation. Keys outside the destination
 * group (`publicKey`) and other plugins are left as they were.
 */
export function writeExpoPluginEntry(text: string, updates: ExpoPluginUpdates): string {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error("not a JSON object");
  const section = expoSection(data);
  const plugins = Array.isArray(section.plugins) ? section.plugins : [];
  const indexes = plugins.flatMap((plugin, index) => (isPatchPlugin(plugin) ? [index] : []));
  if (indexes.length > 1) throw new Error("the Patch plugin is listed more than once");
  const existing = indexes[0] === undefined ? undefined : plugins[indexes[0]];
  const props: Record<string, unknown> =
    Array.isArray(existing) && isRecord(existing[1]) ? { ...existing[1] } : {};
  for (const platform of ["ios", "android"] as const) {
    const values = updates[platform];
    if (values === undefined) continue;
    props[platform] = {
      ...(isRecord(props[platform]) ? props[platform] : {}),
      ...values,
    };
  }
  const entry = [SDK_PACKAGE, props];
  const nextPlugins =
    indexes[0] === undefined
      ? [...plugins, entry]
      : plugins.map((plugin, index) => (index === indexes[0] ? entry : plugin));
  const next = isRecord(data.expo)
    ? { ...data, expo: { ...data.expo, plugins: nextPlugins } }
    : { ...data, plugins: nextPlugins };
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const serialized = JSON.stringify(next, null, indent).replace(/\n/g, eol);
  return text.endsWith("\n") ? `${serialized}${eol}` : serialized;
}

/** The entry to paste into a dynamic config, for the manual path. */
export function renderExpoPluginSnippet(blocks: ExpoPluginUpdates): string[] {
  return JSON.stringify([SDK_PACKAGE, blocks], null, 2).split("\n");
}

/** The `expo` section, or the document itself when there is none. */
function expoSection(data: Record<string, unknown>): Record<string, unknown> {
  return isRecord(data.expo) ? data.expo : data;
}

function pluginEntries(section: Record<string, unknown>): unknown[] {
  return Array.isArray(section.plugins) ? section.plugins.filter(isPatchPlugin) : [];
}

function isPatchPlugin(entry: unknown): boolean {
  return entry === SDK_PACKAGE || (Array.isArray(entry) && entry[0] === SDK_PACKAGE);
}
