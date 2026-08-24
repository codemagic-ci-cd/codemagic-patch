import { PRODUCT_NAME, SOURCE_REPO_URL } from "./branding";
import {
  getCommandHelpEntries,
  getCommandHelpGroups,
  type CommandFlagSection,
  type CommandHelpEntry,
} from "./commandSpecs";
import { PLAIN_PALETTE, type Palette } from "./output";

/** Help never exceeds this width so it survives an 80-column terminal. */
const MAX_WIDTH = 80;

/**
 * Flags wider than this get their summary on the next line instead of pushing
 * the whole section's summary column past readability.
 */
const MAX_FLAG_COLUMN = 36;

type TopLevelRow = readonly [command: string, summary: string];

/**
 * The top-level help is a curated roster in workflow order, not a dump of the
 * command registry: getting set up, shipping a release, then administration.
 * Every row must be a valid `cmpatch help` topic — a test walks this list.
 */
const TOP_LEVEL_SECTIONS: readonly {
  rows: readonly TopLevelRow[];
  title: string;
}[] = [
  {
    rows: [
      ["init", `Set up ${PRODUCT_NAME} for this project`],
      ["login", "Sign in to the update server"],
      ["doctor", "Diagnose local setup and OTA readiness"],
    ],
    title: "Getting started",
  },
  {
    rows: [
      ["release-react", "Build a React Native bundle and publish it"],
      ["bundle", "Build a .cmpatch artifact without uploading"],
      ["release", "Inspect, patch, promote, and roll back releases"],
    ],
    title: "Release",
  },
  {
    rows: [
      ["app", "Manage apps"],
      ["deployment", "Manage deployments and their history"],
      ["member", "Manage team members and invitations"],
      ["token", "Manage personal access tokens"],
    ],
    title: "Manage",
  },
  {
    rows: [
      ["config", "Store user-level defaults"],
      ["context", "Show the effective local context"],
      ["fingerprint", "Compute a native fingerprint"],
      ["debug", "Stream device update logs"],
      ["whoami", "Show the authenticated user"],
      ["logout", "Remove stored credentials"],
    ],
    title: "More",
  },
];

const TOP_LEVEL_EXAMPLES: readonly string[] = [
  "cmpatch init",
  "cmpatch release-react --deployment Staging --dry-run",
  "cmpatch doctor",
];

export function getTopLevelHelpTopics(): string[] {
  return TOP_LEVEL_SECTIONS.flatMap((section) =>
    section.rows.map(([command]) => command),
  );
}

export function renderHelp(
  topic?: string,
  palette: Palette = PLAIN_PALETTE,
): string {
  if (topic !== undefined) {
    return renderHelpTopic(topic, palette);
  }

  const lines: string[] = [
    `Ship over-the-air updates to React Native apps with ${PRODUCT_NAME}.`,
    "",
    palette.heading("Usage:"),
    "  cmpatch <command> [flags]",
    "  cmpatch help <group|command>",
  ];

  const commandColumn = topLevelCommandColumn();

  for (const section of TOP_LEVEL_SECTIONS) {
    lines.push("", palette.heading(`${section.title}:`));
    for (const [command, summary] of section.rows) {
      lines.push(`  ${command.padEnd(commandColumn)}  ${summary}`);
    }
  }

  lines.push(
    "",
    palette.heading("Examples:"),
    ...TOP_LEVEL_EXAMPLES.map((example) => `  $ ${example}`),
    "",
    palette.heading("Learn more:"),
    "  Use `cmpatch help <command>` for details on a command.",
    "  Use `--format json` for machine-readable output in scripts.",
    `  Read the docs at ${SOURCE_REPO_URL}`,
  );

  return lines.join("\n");
}

function topLevelCommandColumn(): number {
  return Math.max(
    ...TOP_LEVEL_SECTIONS.flatMap((section) =>
      section.rows.map(([command]) => command.length),
    ),
  );
}

