/**
 * Who holds the ports the stack needs, named before `up.sh` refuses them.
 *
 * `up.sh` already fails on a taken port, but it can only say the number; on
 * a developer machine the holder is usually another dev server, and knowing
 * which one is the difference between a fix and a search.
 */

import type { Progress } from "../../progress";
import { UsageError, type CommandDeps } from "../shared";
import { captureLocal } from "./process";
import { composeArgs } from "./source";

/** The published ports of docker-compose.dev.yml, as up.sh lists them. */
export const EVAL_PORTS = [3000, 8080, 9100, 9101, 55433] as const;

export type PortHolder = {
  command: string;
  pid: string;
  port: number;
};

/**
 * Only for a fresh start: when the stack's own containers hold the ports,
 * `up` is an idempotent no-op and must not be blocked — the same rule up.sh
 * applies, decided by the same `compose ps -q`.
 */
export async function checkPorts(
  deps: CommandDeps,
  progress: Progress,
  checkoutPath: string,
): Promise<void> {
  const running = await captureLocal(deps, {
    args: [...composeArgs(checkoutPath, deps.env), "ps", "-q"],
    command: "docker",
  });
  if (running.exitCode === 0 && running.output.trim().length > 0) {
    return;
  }

  progress.write("checking that the stack's ports are free");
  const holders: PortHolder[] = [];
  for (const port of EVAL_PORTS) {
    const holder = await portHolder(deps, port);
    if (holder === null) {
      // No lsof here (or nothing listening): up.sh's own check still runs.
      continue;
    }
    holders.push(holder);
  }

  if (holders.length === 0) {
    return;
  }

  throw new UsageError(renderPortConflict(holders));
}

/**
 * Docker itself holding the ports means another Compose project publishes
 * them — an evaluation stack started before the project name was pinned
 * (it lived under its directory's name), or something else entirely. Naming
 * that saves the user from hunting for a process called "com.docker.backend".
 */
export function renderPortConflict(holders: readonly PortHolder[]): string {
  const dockerHeld = holders.every((holder) => isDockerProcess(holder.command));

  return [
    "The evaluation stack needs these ports, and something else is using them:",
    ...holders.map(
      (holder) =>
        `  ${String(holder.port)}  ${holder.command} (pid ${holder.pid})`,
    ),
    "",
    ...(dockerHeld
      ? [
          "That is Docker: another Compose project publishes these ports — most likely an evaluation stack started before its project name was pinned, from a clone.",
          "`docker ps` shows which project; stop it with `docker compose -p <project> down` and run this again.",
        ]
      : [
          "Stop those programs, or free the ports another way, and run this again.",
        ]),
  ].join("\n");
}

function isDockerProcess(command: string): boolean {
  // lsof truncates COMMAND to nine characters: "com.docke".
  return command.startsWith("com.docke") || command.startsWith("docker");
}

async function portHolder(
  deps: CommandDeps,
  port: number,
): Promise<PortHolder | null> {
  const listing = await captureLocal(deps, {
    args: ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN"],
    command: "lsof",
  });
  if (listing.spawnError !== null || listing.exitCode !== 0) {
    return null;
  }

  return parseLsofHolder(listing.output, port);
}

/** The first listener from `lsof -nP -iTCP:<port> -sTCP:LISTEN` output. */
export function parseLsofHolder(output: string, port: number): PortHolder | null {
  const rows = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("COMMAND"));
  const first = rows[0];
  if (first === undefined) {
    return null;
  }

  const [command, pid] = first.split(/\s+/u);
  if (command === undefined || pid === undefined) {
    return null;
  }

  return { command, pid, port };
}
