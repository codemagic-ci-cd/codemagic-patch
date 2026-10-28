/**
 * `cmpatch selfhost install --ngrok` — the self-host stack on this machine,
 * reached at the free https:// address an ngrok account comes with, so an
 * app of the user's own can be connected and tested on any device. No ssh,
 * no domain, no DNS records, no certificate, no open port: ngrok's edge holds
 * the certificate and forwards to the stack, which publishes nothing on this
 * machine.
 *
 * A thin wrapper, like the ssh install: `scripts/selfhost/ngrok-address.sh`
 * finds the address and `scripts/selfhost/install.sh --ngrok` installs, both
 * run as children of this process from a checkout the CLI keeps (or one the
 * user names). What the CLI adds is the asking — the ngrok token, the
 * sign-in app, the administrator — and pointing `cmpatch` at the result.
 */

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { PRODUCT_NAME, SOURCE_REPO_URL } from "../../branding";
import { resolveConfigHome } from "../../configStore";
import { createProgress, type Progress } from "../../progress";
import { NGROK_INSTALL_MILESTONES } from "../../remoteOutput";
import {
  buildNgrokInstallEnv,
  OAUTH_PROVIDERS,
  type OAuthCredentials,
} from "../../selfhostInstall";
import { getCliVersion } from "../../version";
import { formatElapsed, isSshSession } from "../localEval";
import { adoptDefaultServer } from "../localEval/defaultServer";
import { ensureDocker } from "../localEval/docker";
import { captureLocal } from "../localEval/process";
import { cloneSource } from "../localEval/source";
import { RemoteScriptFailure, runRenderedScript } from "../scriptRunner";
import {
  canAsk,
  parseArgs,
  readStringFlag,
  type FlagShape,
  type ParsedArgs,
} from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
import {
  OAUTH_FLAGS,
  readOAuthCredentials,
  required,
  suppliedOAuthProvider,
} from "./answers";
import { askChecked, notice, offerBrowserOpen, paletteFor } from "./ask";
import type { InstallOutcome } from "./index";
import {
  askNgrokDomain,
  checkNgrokAuthtoken,
  checkNgrokDomain,
  describeTokenSource,
  forgetNgrokToken,
  isNgrokDevDomain,
  lookUpNgrokAddress,
  NGROK_ADDRESS_SCRIPT,
  NGROK_DOMAINS_URL,
  NGROK_TOKEN_URL,
  normalizeNgrokDomain,
  renderAddressFailure,
  resolveNgrokToken,
  saveNgrokToken,
  type NgrokAddressResult,
  type NgrokToken,
} from "./ngrok";
import { askAdminEmail, collectOAuth } from "./wizard";

export const NGROK_FLAGS: FlagShape = {
  "--checkout": "value",
  "--email": "value",
  "--install-docker": "boolean",
  "--ngrok": "boolean",
  "--ngrok-domain": "value",
  "--non-interactive": "boolean",
  "--start-docker": "boolean",
  ...OAUTH_FLAGS,
};

const LABEL = "cmpatch selfhost install";
const INSTALL_SCRIPT = "scripts/selfhost/install.sh";
const ENV_FILE = ".env.selfhost";

/** The Compose project the selfhost scripts run the stack under. */
const SELFHOST_PROJECT = "codemagic-patch-selfhost";

/** What a first install collected, kept for the closing lines. */
type FirstInstall = {
  adminEmail: string;
  env: Record<string, string>;
  host: string;
  signInProvider: string;
};

