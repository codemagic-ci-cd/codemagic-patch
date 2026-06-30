import {
  getCommandHelpEntries,
  getCommandHelpGroups,
  type CommandHelpEntry,
} from "./commandSpecs";

export function renderHelp(topic?: string): string {
  if (topic !== undefined) {
    return renderHelpTopic(topic);
  }

  const groups = getCommandHelpGroups();

  return [
    "Minimal Codemagic Patch CLI",
    "",
    "Usage:",
    "  cmpatch <command> [flags]",
    "  cmpatch help <group|command>",
    "  cmpatch --version",
    "",
    "Groups:",
    ...groups.map((group) => `  ${group.name.padEnd(11)} ${group.summary}`),
    "",
    "Common setup:",
    "  cmpatch config set server-url https://updates.example.com",
    "  cmpatch login                                 # sign in (init and release need auth)",
    "  cmpatch init                                  # interactive wizard",
    "  cmpatch init --server-url https://updates.example.com --ios-app MyApp-iOS --android-app MyApp-Android --deployment Staging --yes",
    "",
    "Common release:",
    "  cmpatch release-react --deployment Staging --dry-run",
    "  cmpatch release-react --deployment Staging",
    "",
    "Automation:",
    "  Use --format json for machine-readable output or --format table for human output.",
    "  Piped stdout defaults to JSON where practical.",
    "",
    "Use `cmpatch help <group>` for grouped commands.",
  ].join("\n");
}

function renderHelpTopic(topic: string): string {
  const normalizedTopic = topic.trim();
  const groups = getCommandHelpGroups();
  const entries = getCommandHelpEntries();
  const group = groups.find((candidate) =>
    candidate.topics.includes(normalizedTopic),
  );

  if (group !== undefined) {
    return [
      `${group.name} commands`,
      "",
      group.summary,
      "",
      "Commands:",
      ...renderGroupedCommandSummaries(
        entries.filter((entry) => entry.group === group.name),
      ),
      "",
      "Examples:",
      ...group.examples.map((line) => `  ${line}`),
    ].join("\n");
  }

  const command = entries.find(
    (entry) =>
      entry.usage.startsWith(`cmpatch ${normalizedTopic} `) ||
      entry.usage === `cmpatch ${normalizedTopic}`,
  );

  if (command !== undefined) {
    const examples = command.examples ?? [];

    return [
      "Usage:",
      `  ${command.usage}`,
      ...(examples.length > 0
        ? ["", "Examples:", ...examples.map((line) => `  ${line}`)]
        : []),
    ].join("\n");
  }

  return [
    `Unknown help topic: ${topic}`,
    "",
    "Available topics:",
    ...groups.map((candidate) => `  ${candidate.name}`),
  ].join("\n");
}

function renderGroupedCommandSummaries(
  entries: readonly CommandHelpEntry[],
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const entry of entries) {
    if (seen.has(entry.commandName)) {
      continue;
    }

    seen.add(entry.commandName);
    lines.push(
      `  cmpatch ${entry.commandName.padEnd(22)} ${entry.description}`,
    );
  }

  return lines;
}
