import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Progress } from "../../progress";
import { UsageError, type CommandDeps } from "../shared";
import { captureLocal } from "./process";
import {
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  composeProject,
  projectStatePath,
  type Checkout,
} from "./source";

/** A daemon can list a deleted container that neither inspect nor rm can find.
 * Retrying Compose in that namespace keeps selecting the same unusable ID.
 */
export async function recoverMissingContainers(
  deps: CommandDeps,
  progress: Progress,
  checkout: Checkout,
): Promise<boolean> {
  const current = composeProject(deps.env);
  // Older CLI builds used the directory name. Only adopt that namespace when
  // every container identifies this exact evaluation compose file.
  const projects = [...new Set([current, "codemagic-patch"])];
  let recovered = false;
  for (const project of projects) {
    const listing = await captureLocal(deps, {
      command: "docker",
      args: [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        "{{json .}}",
      ],
    });
    if (listing.exitCode !== 0) {
      throw new UsageError(
        `Could not check the evaluation containers: ${listing.output}`,
      );
    }
    const rows = listing.output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { ID: string; Labels: string });
    if (rows.length === 0) continue;
    if (
      project !== current &&
      !rows.every((row) =>
        row.Labels.split(",").includes(
          `com.docker.compose.project.config_files=${join(checkout.path, COMPOSE_FILE)}`,
        ),
      )
    )
      continue;

    const existing: string[] = [];
    let missing = false;
    for (const row of rows) {
      if (!/^[a-f0-9]{64}$/u.test(row.ID))
        throw new UsageError("Docker returned an invalid container ID.");
      const inspection = await captureLocal(deps, {
        command: "docker",
        args: ["inspect", "--format", "{{.Id}}", row.ID],
      });
      if (inspection.exitCode === 0) existing.push(row.ID);
      else if (/no such (?:object|container)/iu.test(inspection.output))
        missing = true;
      else
        throw new UsageError(
          `Could not inspect the evaluation container: ${inspection.output}`,
        );
    }
    if (!missing || (project !== current && existing.length === 0)) continue;

    progress.warn(
      "Docker has stale evaluation container records; recreating the evaluation environment. Evaluation data may be reset.",
    );
    // Remove only the containers proven to exist in this evaluation namespace.
    // Do not prune Docker or try to repair its internal database.
    for (const id of existing) {
      const removal = await captureLocal(deps, {
        command: "docker",
        args: ["rm", "--force", id],
      });
      if (
        removal.exitCode !== 0 &&
        !/no such container/iu.test(removal.output)
      ) {
        throw new UsageError(
          `Could not clear the evaluation container: ${removal.output}`,
        );
      }
    }
    if (project === current) {
      const state = projectStatePath(deps.env);
      const suffix = randomBytes(6).toString("hex");
      await mkdir(dirname(state), { recursive: true });
      const temporary = `${state}.${suffix}.tmp`;
      await writeFile(temporary, `${COMPOSE_PROJECT}-${suffix}\n`, {
        mode: 0o600,
      });
      await rename(temporary, state);
    }
    recovered = true;
  }
  return recovered;
}
