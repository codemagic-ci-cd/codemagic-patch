// login, logout, whoami and the access-token commands. login/logout keep their
// behaviour in ../login.ts; whoami and token * are cli/src/commands/{whoami,
// tokenCreate,tokenList,tokenRevoke}.ts (@codemagic/patch-cli 0.4.0) — the same
// endpoints and bodies — with `token revoke`'s confirmation and --name from 0.7.0.
// See cli-capacitor-tech-spec › Provenance.

import { authenticatedRequest, type ApiTarget } from "../authenticatedRequest";
import { CLI_NAME } from "../branding";
import {
  CONNECTION_FLAGS,
  deletedOutput,
  FORMAT_FLAG,
  readApiTarget,
  readBoolean,
  readFormat,
  readInteger,
  readString,
  requireString,
  YES_FLAG,
  type CommandDefinition,
} from "../command";
import type { CliDeps } from "../deps";
import { UsageError } from "../errors";
import { executeLogin, executeLogout } from "../login";
import { assertConsentPossible, enforceMutationSafety } from "../mutation";
import { isRecord } from "../output";

const SERVER_URL_FLAG = CONNECTION_FLAGS[0]!;

/** The server's own bound on a token's lifetime (cmpatch enforces the same one). */
const MAX_TOKEN_EXPIRATION_DAYS = 3650;

const login: CommandDefinition = {
  flags: [
    SERVER_URL_FLAG,
    {
      help: "Store this personal access token instead of signing in through the browser",
      name: "token",
      type: "string",
      value: "token",
    },
    {
      help: "Print the sign-in URL instead of opening a browser",
      name: "no-browser",
      type: "boolean",
    },
    {
      help: "How long to wait for the browser sign-in (default: 300)",
      name: "timeout-seconds",
      type: "string",
      value: "n",
    },
  ],
  notes: [
    "Opens the server's sign-in page in your browser and stores the resulting session in",
    "~/.codemagic-patch/credentials-capacitor.json (or under $CODEMAGIC_PATCH_HOME),",
    "readable by your user only.",
  ],
  path: ["login"],
  run: async (values, deps) => {
    const serverUrl = readString(values, "server-url");
    const timeoutSeconds = readInteger(values, "timeout-seconds", { min: 1 });
    const token = readString(values, "token");

    await executeLogin(
      {
        noBrowser: readBoolean(values, "no-browser"),
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(token !== undefined ? { token } : {}),
      },
      deps,
    );
  },
  summary: "Sign in to a Patch server and keep the credentials on this machine",
  usage: "[--server-url <url>] [--token <token>] [--no-browser] [--timeout-seconds <n>]",
};

const logout: CommandDefinition = {
  flags: [SERVER_URL_FLAG],
  notes: [
    "Deletes the stored credential for the server. A browser session is also revoked on",
    "the server. A token stored with `login --token` is only forgotten here: it stays",
    "valid until it is revoked with `token revoke` or on the dashboard's Tokens page.",
  ],
  path: ["logout"],
  run: async (values, deps) => {
    const serverUrl = readString(values, "server-url");
    await executeLogout(serverUrl !== undefined ? { serverUrl } : {}, deps);
  },
  summary: "Forget this machine's credentials for a server",
  usage: "[--server-url <url>]",
};

