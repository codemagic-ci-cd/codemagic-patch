// Command-palette data model and ranking. Pure by design — no React, no DOM,
// no router — so the rules that decide what a keystroke surfaces are testable
// without rendering anything.
//
// Ranking is term-based: EVERY whitespace-separated term must match, so
// "app cr" narrows instead of widening. Scores sum across terms and ties keep
// the declared catalog order (Array#sort is stable), which is what lets
// buildCommands express the default view as plain source order.

import type { ReactNode } from "react";

export type CommandGroup =
  | "Actions"
  | "Navigate"
  | "Apps"
  | "Releases"
  | "Metrics - Rolled up"
  | "Metrics - Per Deployment"
  | "Teams"
  | "Account";

// Navigate sits directly under Actions because it is the one fixed-length
// section: it stays where the reader last saw it while the data-driven
// sections below grow and shrink with the team.
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  "Actions",
  "Navigate",
  "Apps",
  "Releases",
  "Metrics - Rolled up",
  "Metrics - Per Deployment",
  "Teams",
  "Account",
];

export interface Command {
  /** Also the option's DOM id, so it must be stable across renders. */
  id: string;
  label: string;
  group: CommandGroup;
  subtitle?: string;
  /** Matched but never rendered — synonyms for what the label already says. */
  keywords?: readonly string[];
  /**
   * Rows the default-view cap must keep or drop together: every deployment row
   * of one app carries that app's id, so a capped section never shows some of
   * an app's deployments and not the rest. Unset means the row is its own unit.
   */
  cluster?: string;
  icon?: ReactNode;
  /** Invoked after the palette has closed. */
  run: () => void;
}

export interface CommandSection {
  group: CommandGroup;
  commands: readonly Command[];
}

export const MAX_RESULTS = 50;

/**
 * Caps for the empty-query view only, so a large team cannot push the fixed
 * sections off screen; typing reaches everything. The unit is a CLUSTER, not a
 * row: flat sections cap at rows, while the per-deployment sections cap at
 * apps. Counting rows there truncated mid-app, which reads as "this app has no
 * deployments" rather than "the list is capped".
 */
export const DEFAULT_SECTION_LIMITS: Partial<Record<CommandGroup, number>> = {
  Apps: 6,
  Releases: 4,
  "Metrics - Rolled up": 6,
  "Metrics - Per Deployment": 4,
  Teams: 4,
};

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function words(value: string): string[] {
  return value.split(WORD_SPLIT).filter((word) => word.length > 0);
}

/** Ordered-letters match: "crap" finds "Create app". */
function isSubsequence(haystack: string, needle: string): boolean {
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) {
      cursor += 1;
      if (cursor === needle.length) {
        return true;
      }
    }
  }
  return needle.length === 0;
}

function auxiliaryText(command: Command): string {
  return [command.subtitle ?? "", command.group, ...(command.keywords ?? [])]
    .join(" ")
    .toLowerCase();
}

// Tiers, strongest first. The gaps are wide enough that a stronger match on one
// term outranks weaker matches on two, which is what keeps a typed app name
// above the page whose keywords merely mention apps.
function scoreTerm(command: Command, term: string): number | null {
  const label = command.label.toLowerCase();
  if (label === term) {
    return 140;
  }
  if (label.startsWith(term)) {
    return 120;
  }
  if (words(label).some((word) => word.startsWith(term))) {
    return 95;
  }
  if (label.includes(term)) {
    return 70;
  }
  if (auxiliaryText(command).includes(term)) {
    return 45;
  }
  if (isSubsequence(label, term)) {
    return 20;
  }
  return null;
}

/** Total score, or null when any term fails to match. */
export function scoreCommand(command: Command, query: string): number | null {
  const normalized = normalizeQuery(query);
  if (normalized === "") {
    return 0;
  }
  let total = 0;
  for (const term of normalized.split(" ")) {
    const score = scoreTerm(command, term);
    if (score === null) {
      return null;
    }
    total += score;
  }
  return total;
}

export function filterCommands(
  commands: readonly Command[],
  query: string,
): readonly Command[] {
  if (normalizeQuery(query) === "") {
    return commands;
  }
  return commands
    .map((command, index) => ({
      command,
      score: scoreCommand(command, query),
      index,
    }))
    .filter(
      (entry): entry is { command: Command; score: number; index: number } =>
        entry.score !== null,
    )
    .sort((left, right) =>
      right.score === left.score
        ? left.index - right.index
        : right.score - left.score,
    )
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.command);
}

/**
 * Groups matches into rendered sections. An empty query renders the declared
 * group order under the caps; a query orders groups by their best match, so the
 * most relevant heading leads.
 */
export function sectionsFor(
  commands: readonly Command[],
  query: string,
  limits: Partial<Record<CommandGroup, number>> = DEFAULT_SECTION_LIMITS,
): readonly CommandSection[] {
  const matches = filterCommands(commands, query);
  const isDefaultView = normalizeQuery(query) === "";

  const buckets = new Map<CommandGroup, Command[]>();
  const matchOrder: CommandGroup[] = [];
  for (const command of matches) {
    const bucket = buckets.get(command.group);
    if (bucket === undefined) {
      buckets.set(command.group, [command]);
      matchOrder.push(command.group);
    } else {
      bucket.push(command);
    }
  }

  const groupOrder = isDefaultView
    ? COMMAND_GROUP_ORDER.filter((group) => buckets.has(group))
    : matchOrder;

  return groupOrder.map((group) => {
    const bucket = buckets.get(group) ?? [];
    const limit = isDefaultView ? limits[group] : undefined;
    return {
      group,
      commands: limit === undefined ? bucket : capByCluster(bucket, limit),
    };
  });
}

function capByCluster(
  commands: readonly Command[],
  limit: number,
): readonly Command[] {
  const kept: Command[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const key = command.cluster ?? command.id;
    if (seen.has(key)) {
      kept.push(command);
      continue;
    }
    if (seen.size >= limit) {
      continue;
    }
    seen.add(key);
    kept.push(command);
  }
  return kept;
}

/** Rendered order — the array the arrow keys walk. */
export function flattenSections(
  sections: readonly CommandSection[],
): readonly Command[] {
  return sections.flatMap((section) => section.commands);
}

/** The fields the shortcut test needs; a real KeyboardEvent satisfies it. */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * ⌘K and Ctrl+K are both accepted on every platform (a Mac with an external PC
 * keyboard gets both). `code` covers layouts where `key` is not a plain "k";
 * Shift is excluded so Cmd/Ctrl+Shift+K still reaches the browser dev tools.
 */
export function isPaletteShortcut(event: ShortcutKeyEvent): boolean {
  if (event.altKey || event.shiftKey) {
    return false;
  }
  if (!event.metaKey && !event.ctrlKey) {
    return false;
  }
  return event.key.toLowerCase() === "k" || event.code === "KeyK";
}

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(`${platform} ${navigator.userAgent}`);
}

/** Display form only; both chords work whatever this returns. */
export function paletteShortcutLabel(): string {
  return isApplePlatform() ? "⌘K" : "Ctrl K";
}