export async function runLocalNgrokInstall(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<InstallOutcome> {
  const parsed = parseArgs(argv, NGROK_FLAGS);
  const [target] = parsed.positionals;
  if (target !== undefined) {
    throw new UsageError(
      `--ngrok installs on this machine; drop the ssh target (${target}).`,
    );
  }
  // Before anything starts: a second provider's credentials left in the
  // shell, or a domain that cannot be one, is refused here rather than after
  // the Docker checks.
  suppliedOAuthProvider(deps, parsed);
  const requestedDomain = readRequestedDomain(parsed);

  const interactive = canAsk(deps, parsed);
  const startedAt = deps.now();
  const progress = createProgress({
    intro: "at-start",
    label: LABEL,
    stderr: deps.stderr,
    title: `${PRODUCT_NAME} · ${LABEL} --ngrok ${paletteFor(deps).dim(getCliVersion())}`,
  });

  let serverUp = false;
  try {
    if (interactive) {
      notice(deps, renderWelcome());
    }

    progress.write("checking Docker");
    await ensureDocker(deps, {
      parsed,
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      progress,
      stack: "self-host stack",
    });

    const checkout = resolveCheckout(deps, parsed);
    await ensureCheckout(deps, progress, checkout);
    await refuseOtherInstall(deps, checkout.path);

    const previous = await readPreviousInstall(checkout.path);
    let first: FirstInstall | null = null;
    if (previous === null) {
      first = await collectFirstInstall(deps, parsed, progress, {
        checkoutPath: checkout.path,
        interactive,
        ...(requestedDomain === undefined ? {} : { requestedDomain }),
      });
    } else if (previous.scheme !== "ngrok") {
      throw new UsageError(
        [
          `${join(checkout.path, ENV_FILE)} holds the settings of an install that is reached over ${previous.scheme}, not through ngrok; the installer keeps a deployment's scheme.`,
          "",
          "Point --checkout at another clone of the repository to install there through ngrok.",
        ].join("\n"),
      );
    } else if (
      requestedDomain !== undefined &&
      previous.host !== null &&
      requestedDomain !== previous.host.toLowerCase()
    ) {
      // The address is in every app built against this server and in the
      // sign-in app's callback, so it is not something a rerun changes.
      throw new UsageError(
        [
          `This install is at https://${previous.host}; --ngrok-domain only chooses the address of a first install.`,
          "",
          `Moving it to https://${requestedDomain} also means a new callback in the sign-in app and rebuilding every app that uses the old address. If that is what you want, run scripts/selfhost/install.sh --repair-env --api-domain ${requestedDomain} in ${checkout.path}.`,
        ].join("\n"),
      );
    } else if (suppliedFirstInstallAnswers(parsed)) {
      notice(
        deps,
        `Reusing the settings from the first install in ${join(checkout.path, ENV_FILE)}; --email and the sign-in flags only apply to a first install.`,
      );
    }

    const reported = await runInstaller(deps, progress, checkout.path, first?.env ?? {});
    const host = first?.host ?? reported ?? previous?.host ?? undefined;
    if (host === undefined) {
      throw new RemoteScriptFailure(
        `The installer finished but did not say which address the server is at. Look for CODEMAGIC_PATCH_API_DOMAIN in ${join(checkout.path, ENV_FILE)}.`,
      );
    }
    serverUp = true;
    const serverUrl = `https://${host}`;

    // The installer's last milestone may still be animating, and the
    // questions below must not draw under it.
    progress.settle();
    const defaulted = await adoptDefaultServer(deps, parsed, {
      name: "the server on this machine",
      serverUrl,
    });
    await offerDashboard(deps, parsed, serverUrl, first);

    progress.stop(
      `Installed at ${serverUrl} (${formatElapsed(deps.now() - startedAt)}).`,
    );

    return {
      ...(first === null
        ? {}
        : { adminEmail: first.adminEmail, signInProvider: first.signInProvider }),
      serverUrl,
      summary: renderBanner({ defaulted, first, serverUrl }),
    };
  } catch (error) {
    progress.fail(
      serverUp
        ? "The server is running, but the steps after it did not finish."
        : "Install failed.",
    );
    throw error;
  }
}

function renderWelcome(): string[] {
  return [
    `Welcome! This command installs the ${PRODUCT_NAME} server on this machine with Docker — the real server, with sign-in — and makes it reachable at the free https:// address your ngrok account comes with, so you can connect your own app and test it on any device. No domain, DNS records, certificates, or open ports are needed.`,
    "It needs Docker, a free ngrok account, and a GitHub, Bitbucket, or GitLab account to sign in with. The first run builds the server, which takes 10–20 minutes, and it asks before installing or starting anything.",
  ];
}

// ---------------------------------------------------------------------------
// The checkout
// ---------------------------------------------------------------------------

type Checkout = { managed: boolean; path: string };

/**
 * The CLI's own clone lives apart from local-eval's: this one holds the
 * server's settings file and its secrets, which outlive any single run.
 */
function managedNgrokCheckoutPath(
  env: Record<string, string | undefined>,
): string {
  return join(resolveConfigHome(env), "selfhost-local", "codemagic-patch");
}

function resolveCheckout(deps: CommandDeps, parsed: ParsedArgs): Checkout {
  const explicit = readStringFlag(parsed, "--checkout");
  if (explicit !== undefined) {
    return {
      managed: false,
      path: isAbsolute(explicit) ? explicit : resolve(explicit),
    };
  }
  return { managed: true, path: managedNgrokCheckoutPath(deps.env) };
}

/**
 * Cloned when missing, used as it is otherwise. Not fast-forwarded the way
 * local-eval's is: a later source is a server upgrade, and a rerun here is
 * how an interrupted install is finished, not how one is upgraded.
 */
async function ensureCheckout(
  deps: CommandDeps,
  progress: Progress,
  checkout: Checkout,
): Promise<void> {
  if (!(await exists(deps, checkout.path))) {
    if (!checkout.managed) {
      throw new UsageError(
        `${checkout.path} does not exist; --checkout must point at a checkout of ${SOURCE_REPO_URL}.`,
      );
    }
    await cloneSource(deps, progress, checkout.path, "the self-host stack's source");
  }

  if (!(await isFile(deps, join(checkout.path, INSTALL_SCRIPT)))) {
    throw new UsageError(
      checkout.managed
        ? [
            `${checkout.path} exists but is not a checkout of the self-host stack.`,
            "Move it out of the way and run this again, or pass --checkout <path> to use a checkout you already have.",
          ].join("\n")
        : `${checkout.path} does not contain ${INSTALL_SCRIPT}; --checkout must point at a checkout of ${SOURCE_REPO_URL}.`,
    );
  }

  if (!(await isFile(deps, join(checkout.path, NGROK_ADDRESS_SCRIPT)))) {
    throw new UsageError(
      [
        `${checkout.path} has no ${NGROK_ADDRESS_SCRIPT}: its source predates installing through ngrok.`,
        checkout.managed
          ? "Pass --checkout <path> with a checkout of the repository that has it."
          : "Update that checkout, or pass --checkout <path> with one that has it.",
      ].join("\n"),
    );
  }
}

/**
 * Stops before a second install takes over the first. The selfhost scripts
 * run every install under one Compose project, so containers from another
 * checkout mean another install's database and files — which this one would
 * otherwise start on with settings that do not match them. Left untouched.
 */
async function refuseOtherInstall(
  deps: CommandDeps,
  checkoutPath: string,
): Promise<void> {
  const listing = await captureLocal(deps, {
    args: [
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${SELFHOST_PROJECT}`,
      "--format",
      '{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    command: "docker",
  });
  if (listing.spawnError !== null || listing.exitCode !== 0) {
    return;
  }

  const ours = await canonical(checkoutPath);
  for (const directory of new Set(
    listing.output.split("\n").map((line) => line.trim()).filter(Boolean),
  )) {
    if ((await canonical(directory)) !== ours) {
      throw new UsageError(
        [
          `This machine already runs a ${PRODUCT_NAME} self-host stack, installed from ${directory}.`,
          `Every install shares the Docker project ${SELFHOST_PROJECT} — its containers, database, and files — so this one stops here and leaves that one untouched.`,
          "",
          "Stop and remove that install first if you no longer need it, then run this again.",
        ].join("\n"),
      );
    }
  }
}

type PreviousInstall = { host: string | null; scheme: string };

/**
 * What an earlier install left in the checkout's settings file, if one did.
 * Two documented keys only: how the stack is reached, and its address.
 */
async function readPreviousInstall(
  checkoutPath: string,
): Promise<PreviousInstall | null> {
  let text: string;
  try {
    text = await readFile(join(checkoutPath, ENV_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const values = readEnvValues(text);
  // Empty counts as absent, as in common.sh's selfhost_scheme_from_env_file.
  return {
    host: values.get("CODEMAGIC_PATCH_API_DOMAIN") || null,
    scheme: values.get("SELFHOST_SCHEME") || "https",
  };
}

/**
 * The settings file read the way the installer reads it — common.sh's
 * load_selfhost_env and selfhost_env_value_from_file, after Compose's dotenv:
 * an optional `export`, whitespace around `=`, a quoted value up to its
 * closing quote, an unquoted one trimmed and cut at an inline comment (a `#`
 * after whitespace), and the last assignment wins. A line the installer
 * accepts but this skipped would read as the default scheme, https, and turn
 * a commented or reformatted ngrok install away as another kind.
 */
function readEnvValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=(.*)$/u.exec(line);
    if (match === null) {
      continue;
    }
    values.set(match[1] ?? "", readEnvValue(match[2] ?? ""));
  }
  return values;
}

function readEnvValue(raw: string): string {
  const value = raw.trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closing = value.indexOf(quote, 1);
    return closing === -1 ? value.slice(1) : value.slice(1, closing);
  }
  return value.replace(/\s#.*$/u, "").trimEnd();
}

// ---------------------------------------------------------------------------
// A first install's answers
// ---------------------------------------------------------------------------

/**
 * The address first when someone is at the terminal — the sign-in app's form
 * is filled in from it — and the flags first otherwise, so a scripted run
 * missing one is told before a container is started.
 */
async function collectFirstInstall(
  deps: CommandDeps,
  parsed: ParsedArgs,
  progress: Progress,
  input: { checkoutPath: string; interactive: boolean; requestedDomain?: string },
): Promise<FirstInstall> {
  if (!input.interactive) {
    const oauth = readOAuthCredentials(
      deps,
      parsed,
      suppliedOAuthProvider(deps, parsed) ?? "github",
    );
    const adminEmail = required(parsed, "--email", "the admin's email address");
    const { host, token } = await findAddress(deps, progress, input);
    return firstInstall({ adminEmail, host, oauth, token });
  }

  const { host, token } = await findAddress(deps, progress, input);
  notice(
    deps,
    "That address belongs to your ngrok account: ngrok forwards it to the server on this machine, so no domain, DNS records, certificates, or open ports are needed.",
  );
  // The provider's form is filled in from the address, and the
  // administrator question names the provider, so the pair comes first.
  const oauth = (await collectOAuth(deps, parsed, host)) as OAuthCredentials;
  const adminEmail =
    readStringFlag(parsed, "--email") ?? (await askAdminEmail(deps, oauth.provider));
  return firstInstall({ adminEmail, host, oauth, token });
}

function firstInstall(input: {
  adminEmail: string;
  host: string;
  oauth: OAuthCredentials;
  token: NgrokToken;
}): FirstInstall {
  return {
    adminEmail: input.adminEmail,
    env: buildNgrokInstallEnv({
      adminEmail: input.adminEmail,
      apiDomain: input.host,
      ngrokAuthtoken: input.token.value,
      oauth: input.oauth,
    }),
    host: input.host,
    signInProvider: describeProvider(input.oauth),
  };
}

/**
 * The address, asked of ngrok with the first token available: the account's
 * own, or the reserved domain `--ngrok-domain` names. A token ngrok turns
 * down is asked for again when someone is there to paste one — and a saved
 * one is forgotten either way. An address another agent holds, or a domain
 * the plan cannot serve, is answered at the terminal with the choice of
 * another reserved domain, since that is what a paid plan has; anything else
 * ends the run with what to do about it.
 */
async function findAddress(
  deps: CommandDeps,
  progress: Progress,
  input: { checkoutPath: string; interactive: boolean; requestedDomain?: string },
): Promise<{ host: string; token: NgrokToken }> {
  const { checkoutPath, interactive } = input;
  let domain = input.requestedDomain;
  let token = await resolveNgrokToken(deps, {
    interactive,
    settle: () => progress.settle(),
  });

  for (;;) {
    progress.write(
      domain === undefined
        ? "looking up your ngrok address"
        : `checking that your ngrok account can serve ${domain}`,
    );
    const result = await lookUpNgrokAddress(deps, {
      checkoutPath,
      ...(domain === undefined ? {} : { domain }),
      token: token.value,
    });

    if (result.kind === "address") {
      if (token.source.kind === "prompt") {
        await saveNgrokToken(deps.env, token.value);
      }
      progress.write(`your address is https://${result.host}`);
      progress.settle();
      return { host: result.host, token };
    }

    if (result.reason === "already-online" || result.reason === "domain") {
      if (!interactive) {
        throw renderAddressFailure(result, domain);
      }
      progress.settle("failed");
      const another = await offerAnotherDomain(deps, result, domain);
      if (another === undefined) {
        throw renderAddressFailure(result, domain);
      }
      domain = another;
      continue;
    }

    if (result.reason !== "rejected") {
      throw renderAddressFailure(result, domain);
    }

    if (token.source.kind === "saved") {
      await forgetNgrokToken(deps.env);
    }
    const rejected = `ngrok rejected the authtoken from ${describeTokenSource(deps, token.source)}.`;
    if (!interactive) {
      throw new UsageError(
        [
          rejected,
          "",
          `Copy the current one from ${NGROK_TOKEN_URL}, set it as NGROK_AUTHTOKEN, and run this again.`,
        ].join("\n"),
      );
    }

    progress.settle("failed");
    notice(deps, `${rejected} Paste the current one from ${NGROK_TOKEN_URL}`);
    token = {
      source: { kind: "prompt" },
      value: await askChecked(deps, {
        check: checkNgrokAuthtoken,
        message: "ngrok authtoken",
        type: "password",
      }),
    };
  }
}

/**
 * After an address another agent holds, or a domain the plan cannot serve:
 * what happened, then — defaulting to no, because a free plan has no other
 * domain — whether to use another one the plan has reserved.
 */
async function offerAnotherDomain(
  deps: CommandDeps,
  result: Extract<NgrokAddressResult, { kind: "failed" }>,
  domain: string | undefined,
): Promise<string | undefined> {
  notice(
    deps,
    result.reason === "already-online"
      ? `${domain === undefined ? "Your ngrok account's address" : `https://${domain}`} is already in use by another ngrok agent — an \`ngrok http …\` in another terminal, for example — and an address serves one agent at a time. Stop that agent and run this again, or, on a paid ngrok plan, use another domain it has reserved.`
      : `Your ngrok account cannot serve ${domain ?? "that domain"}: a domain has to be reserved under Domains at ${NGROK_DOMAINS_URL}, which is a paid-plan feature.`,
  );
  const agreed =
    (await deps.confirm?.({
      initial: false,
      message: "Use another domain your ngrok plan has reserved?",
    })) ?? false;
  return agreed ? askNgrokDomain(deps) : undefined;
}

/** `--ngrok-domain`, as a bare hostname, refused before anything starts if it cannot be one. */
function readRequestedDomain(parsed: ParsedArgs): string | undefined {
  const value = readStringFlag(parsed, "--ngrok-domain");
  if (value === undefined) {
    return undefined;
  }
  const problem = checkNgrokDomain(value);
  if (problem !== null) {
    throw new UsageError(`--ngrok-domain ${value}: ${problem}`);
  }
  return normalizeNgrokDomain(value);
}

function describeProvider(oauth: OAuthCredentials): string {
  const { displayName, extraFields } = OAUTH_PROVIDERS[oauth.provider];
  // A self-managed instance is named; the provider's default is not.
  const instance = (extraFields as readonly { default: string; flag: string }[])
    .map((field) => ({ field, value: oauth.extra?.[field.flag] }))
    .find(({ field, value }) => value !== undefined && value !== field.default)?.value;
  return instance === undefined ? displayName : `${displayName} at ${instance}`;
}

/** Whether a rerun was handed answers only a first install takes. */
function suppliedFirstInstallAnswers(parsed: ParsedArgs): boolean {
  return Object.keys(parsed.flags).some(
    (flag) => flag === "--email" || Object.hasOwn(OAUTH_FLAGS, flag),
  );
}

// ---------------------------------------------------------------------------
// The install itself
// ---------------------------------------------------------------------------

/**
 * Runs `install.sh --ngrok` with the answers in its environment, and returns
 * the address it reports — which is the only place a rerun learns it from.
 */
async function runInstaller(
  deps: CommandDeps,
  progress: Progress,
  checkoutPath: string,
  answers: Record<string, string>,
): Promise<string | undefined> {
  let reported: string | undefined;
  let partial = "";
  const watch = (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const host = /^\[selfhost\] ngrok address: https:\/\/([^\s/]+)\/?\s*$/u.exec(line)?.[1];
      if (host !== undefined) {
        reported = host.toLowerCase();
      }
    }
  };

  await runRenderedScript(deps, {
    interruptNotice: (logPath) => [
      "The install may be partly done.",
      ...(logPath !== undefined ? [`Full log: ${logPath}`] : []),
      "Run the same command again to finish it: it reuses what this run already set up.",
    ],
    launch: (onOutput) =>
      deps.runProcess({
        args: [join(checkoutPath, INSTALL_SCRIPT), "--ngrok", "--yes"],
        command: "bash",
        env: { ...deps.env, ...answers },
        onOutput: (chunk) => {
          watch(chunk);
          onOutput(chunk);
        },
      }),
    milestones: NGROK_INSTALL_MILESTONES,
    name: "install-ngrok",
    progress,
    wording: { subject: "the installer", tailHeading: "Last output:" },
  });
  watch("\n");

  return reported;
}

// ---------------------------------------------------------------------------
// The ending
// ---------------------------------------------------------------------------

/**
 * The dashboard, offered with what to do on it said first. Over ssh the
 * offer is skipped — a browser opened from here opens on the wrong machine —
 * but the address is public, so it is printed for any browser to use.
 */
async function offerDashboard(
  deps: CommandDeps,
  parsed: ParsedArgs,
  serverUrl: string,
  first: FirstInstall | null,
): Promise<void> {
  if (!canAsk(deps, parsed)) {
    return;
  }

  const url = `${serverUrl}/`;
  const lead = [
    first === null
      ? `The dashboard is at ${url}.`
      : `The dashboard is at ${url}. Sign in with ${first.signInProvider} as ${first.adminEmail}: the first sign-in creates the administrator account.`,
    // Paid plans serve their reserved domains without the notice page.
    ...(isNgrokDevDomain(new URL(serverUrl).host)
      ? ["On ngrok's free plan a browser first sees an ngrok notice page; choose Visit Site to continue."]
      : []),
  ];

  if (isSshSession(deps.env)) {
    notice(deps, lead);
    return;
  }

  await offerBrowserOpen(deps, {
    abort: "decline",
    lead,
    message: "Open the dashboard in your browser?",
    url,
  });
}

/**
 * What the next minute needs: where the server is and how to sign in, the
 * two values an app is configured with, the next commands, and what the free
 * ngrok plan is good for. The spinner has already said it is installed.
 */
function renderBanner(input: {
  defaulted: boolean;
  first: Pick<FirstInstall, "adminEmail" | "signInProvider"> | null;
  serverUrl: string;
}): string {
  const { defaulted, first, serverUrl } = input;
  const serverFlag = defaulted ? "" : ` --server-url ${serverUrl}`;
  const host = new URL(serverUrl).host;
  // The account's dev domain carries the free plan's caps; a reserved
  // domain carries the plan's, and the obligation to keep it reserved.
  const planNote = isNgrokDevDomain(host)
    ? "ngrok's free plan covers 1 GB and 20,000 requests a month: fine for testing your own app, not for an app in the store."
    : `Apps keep the address they were built with: keep ${host} reserved with ngrok for as long as they are installed.`;

  return [
    `Dashboard  ${serverUrl}/${first === null ? "" : `  (sign in with ${first.signInProvider} as ${first.adminEmail})`}`,
    `API        ${serverUrl}  (app config: CodemagicPatchApiUrl)`,
    `Downloads  ${serverUrl}/codemagic-patch  (app config: CodemagicPatchDownloadBaseUrl)`,
    "",
    `Next: cmpatch login${serverFlag}, then in your app's folder: cmpatch init${serverFlag}`,
    "",
    `${planNote} For production, install on your own domain: cmpatch selfhost install user@vps`,
  ].join("\n");
}

// ---------------------------------------------------------------------------

async function exists(deps: CommandDeps, path: string): Promise<boolean> {
  try {
    await deps.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(deps: CommandDeps, path: string): Promise<boolean> {
  try {
    return (await deps.stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Symlinks resolved, so /tmp and /private/tmp name one directory. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
