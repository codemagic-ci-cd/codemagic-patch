/**
 * The ngrok half of `cmpatch selfhost install --ngrok`: which authtoken to
 * use, and the address it gives this account.
 *
 * The token comes from, in order: `NGROK_AUTHTOKEN`; the one an earlier run
 * of this command was handed; the ngrok agent's own config file, offered by
 * name; and a password prompt. The address is never chosen here — a free
 * account has exactly one, and `scripts/selfhost/ngrok-address.sh` asks
 * ngrok for it.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveConfigHome } from "../../configStore";
import { describeDomainProblem } from "../../selfhostInstall";
import { captureLocal } from "../localEval/process";
import { RemoteScriptFailure } from "../scriptRunner";
import { UsageError, type CommandDeps } from "../shared";
import { askChecked, notice, offerBrowserOpen } from "./ask";

export const NGROK_ADDRESS_SCRIPT = "scripts/selfhost/ngrok-address.sh";
export const NGROK_SIGNUP_URL = "https://dashboard.ngrok.com/signup";
export const NGROK_TOKEN_URL =
  "https://dashboard.ngrok.com/get-started/your-authtoken";
export const NGROK_DOMAINS_URL = "https://dashboard.ngrok.com/domains";

/**
 * How long the address lookup may take in all. The script waits up to 45
 * seconds for ngrok itself; a first run also pulls the ngrok image before
 * that, which on a slow connection is the longer part.
 */
const ADDRESS_LOOKUP_DEADLINE_MS = 5 * 60 * 1000;

export type NgrokTokenSource =
  | { kind: "env" }
  | { kind: "saved"; path: string }
  | { kind: "config"; path: string }
  | { kind: "prompt" };

export type NgrokToken = { source: NgrokTokenSource; value: string };

// ---------------------------------------------------------------------------
// Where the token comes from
// ---------------------------------------------------------------------------

/**
 * The first token available without asking — `NGROK_AUTHTOKEN`, then the one
 * saved by an earlier run — or, when someone is at the terminal, the agent
 * config's token offered by name and then a prompt. A run that cannot ask
 * takes only the first two: reading a credential out of another program's
 * config is something to agree to, not to infer.
 */
export async function resolveNgrokToken(
  deps: CommandDeps,
  input: { interactive: boolean; settle: () => void },
): Promise<NgrokToken> {
  const fromEnv = deps.env.NGROK_AUTHTOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return { source: { kind: "env" }, value: fromEnv };
  }

  const savedPath = savedNgrokTokenPath(deps.env);
  const saved = await readSavedNgrokToken(deps.env);
  if (saved !== null) {
    return { source: { kind: "saved", path: savedPath }, value: saved };
  }

  if (!input.interactive) {
    throw new UsageError(
      [
        "An ngrok authtoken is required: set NGROK_AUTHTOKEN.",
        "",
        `A free ngrok account has one: ${NGROK_TOKEN_URL}`,
      ].join("\n"),
    );
  }

  input.settle();
  const fromConfig = await findNgrokConfigToken(deps);
  if (fromConfig !== null) {
    const agreed =
      (await deps.confirm?.({
        initial: true,
        message: `Use the ngrok authtoken from ${displayPath(deps, fromConfig.path)}?`,
      })) ?? false;
    if (agreed) {
      return {
        source: { kind: "config", path: fromConfig.path },
        value: fromConfig.token,
      };
    }
  }

  return { source: { kind: "prompt" }, value: await askNgrokToken(deps) };
}

export async function askNgrokToken(deps: CommandDeps): Promise<string> {
  notice(deps, [
    "Paste your ngrok authtoken: it lets this machine use the address that comes with your ngrok account.",
    `No account yet? Sign up free at ${NGROK_SIGNUP_URL} — it takes about a minute. The token is at ${NGROK_TOKEN_URL}`,
  ]);
  await offerBrowserOpen(deps, {
    message: "Open ngrok in your browser?",
    url: NGROK_TOKEN_URL,
  });

  return askChecked(deps, {
    check: checkNgrokAuthtoken,
    message: "ngrok authtoken",
    type: "password",
  });
}

/**
 * Catches a paste that is plainly not a token. Loose on purpose: ngrok has
 * changed its token format before, and the address lookup that follows is
 * the real check.
 */
export function checkNgrokAuthtoken(value: string): string | null {
  if (value === "" || /\s/u.test(value)) {
    return "Paste the whole token, without spaces or line breaks.";
  }
  if (value.includes("://")) {
    return "Paste the token itself, not the address of the page it is on.";
  }
  if (value.length < 20) {
    return `That is too short to be an ngrok authtoken; copy the whole value from ${NGROK_TOKEN_URL}`;
  }
  return null;
}

