import type { ReleasePromoteCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { enforceMutationSafety } from "./mutationSafety";
import { assertExplicitBinaryVersion } from "../targetBinaryVersion";
import { resolveDeploymentId, resolveReleaseId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeReleasePromote(
  command: ReleasePromoteCommand,
  deps: CommandDeps,
): Promise<unknown> {
  if (command.targetBinaryVersion !== undefined) {
    assertExplicitBinaryVersion(command.targetBinaryVersion);
  }

  const sourceReleaseId = await resolveReleaseId(
    command.sourceRelease,
    command.serverUrl,
    command.token,
    deps,
  );
  const destinationDeploymentId = await resolveDeploymentId(
    command.destinationDeployment,
    command.serverUrl,
    command.token,
    deps,
  );
  const body: Record<string, boolean | number | string> = {
    destination_deployment_id: destinationDeploymentId,
    disabled: command.disabled,
  };

  if (command.isMandatory !== undefined) {
    body.is_mandatory = command.isMandatory;
  }

  body.no_duplicate_release_error = command.noDuplicateReleaseError;

  if (command.releaseNotes !== undefined) {
    body.release_notes = command.releaseNotes;
  }

  body.rollout_percentage = command.rolloutPercentage;

  if (command.targetBinaryVersion !== undefined) {
    body.target_binary_version = command.targetBinaryVersion;
  }

  await enforceMutationSafety(deps, {
    commandName: "release promote",
    fields: [
      ["serverUrl", command.serverUrl],
      ["sourceReleaseId", sourceReleaseId],
      ["destinationDeploymentId", destinationDeploymentId],
      ["targetBinaryVersion", command.targetBinaryVersion],
      ["rollout", String(command.rolloutPercentage)],
      ["mandatory", command.isMandatory === undefined ? undefined : String(command.isMandatory)],
      ["disabled", String(command.disabled)],
    ],
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  });

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "idempotency-key": deps.randomUUID(),
      },
      method: "POST",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/releases/${encodeURIComponent(sourceReleaseId)}/promote`,
    ),
  });
}
