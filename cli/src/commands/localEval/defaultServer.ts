/**
 * Pointing `cmpatch` at a server this machine just brought up: the local
 * evaluation stack, or a self-host install reached through ngrok. Both leave
 * the user with commands to run against it, and both may land on a machine
 * that already talks to another server.
 */

import {
  loadCliConfig,
  loadProjectConfig,
  saveCliConfig,
} from "../../configStore";
import { confirmFinishStep, notice } from "../selfhostInstall/ask";
import { canAsk, type ParsedArgs } from "../selfhostSession";
import type { CommandDeps } from "../shared";

export type LocalServer = {
  /** How the copy refers to it, mid-sentence: "the evaluation stack". */
  name: string;
  serverUrl: string;
};

/**
 * Points `cmpatch` at the server, so the banner's commands work as printed —
 * and returns whether they actually will.
 *
 * Only an empty user-level default is taken silently. A machine that already
 * names a server — someone evaluating next to a real deployment — is asked,
 * because a `release create` that quietly went to this machine instead of
 * production is worse than one extra question; and a scripted run keeps what
 * it had. The user-level default is not the last word, though: the
 * environment and the project config of the directory this runs in outrank
 * it (the order localContext.ts applies), so a run from inside an app that
 * names its own server is told that server still wins, and the commands
 * shown carry `--server-url` — there is nothing to ask in that case.
 */
export async function adoptDefaultServer(
  deps: CommandDeps,
  parsed: ParsedArgs,
  server: LocalServer,
): Promise<boolean> {
  const { name, serverUrl } = server;
  const override = await serverOverride(deps);
  const config = await loadCliConfig({ env: deps.env });

  if (config.serverUrl === undefined) {
    await saveCliConfig({ ...config, serverUrl }, { env: deps.env });
    if (override === null) {
      notice(
        deps,
        `cmpatch commands now default to ${serverUrl} (change it with \`cmpatch config set server-url <url>\`).`,
      );
    }
  } else if (config.serverUrl !== serverUrl && override === null) {
    if (!canAsk(deps, parsed)) {
      notice(
        deps,
        `cmpatch commands keep defaulting to ${config.serverUrl}; pass --server-url ${serverUrl} to use ${name}.`,
      );
      return false;
    }

    // Said before it is asked: the question decides a machine-wide default,
    // and the address alone does not say that this is a second server next to
    // the one this machine already uses. Default no, deliberately: a
    // `release create` that quietly went here instead of production is worse
    // than one declined question. Once the server is up, Ctrl+C here means
    // what "No" means.
    notice(
      deps,
      [
        `cmpatch commands on this machine default to ${config.serverUrl} when a project does not name its own server.`,
        `${capitalize(name)} is a second server, at ${serverUrl}; commands meant for it need that default, or --server-url on each one.`,
      ].join(" "),
    );
    const agreed = await confirmFinishStep(deps, {
      initial: false,
      message: `Make ${serverUrl} the default server for cmpatch on this machine?`,
    });
    if (!agreed) {
      return false;
    }

    await saveCliConfig({ ...config, serverUrl }, { env: deps.env });
  }

  if (override !== null && override.value !== serverUrl) {
    notice(
      deps,
      `${override.source} sets the server to ${override.value}, which outranks the default; pass --server-url ${serverUrl} to cmpatch commands run from here to reach ${name}.`,
    );
    return false;
  }

  return true;
}

type ServerOverride = { source: string; value: string };

/**
 * What outranks the user-level `serverUrl` for commands run from this
 * directory: `CODEMAGIC_PATCH_SERVER_URL`, then the project's own config —
 * the precedence localContext.ts gives every other command.
 */
async function serverOverride(deps: CommandDeps): Promise<ServerOverride | null> {
  const fromEnv = deps.env.CODEMAGIC_PATCH_SERVER_URL?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return { source: "CODEMAGIC_PATCH_SERVER_URL", value: fromEnv };
  }

  const projectRoot = process.cwd();
  let fromProject: string | undefined;
  try {
    fromProject = (await loadProjectConfig(projectRoot)).serverUrl;
  } catch {
    // A project config that does not parse fails every command run here
    // with its own message; this one only decides how to word the banner.
    return null;
  }
  return fromProject === undefined
    ? null
    : { source: `The project config in ${projectRoot}`, value: fromProject };
}

/** The server `cmpatch` commands run from here would actually use. */
export async function effectiveServerUrl(deps: CommandDeps): Promise<string | undefined> {
  const override = await serverOverride(deps);
  if (override !== null) {
    return override.value;
  }
  return (await loadCliConfig({ env: deps.env })).serverUrl;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