/** How a token's origin is named when ngrok turns it down. */
export function describeTokenSource(
  deps: CommandDeps,
  source: NgrokTokenSource,
): string {
  switch (source.kind) {
    case "env":
      return "NGROK_AUTHTOKEN";
    case "saved":
      return "the earlier run of this command";
    case "config":
      return displayPath(deps, source.path);
    case "prompt":
      return "the one pasted";
  }
}

// ---------------------------------------------------------------------------
// A reserved domain instead of the account's own address
// ---------------------------------------------------------------------------

/**
 * A reserved domain as someone may give it — bare, or pasted from the ngrok
 * dashboard as an https:// address — reduced to the hostname.
 */
export function normalizeNgrokDomain(value: string): string {
  return value
    .trim()
    .replace(/^https:\/\//iu, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

/** Why a given domain cannot be one, or null when it can. */
export function checkNgrokDomain(value: string): string | null {
  return describeDomainProblem(normalizeNgrokDomain(value));
}

export async function askNgrokDomain(deps: CommandDeps): Promise<string> {
  return normalizeNgrokDomain(
    await askChecked(deps, {
      check: checkNgrokDomain,
      message: "Reserved ngrok domain (for example patch-test.ngrok.app)",
      type: "text",
    }),
  );
}

/**
 * Whether a host is an account's own dev domain — the free plan's one
 * address, with its monthly caps and the browser notice page — rather than a
 * domain a paid plan reserved.
 */
export function isNgrokDevDomain(host: string): boolean {
  return /\.ngrok-free\.(?:app|dev)$/u.test(host);
}

// ---------------------------------------------------------------------------
// The ngrok agent's own config file
// ---------------------------------------------------------------------------

/**
 * Where an installed ngrok agent keeps its config, current layout first: the
 * per-platform v3 location, the XDG one (Linux's default, and honoured on a
 * Mac), and v2's `~/.ngrok2`.
 */
export function ngrokConfigPaths(
  env: Record<string, string | undefined>,
  platform: typeof process.platform,
): string[] {
  const home = nonEmpty(env.HOME) ?? homedir();
  const xdg = nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config");
  return [
    ...(platform === "darwin"
      ? [join(home, "Library", "Application Support", "ngrok", "ngrok.yml")]
      : []),
    join(xdg, "ngrok", "ngrok.yml"),
    join(home, ".ngrok2", "ngrok.yml"),
  ];
}

async function findNgrokConfigToken(
  deps: CommandDeps,
): Promise<{ path: string; token: string } | null> {
  for (const path of ngrokConfigPaths(
    deps.env,
    deps.platform ?? process.platform,
  )) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const token = readNgrokConfigToken(text);
    if (token !== null) {
      return { path, token };
    }
  }
  return null;
}

/**
 * The token in an ngrok agent config: `agent.authtoken` in the v3 layout, or
 * v2's top-level `authtoken`. Read line by line rather than with a YAML
 * parser the CLI has no other use for — both layouts keep the token on one
 * plain `authtoken: <value>` line, and anything else in the file is ignored.
 */
export function readNgrokConfigToken(text: string): string | null {
  let inAgent = false;
  let agentIndent: number | null = null;

  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\s+#.*$/u, "");
    const content = line.trim();
    if (content === "" || content.startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inAgent = /^agent:$/u.test(content);
      agentIndent = null;
      const topLevel = /^authtoken:\s*(.+)$/u.exec(content);
      if (topLevel !== null) {
        return unquote(topLevel[1] ?? "");
      }
      continue;
    }

    if (!inAgent) {
      continue;
    }
    // Only the agent block's own keys: a nested map further in could carry
    // an unrelated `authtoken`.
    agentIndent ??= indent;
    if (indent !== agentIndent) {
      continue;
    }
    const nested = /^authtoken:\s*(.+)$/u.exec(content);
    if (nested !== null) {
      return unquote(nested[1] ?? "");
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// The token an earlier run was handed
// ---------------------------------------------------------------------------

/**
 * Kept beside the CLI's config and credentials, readable by this account
 * alone, so a run that stops before the server's settings file is written —
 * on the sign-in step, say — does not ask for it again.
 */
export function savedNgrokTokenPath(
  env: Record<string, string | undefined>,
): string {
  return join(resolveConfigHome(env), "selfhost-local", "ngrok-authtoken");
}

async function readSavedNgrokToken(
  env: Record<string, string | undefined>,
): Promise<string | null> {
  try {
    const token = (await readFile(savedNgrokTokenPath(env), "utf8")).trim();
    return token === "" ? null : token;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveNgrokToken(
  env: Record<string, string | undefined>,
  token: string,
): Promise<void> {
  const path = savedNgrokTokenPath(env);
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${token}\n`, { mode: 0o600 });
  await rename(tempPath, path);
}

export async function forgetNgrokToken(
  env: Record<string, string | undefined>,
): Promise<void> {
  await rm(savedNgrokTokenPath(env), { force: true });
}

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

export type NgrokAddressFailure =
  | "already-online"
  | "docker"
  | "domain"
  | "other"
  | "rejected"
  | "timeout";

export type NgrokAddressResult =
  | { host: string; kind: "address" }
  | { kind: "failed"; message: string; reason: NgrokAddressFailure };

/**
 * Asks ngrok which address this account's token comes with, through
 * `ngrok-address.sh` — a short-lived ngrok container, gone again when it
 * answers. With a domain, that domain is requested instead of the account's
 * dev domain, so one the plan cannot serve fails here. The token travels in
 * the child's environment, never on argv.
 */
export async function lookUpNgrokAddress(
  deps: CommandDeps,
  input: { checkoutPath: string; domain?: string; token: string },
): Promise<NgrokAddressResult> {
  const result = await captureLocal(deps, {
    args: [
      join(input.checkoutPath, NGROK_ADDRESS_SCRIPT),
      ...(input.domain === undefined ? [] : ["--domain", input.domain]),
    ],
    command: "bash",
    env: { ...deps.env, NGROK_AUTHTOKEN: input.token },
    timeoutMs: ADDRESS_LOOKUP_DEADLINE_MS,
  });

  if (result.spawnError !== null) {
    return /timed out/iu.test(result.spawnError)
      ? {
          kind: "failed",
          message: `The lookup was stopped after ${String(ADDRESS_LOOKUP_DEADLINE_MS / 60_000)} minutes.`,
          reason: "timeout",
        }
      : { kind: "failed", message: result.spawnError, reason: "other" };
  }

  const lines = result.output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (result.exitCode === 0) {
    const host = lines
      .map((line) => /^https:\/\/([^\s/]+)\/?$/u.exec(line)?.[1])
      .filter((value): value is string => value !== undefined)
      .at(-1);
    if (host !== undefined && describeDomainProblem(host) === null) {
      return { host: host.toLowerCase(), kind: "address" };
    }
    return {
      kind: "failed",
      message: `${NGROK_ADDRESS_SCRIPT} finished without printing an https:// address.`,
      reason: "other",
    };
  }

  const failure = lines
    .map((line) => /^\[selfhost\] FAIL: (.+)$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
    .at(-1);
  const message =
    failure ??
    lines.at(-1) ??
    `${NGROK_ADDRESS_SCRIPT} exited with status ${String(result.exitCode ?? 1)}.`;
  return { kind: "failed", message, reason: classifyAddressFailure(message) };
}

function classifyAddressFailure(message: string): NgrokAddressFailure {
  if (message.includes("rejected the authtoken")) return "rejected";
  if (message.includes("already online")) return "already-online";
  if (message.includes("cannot serve")) return "domain";
  if (message.includes("did not report an address")) return "timeout";
  if (message.includes("Docker is not running")) return "docker";
  return "other";
}

/**
 * Every lookup failure other than a turned-down token, which the caller
 * handles by asking again: what happened, in the user's terms, and the one
 * thing to do about it. `domain` is the one that was asked for, when one was.
 * Nothing has changed on the machine at this point.
 */
export function renderAddressFailure(
  failure: Extract<NgrokAddressResult, { kind: "failed" }>,
  domain?: string,
): Error {
  switch (failure.reason) {
    case "already-online":
      return new UsageError(
        [
          `${domain === undefined ? "Your ngrok account's address" : `https://${domain}`} is already in use by another ngrok agent — an \`ngrok http …\` running in another terminal, for example. An address serves one agent at a time.`,
          "",
          "Stop that agent, then run this command again. On a paid ngrok plan you can instead use another domain it has reserved: pass --ngrok-domain <domain>. Nothing on this machine was changed.",
        ].join("\n"),
      );
    case "domain":
      return new UsageError(
        [
          `Your ngrok account cannot serve ${domain ?? "that domain"}.`,
          "",
          `Reserve it under Domains at ${NGROK_DOMAINS_URL} (a paid-plan feature), or run without --ngrok-domain to use your account's own address. Nothing on this machine was changed.`,
          `(${failure.message})`,
        ].join("\n"),
      );
    case "timeout":
      return new RemoteScriptFailure(
        [
          "ngrok did not report your account's address in time.",
          "",
          "Check that this machine can reach ngrok — a firewall or proxy can block it — then run this command again.",
          `(${failure.message})`,
        ].join("\n"),
      );
    case "docker":
      return new RemoteScriptFailure(
        [
          "Docker stopped answering while your ngrok address was being looked up.",
          "",
          "Start Docker, then run this command again.",
        ].join("\n"),
      );
    case "rejected":
    case "other":
      return new RemoteScriptFailure(
        ["Could not look up your ngrok address.", "", failure.message].join("\n"),
      );
  }
}

// ---------------------------------------------------------------------------

function displayPath(deps: CommandDeps, path: string): string {
  const home = nonEmpty(deps.env.HOME);
  return home !== undefined && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

function unquote(value: string): string | null {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unquoted === "" ? null : unquoted;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
