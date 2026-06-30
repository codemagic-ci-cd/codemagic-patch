import { randomUUID } from "node:crypto";

import {
  createDatabasePool,
  createPostgresAuthRepository,
  migrateDatabase,
} from "../src";
import type { MembershipId, RoleBindingId, TeamId } from "../src/domain";

interface CliStreams {
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
}

interface CliRunOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  streams?: CliStreams;
}

interface ParsedArgs {
  email: string;
  teamId: string;
}

export async function runGrantTeamOwnerCli(
  options: CliRunOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const streams = options.streams ?? {
    stderr: process.stderr,
    stdout: process.stdout,
  };

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    streams.stderr.write(`${parsed.error}\n`);
    return 1;
  }

  const databaseUrl = resolveRequiredEnv(env.DATABASE_URL, "DATABASE_URL");
  if ("error" in databaseUrl) {
    streams.stderr.write(`${databaseUrl.error}\n`);
    return 1;
  }

  const pool = createDatabasePool({
    connectionString: databaseUrl.value,
    searchPath: parseDatabaseSearchPath(env.DATABASE_SEARCH_PATH),
  });

  try {
    await migrateDatabase(pool);

    const repository = createPostgresAuthRepository(pool);
    const result = await repository.grantTeamOwnerByEmail({
      createdAt: new Date(),
      email: parsed.value.email,
      membershipId: createRandomPrefixedId("mem") as MembershipId,
      roleBindingId: createRandomPrefixedId("rb") as RoleBindingId,
      teamId: parsed.value.teamId as TeamId,
    });

    if (result.outcome === "not_found") {
      streams.stderr.write(`${notFoundMessage(result.reason)}\n`);
      return 1;
    }

    if (result.outcome === "account_disabled") {
      streams.stderr.write(`${accountDisabledMessage(result.reason)}\n`);
      return 1;
    }

    streams.stdout.write(`User ID: ${result.user.id}\n`);
    streams.stdout.write(`Team ID: ${result.team.id}\n`);
    streams.stdout.write(
      `Membership created: ${result.membershipCreated ? "yes" : "no"}\n`,
    );
    streams.stdout.write(
      `Owner role binding created: ${
        result.ownerRoleBindingCreated ? "yes" : "no"
      }\n`,
    );

    return 0;
  } catch (error) {
    streams.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await pool.end();
  }
}

function parseArgs(
  argv: string[],
):
  | {
      error: string;
    }
  | {
      value: ParsedArgs;
    } {
  const parsed: Partial<ParsedArgs> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--team-id") {
      const value = readOptionValue(argv, index);
      if (value === null) {
        return {
          error: `${arg} requires a non-empty value`,
        };
      }
      parsed.teamId = value;
      index += 1;
      continue;
    }

    if (arg === "--email") {
      const value = readOptionValue(argv, index);
      if (value === null) {
        return {
          error: `${arg} requires a non-empty value`,
        };
      }
      parsed.email = value;
      index += 1;
      continue;
    }

    return {
      error: `Unknown argument: ${arg}`,
    };
  }

  if (!isNonEmptyString(parsed.teamId)) {
    return {
      error: "--team-id is required",
    };
  }

  if (!isNonEmptyString(parsed.email)) {
    return {
      error: "--email is required",
    };
  }

  return {
    value: {
      email: parsed.email,
      teamId: parsed.teamId,
    },
  };
}

function readOptionValue(argv: string[], index: number): string | null {
  const value = argv[index + 1];
  if (!isNonEmptyString(value)) {
    return null;
  }

  return value.trim();
}

function resolveRequiredEnv(
  value: string | undefined,
  name: string,
):
  | {
      error: string;
    }
  | {
      value: string;
    } {
  if (!isNonEmptyString(value)) {
    return {
      error: `${name} is required`,
    };
  }

  return {
    value: value.trim(),
  };
}

function parseDatabaseSearchPath(value: string | undefined): string[] {
  if (!isNonEmptyString(value)) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function createRandomPrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function notFoundMessage(reason: "team_not_found" | "user_not_found"): string {
  return reason === "team_not_found"
    ? "Team was not found"
    : "User was not found";
}

function accountDisabledMessage(
  reason: "team_disabled" | "user_disabled",
): string {
  return reason === "team_disabled" ? "Team is disabled" : "User is disabled";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

if (require.main === module) {
  runGrantTeamOwnerCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
