/**
 * A first install's database: on the server, or a Postgres the operator
 * already runs. The mode is fixed when install.sh writes the env file, so
 * repair never reaches this.
 */

import { randomBytes } from "node:crypto";

import {
  describeDockerProblem,
  parseDatabaseInput,
  redactDatabaseSecret,
  summarizeDatabaseProbe,
  type DatabaseTarget,
} from "../../databaseUrl";
import {
  captureRemoteShell,
  pairedSshInvocation,
  quoteShellValue,
} from "../../remoteExec";
import {
  renderDatabaseAllow,
  renderDatabaseChoice,
  renderDatabaseConnection,
} from "../../selfhostSetupCopy";
import { readStringFlag, type ParsedArgs, type SelfhostSession } from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
import { askChecked, askSelect, holdUntilConfirmed, notice } from "./ask";
import { resolvePublicAddress } from "./dns";

/** The client image the bundled database overlay already pins. */
const POSTGRES_CLIENT_IMAGE =
  "postgres:16.13-alpine@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416";

const PROBE_TABLE_NAME = /^cmpatch_install_probe_[0-9a-f]{16}$/u;

const CANNOT_CREATE_TABLES = "That user cannot create tables in this database.";

/**
 * Seconds psql waits for the TCP connection. Without it a host whose
 * allow-list has not caught up yet drops the SYN and the probe sits at the
 * OS timeout, a couple of minutes, right after the user said "allowed".
 */
const PROBE_CONNECT_TIMEOUT_SECONDS = "10";

/**
 * Migrations create an ordinary table in the session search path and do not
 * create a schema. This probe does that create and rolls it back.
 */
export function databaseProbeTableName(): string {
  return `cmpatch_install_probe_${randomBytes(8).toString("hex")}`;
}

export function databaseCreateProbeSql(tableName: string): string {
  if (!PROBE_TABLE_NAME.test(tableName)) {
    throw new Error("Invalid database probe table name");
  }
  return `BEGIN; CREATE TABLE ${tableName} (probe integer); ROLLBACK;`;
}

/** A failed probe's message, or null when the rolled-back create succeeded. */
export function describeDatabaseProbe(
  exitCode: number,
  output: string,
  password: string,
): string | null {
  if (exitCode === 0) return null;
  const cleaned = redactDatabaseSecret(output, password);
  // Before the Postgres readings: a docker socket the user may not open says
  // "permission denied" too, and that is not about the database user.
  const docker = describeDockerProblem(cleaned);
  if (docker !== null) return docker;
  if (/permission denied/iu.test(cleaned) || /no schema has been selected/iu.test(cleaned)) {
    return CANNOT_CREATE_TABLES;
  }
  return summarizeDatabaseProbe(output, password);
}

export async function chooseDatabase(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  interactive: boolean,
): Promise<DatabaseTarget | null> {
  const flagged = readStringFlag(parsed, "--database-url");
  if (!interactive) {
    if (flagged === undefined) return null;
    const target = parseDatabaseInput(flagged);
    if (typeof target === "string") throw new UsageError(target);
    const problem = await probeDatabase(deps, session, target);
    if (problem !== null) throw new UsageError(problem);
    return target;
  }

  if (flagged === undefined) {
    notice(deps, renderDatabaseChoice());
    const choice = await askSelect(deps, {
      choices: [
        { title: "On this server", value: "bundled" },
        { title: "A separate database", value: "external" },
      ],
      fallback: "bundled",
      initial: 0,
      message: "Where should the database run?",
    });
    if (choice !== "external") return null;
  }

  let target = flagged === undefined ? null : parseDatabaseInput(flagged);
  if (typeof target === "string") throw new UsageError(target);
  for (;;) {
    if (target === null) {
      notice(deps, renderDatabaseConnection());
      const raw = await askChecked(deps, {
        check: (value) => {
          const parsedInput = parseDatabaseInput(value);
          return typeof parsedInput === "string" ? parsedInput : null;
        },
        message: "Connection string",
        type: "password",
      });
      const parsedInput = parseDatabaseInput(raw);
      if (typeof parsedInput === "string") {
        notice(deps, parsedInput);
        continue;
      }
      target = parsedInput;
    }
    notice(deps, [
      `I'll connect as ${target.user} to ${target.host} port ${target.port}, database ${target.database}.`,
    ]);
    const address = await resolvePublicAddress(deps, session, true);
    notice(deps, renderDatabaseAllow(address));
    await holdUntilConfirmed(deps, {
      message: `Allowed ${address}?`,
      nudge: () => renderDatabaseAllow(address),
    });
    for (;;) {
      const problem = await probeDatabase(deps, session, target);
      if (problem === null) {
        notice(deps, "The server can reach the database, and that user can create tables.");
        return target;
      }
      notice(deps, problem);
      const next = await askSelect(deps, {
        choices: [
          { title: "Check again", value: "retry" },
          { title: "Paste the connection string again", value: "paste" },
        ],
        fallback: "retry",
        initial: 0,
        message: "What next?",
      });
      if (next === "paste") {
        target = null;
        break;
      }
    }
  }
}

async function probeDatabase(
  deps: CommandDeps,
  session: SelfhostSession,
  target: DatabaseTarget,
): Promise<string | null> {
  session.progress.write("Checking the database from the server");
  try {
    const image = quoteShellValue("postgres client image", POSTGRES_CLIENT_IMAGE);
    const statement = quoteShellValue(
      "database probe",
      databaseCreateProbeSql(databaseProbeTableName()),
    );
    const result = await captureRemoteShell({
      body: [
        "docker run --rm --network host",
        "-e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGCONNECT_TIMEOUT",
        image,
        `psql --no-psqlrc -v ON_ERROR_STOP=1 -c ${statement}`,
      ].join(" "),
      connection: pairedSshInvocation(session.sshTarget, session.identityFile),
      env: {
        PGCONNECT_TIMEOUT: PROBE_CONNECT_TIMEOUT_SECONDS,
        PGDATABASE: target.database,
        PGHOST: target.host,
        PGPASSWORD: target.password,
        PGPORT: target.port,
        PGSSLMODE: target.sslmode,
        PGUSER: target.user,
      },
      runProcess: deps.runProcess,
    });
    return describeDatabaseProbe(result.exitCode ?? 1, result.output, target.password);
  } finally {
    session.progress.settle();
  }
}
