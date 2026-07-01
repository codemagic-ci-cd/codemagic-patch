import type { ReleasePatchCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { enforceMutationSafety } from "./mutationSafety";
import { assertExplicitBinaryVersion } from "../targetBinaryVersion";
import { resolveReleaseId } from "./resolveNames";
import { buildApiUrl, type CommandDeps, UsageError } from "./shared";

export async function executeReleasePatch(
  command: ReleasePatchCommand,
  deps: CommandDeps,
): Promise<unknown> {
  if (Object.keys(command.patch).length === 0) {
    throw new UsageError(
      "Specify at least one field to change: --release-notes, --rollout-percentage, --mandatory|--not-mandatory, --target-binary-version, or --status",
    );
  }

  if (command.patch.target_binary_version !== undefined) {
    assertExplicitBinaryVersion(command.patch.target_binary_version);
  }

  const releaseId = await resolveReleaseId(
    command.release,
    command.serverUrl,
    command.token,
    deps,
  );

  await enforceMutationSafety(deps, {
    commandName: command.commandLabel ?? "release patch",
    fields: [
      ["serverUrl", command.serverUrl],
      ["releaseId", releaseId],
      ["status", command.patch.status],
      ["rollout", formatNumber(command.patch.rollout_percentage)],
      ["mandatory", formatBoolean(command.patch.is_mandatory)],
      ["targetBinaryVersion", command.patch.target_binary_version],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify(command.patch),
      headers: {
        "content-type": "application/json",
      },
      method: "PATCH",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/releases/${encodeURIComponent(releaseId)}`,
    ),
  });
}

function formatBoolean(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function formatNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}