const whoami: CommandDefinition = {
  flags: [...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["whoami"],
  run: async (values, deps) => {
    const result = await authenticatedRequest(
      deps,
      readApiTarget(values, deps),
      "/v1/users/me",
      { method: "GET" },
    );

    return {
      fields: [
        ["email", "email"],
        ["id", "id"],
        ["name", "display_name"],
        ["status", "status"],
      ],
      json: result,
      kind: "record",
      record: isRecord(result) ? result.user : result,
    };
  },
  summary: "Show the account the next command would run as",
  usage: "[flags]",
};

const tokenCreate: CommandDefinition = {
  flags: [
    { help: "Display name for the token", name: "name", type: "string", value: "name" },
    {
      help: `Lifetime in days, 1-${MAX_TOKEN_EXPIRATION_DAYS} (default: the token does not expire)`,
      name: "expires-in-days",
      type: "string",
      value: "days",
    },
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "The token is shown once, here. Store it as a CI secret and pass it to this CLI as",
    "$CODEMAGIC_PATCH_TOKEN.",
  ],
  path: ["token", "create"],
  run: async (values, deps) => {
    const name = requireString(values, "name");
    const expiresInDays = readInteger(values, "expires-in-days", {
      max: MAX_TOKEN_EXPIRATION_DAYS,
      min: 1,
    });
    const result = await authenticatedRequest(
      deps,
      readApiTarget(values, deps),
      "/v1/auth/tokens",
      {
        body: JSON.stringify({
          display_name: name,
          ...(expiresInDays === undefined ? {} : { expires_in_days: expiresInDays }),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const apiToken = isRecord(result) && isRecord(result.api_token) ? result.api_token : {};

    return {
      details: [
        `token:   ${isRecord(result) && typeof result.token === "string" ? result.token : "-"}`,
        `expires: ${typeof apiToken.expires_at === "string" ? apiToken.expires_at : "never"}`,
        "This is the only time the token is shown.",
      ],
      json: result,
      kind: "action",
      summary: `Created access token "${name}" (${String(apiToken.id ?? "-")}).`,
    };
  },
  summary: "Create a personal access token, e.g. for CI",
  usage: "--name <name> [--expires-in-days <days>] [flags]",
};

const tokenList: CommandDefinition = {
  flags: [...CONNECTION_FLAGS, FORMAT_FLAG],
  path: ["token", "list"],
  run: async (values, deps) => {
    const result = await authenticatedRequest(
      deps,
      readApiTarget(values, deps),
      "/v1/auth/tokens",
      { method: "GET" },
    );

    return {
      columns: [
        { header: "NAME", path: "display_name" },
        { header: "ID", path: "id" },
        { header: "PREFIX", path: "masked_prefix" },
        { header: "EXPIRES", path: "expires_at" },
        { header: "LAST USED", path: "last_used_at" },
      ],
      empty: "No access tokens.",
      json: result,
      kind: "list",
      rows: isRecord(result) && Array.isArray(result.api_tokens) ? result.api_tokens.filter(isRecord) : [],
    };
  },
  summary: "List your personal access tokens",
  usage: "[flags]",
};

const tokenRevoke: CommandDefinition = {
  flags: [
    { help: "Token to revoke (see `token list`)", name: "token-id", type: "string", value: "id" },
    { help: "Token to revoke, by its name (instead of --token-id)", name: "name", type: "string", value: "name" },
    YES_FLAG,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: ["Anything still signing in with the token, such as a CI pipeline, stops working."],
  path: ["token", "revoke"],
  run: async (values, deps) => {
    const tokenId = readString(values, "token-id");
    const name = readString(values, "name");
    if ((tokenId === undefined) === (name === undefined)) {
      throw new UsageError("Pass either --token-id <id> or --name <name>.");
    }
    const target = readApiTarget(values, deps);
    const consent = { commandName: "token revoke", format: readFormat(values), yes: readBoolean(values, "yes") };
    // A --name run lists the tokens first; a missing --yes fails before that request.
    assertConsentPossible(deps, consent);
    const id = tokenId ?? (await resolveTokenIdByName(deps, target, name!));
    await enforceMutationSafety(deps, {
      ...consent,
      fields: [
        ["serverUrl", target.serverUrl],
        ["tokenId", id],
        ...(name !== undefined ? [["tokenName", name] as const] : []),
      ],
    });
    await authenticatedRequest(deps, target, `/v1/auth/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });

    return deletedOutput("token", id, `Revoked access token ${id}.`);
  },
  summary: "Revoke a personal access token",
  usage: "(--token-id <id> | --name <name>) [--yes] [flags]",
};

/**
 * Token names are not unique, so a name must match exactly one token: revoking the
 * wrong one of two "ci" tokens breaks a pipeline nobody meant to touch.
 */
async function resolveTokenIdByName(deps: CliDeps, target: ApiTarget, name: string): Promise<string> {
  const result = await authenticatedRequest(deps, target, "/v1/auth/tokens", { method: "GET" });
  const tokens = (isRecord(result) && Array.isArray(result.api_tokens) ? result.api_tokens : []).filter(
    (token): token is { display_name: string; id: string } =>
      isRecord(token) && typeof token.id === "string" && typeof token.display_name === "string",
  );
  const matches = tokens.filter((token) => token.display_name === name);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new UsageError(
      [
        `Token name "${name}" is ambiguous. Matching IDs: ${matches.map((token) => token.id).join(", ")}`,
        "Next: pass --token-id with one of the IDs above.",
      ].join("\n"),
    );
  }
  const names = [...new Set(tokens.map((token) => token.display_name))];
  throw new UsageError(
    [
      `Token "${name}" not found. Available tokens: ${names.length ? names.join(", ") : "none"}`,
      `Next: pass --name with one of the names above, or --token-id from \`${CLI_NAME} token list\`.`,
    ].join("\n"),
  );
}

export const authCommands: readonly CommandDefinition[] = [
  login,
  logout,
  whoami,
  tokenCreate,
  tokenList,
  tokenRevoke,
];