function renderHelpTopic(topic: string, palette: Palette): string {
  const normalizedTopic = topic.trim();
  const groups = getCommandHelpGroups();
  const entries = getCommandHelpEntries();
  const group = groups.find((candidate) =>
    candidate.topics.includes(normalizedTopic),
  );

  // A topic that is both a group and a command (e.g. `fingerprint`) reads as
  // the command: its page links less but answers the flag questions that
  // brought the user here.
  const command = entries.find(
    (entry) => entry.commandName === normalizedTopic,
  );

  if (command !== undefined) {
    return renderCommandHelp(command, palette);
  }

  if (group !== undefined) {
    const groupEntries = entries.filter(
      (entry) => entry.group === group.name,
    );

    return [
      `${group.name} commands`,
      "",
      group.summary,
      "",
      palette.heading("Commands:"),
      ...renderGroupedCommandSummaries(groupEntries),
      "",
      palette.heading("Examples:"),
      ...group.examples.map((line) => `  $ ${line}`),
    ].join("\n");
  }

  return [
    `Unknown help topic: ${topic}`,
    "",
    "Available topics:",
    ...groups.map((candidate) => `  ${candidate.name}`),
  ].join("\n");
}

function renderCommandHelp(
  command: CommandHelpEntry,
  palette: Palette,
): string {
  const lines: string[] = [
    ...wrapText(command.description, MAX_WIDTH),
    "",
    palette.heading("Usage:"),
    `  ${command.usage}`,
  ];

  for (const section of command.flags ?? []) {
    lines.push(
      "",
      palette.heading(`${section.title ?? "Flags"}:`),
      ...renderFlagSection(section),
    );
  }

  const examples = command.examples ?? [];

  if (examples.length > 0) {
    lines.push(
      "",
      palette.heading("Examples:"),
      ...examples.map((line) => `  $ ${line}`),
    );
  }

  return lines.join("\n");
}

function renderFlagSection(section: CommandFlagSection): string[] {
  const column = Math.min(
    Math.max(...section.flags.map((entry) => entry.flag.length)),
    MAX_FLAG_COLUMN,
  );
  const summaryIndent = " ".repeat(column + 4);
  const summaryWidth = Math.max(MAX_WIDTH - summaryIndent.length, 20);
  const lines: string[] = [];

  for (const entry of section.flags) {
    const [first = "", ...rest] = wrapText(entry.summary, summaryWidth);

    if (entry.flag.length > column) {
      // Too wide for the column: the flag gets its own line and the summary
      // starts underneath, still aligned with the other summaries.
      lines.push(`  ${entry.flag}`, `${summaryIndent}${first}`);
    } else {
      lines.push(`  ${entry.flag.padEnd(column)}  ${first}`);
    }

    lines.push(...rest.map((line) => `${summaryIndent}${line}`));
  }

  return lines;
}

function renderGroupedCommandSummaries(
  entries: readonly CommandHelpEntry[],
): string[] {
  const seen = new Set<string>();
  const deduped: CommandHelpEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.commandName)) {
      continue;
    }

    seen.add(entry.commandName);
    deduped.push(entry);
  }

  const column = Math.max(
    ...deduped.map((entry) => entry.commandName.length),
  );
  // "  cmpatch " + the padded name.
  const summaryIndent = " ".repeat(column + 12);
  const summaryWidth = Math.max(MAX_WIDTH - summaryIndent.length, 20);

  return deduped.flatMap((entry) => {
    // The listing is a scannable index; the command's own page carries the
    // full description, so a single sentence is enough here.
    const [first = "", ...rest] = wrapText(
      firstSentence(entry.description),
      summaryWidth,
    );

    return [
      `  cmpatch ${entry.commandName.padEnd(column)}  ${first}`,
      ...rest.map((line) => `${summaryIndent}${line}`),
    ];
  });
}

function firstSentence(text: string): string {
  const match = /^.*?\.(?=\s|$)/.exec(text);
  return match === null ? text : match[0];
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}
