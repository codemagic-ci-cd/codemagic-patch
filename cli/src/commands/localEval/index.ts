/**
 * `cmpatch selfhost local-eval [up|down|status]` — the evaluation stack on
 * this machine, for trying the product. Not a deployment: sign-in is
 * disabled and every port binds to localhost.
 *
 * A thin wrapper, like its ssh siblings: the bring-up is
 * `scripts/local-eval/up.sh`, unchanged, run from a checkout the CLI keeps
 * for a user who installed it from npm and has no clone. What the CLI adds
 * is everything around the script that a first run tripped over — Docker
 * not installed or not started, a port held by another dev server — and the
 * two things the script's own banner could only tell the user to do by hand:
 * pointing `cmpatch` at the stack and opening the dashboard.
 */

import { join } from "node:path";

import { PRODUCT_NAME } from "../../branding";
import {
  loadCliConfig,
  loadProjectConfig,
  saveCliConfig,
} from "../../configStore";
import { createProgress } from "../../progress";
import { LOCAL_EVAL_UP_MILESTONES } from "../../remoteOutput";
import { getCliVersion } from "../../version";
import {
  confirmFinishStep,
  notice,
  offerBrowserOpen,
  paletteFor,
} from "../selfhostInstall/ask";
import {
  canAsk,
  parseArgs,
  readBooleanFlag,
  type FlagShape,
  type ParsedArgs,
} from "../selfhostSession";
import { runRenderedScript } from "../scriptRunner";
import { UsageError, type CommandDeps } from "../shared";
import { ensureDocker, probeDocker } from "./docker";
import { recoverMissingContainers } from "./recovery";
import { captureLocal } from "./process";
import { checkPorts, EVAL_PORTS } from "./ports";
import {
  composeArgs,
  composeProject,
  ensureCheckout,
  isCheckout,
  resolveCheckout,
  UP_SCRIPT,
  type Checkout,
} from "./source";

const VERBS = ["up", "down", "status"] as const;
type Verb = (typeof VERBS)[number];

export const LOCAL_EVAL_USAGE = `Usage: cmpatch selfhost local-eval [${VERBS.join("|")}] [flags]`;

const LOCAL_EVAL_FLAGS = {
  "--checkout": "value",
  "--delete-data": "boolean",
  "--install-docker": "boolean",
  "--non-interactive": "boolean",
  "--start-docker": "boolean",
} as const satisfies FlagShape;

/** What up.sh publishes — pinned there, on 127.0.0.1. */
export const DASHBOARD_URL = "http://localhost:8080";
export const SERVER_URL = "http://localhost:3000";
const MINIO_CONSOLE_URL = "http://localhost:9101";
const LOCAL_ADMIN_EMAIL = "local-admin@example.com";
const SEEDED_TOKEN = "cm_pat_local-dev-token-change-me-00000001";

const LABEL = "cmpatch selfhost local-eval";

export async function runLocalEval(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, LOCAL_EVAL_FLAGS);
  const verb = takeVerb(parsed);

  switch (verb) {
    case "up":
      return runUp(deps, parsed);
    case "down":
      return runDown(deps, parsed);
    case "status":
      return runStatus(deps, parsed);
  }
}

function takeVerb(parsed: ParsedArgs): Verb {
  const [verb, ...extra] = parsed.positionals;
  if (verb === undefined) {
    return "up";
  }
  if (extra.length > 0 || !isVerb(verb)) {
    throw new UsageError(LOCAL_EVAL_USAGE);
  }
  return verb;
}

function isVerb(value: string): value is Verb {
  return (VERBS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

async function runUp(deps: CommandDeps, parsed: ParsedArgs): Promise<string> {
  const startedAt = deps.now();
  // The tree opens before anything is said or asked, so the welcome and the
  // Docker questions sit inside it rather than above a bracket that would
  // appear with the first step. The header carries the version: a report of
  // what went wrong starts with which cmpatch it was.
  const progress = createProgress({
    intro: "at-start",
    label: LABEL,
    stderr: deps.stderr,
    title: `${PRODUCT_NAME} · ${LABEL} ${paletteFor(deps).dim(getCliVersion())}`,
  });

  let started = false;
  let defaulted = false;
  try {
    // Before the first step, for someone at the terminal: what this brings
    // up, that none of it leaves this machine, and that the first run takes
    // minutes — so the build that follows is expected rather than watched.
    if (canAsk(deps, parsed)) {
      notice(deps, renderWelcome());
    }

    progress.write("checking Docker");
    await ensureDocker(deps, {
      parsed,
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      progress,
    });

    const checkout = resolveCheckout(deps, parsed);
    await ensureCheckout(deps, progress, checkout);
    await recoverMissingContainers(deps, progress, checkout);
    await checkPorts(deps, progress, checkout.path);

    for (let attempt = 0; ; attempt += 1) {
      try {
        await runRenderedScript(deps, {
          interruptNotice: (logPath) => [
            "The stack may be partly started.",
            ...(logPath !== undefined ? [`Full log: ${logPath}`] : []),
            "Run the same command again to finish, or `cmpatch selfhost local-eval down` to stop it.",
          ],
          launch: (onOutput) =>
            deps.runProcess({
              // --skip-cli: the script's last step installs the CLI from the
              // checkout, which for the CLI running it would mean replacing
              // itself. --no-banner: the banner is rendered below, with commands
              // written for a CLI user rather than for the clone-and-run path.
              args: [
                join(checkout.path, UP_SCRIPT),
                "--skip-cli",
                "--no-banner",
              ],
              command: "bash",
              env: {
                ...deps.env,
                COMPOSE_PROJECT_NAME: composeProject(deps.env),
              },
              onOutput,
            }),
          milestones: LOCAL_EVAL_UP_MILESTONES,
          name: "local-eval",
          prefix: "[local-eval] ",
          progress,
          wording: {
            subject: "the bring-up script",
            tailHeading: "Last output:",
          },
        });
        break;
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof Error) ||
          !/no such (?:object|container)/iu.test(error.message) ||
          !(await recoverMissingContainers(deps, progress, checkout))
        )
          throw error;
      }
    }
    started = true;

    // The stack is up; what is left are questions, and they belong inside
    // the tree the steps drew: asked over a settled step, with the closing
    // line after the last answer rather than before the first question,
    // where it left the questions floating under a closed bracket.
    progress.settle();
    defaulted = await adoptDefaultServer(deps, parsed);
    await offerDashboard(deps, parsed);

    progress.stop(
      `The local evaluation stack is ready (${formatElapsed(deps.now() - startedAt)}).`,
    );
  } catch (error) {
    // Two different failures: a stack that never came up, and one that is
    // running while something after it — a config write, say — did not
    // finish. The second must not be reported as the first.
    progress.fail(
      started
        ? "The local evaluation stack is running, but the steps after it did not finish."
        : "The local evaluation stack could not be started.",
    );
    throw error;
  }

  return renderBanner({ defaulted });
}

function renderWelcome(): string[] {
  return [
    `Welcome! This command brings the ${PRODUCT_NAME} evaluation stack up on this machine with Docker, for trying the product: the server, the dashboard, and a seeded demo app, all on localhost with sign-in disabled.`,
    `The first run downloads the source and builds the images, which takes a few minutes; later runs take seconds. It needs Docker and ports ${listPorts()} free, and it asks before installing or starting anything.`,
  ];
}

function listPorts(): string {
  const ports = EVAL_PORTS.map(String);
  return `${ports.slice(0, -1).join(", ")} and ${ports[ports.length - 1] ?? ""}`;
}

/** `4m 12s`, `38s` — the closing line's measure of the whole run. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0
    ? `${String(seconds)}s`
    : `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * The dashboard, offered — with what to do on it said first, because the
 * user who says yes is looking at the browser from then on, not at the
 * banner that prints here afterwards. The sign-in itself stays with the
 * user: that flow is part of what is being evaluated.
 *
 * Not offered over SSH. Every port the stack publishes is bound on the
 * machine this runs on, so a browser opened from here would reach the wrong
 * localhost; the printed address, and how to forward it, is the whole answer.
 */
async function offerDashboard(deps: CommandDeps, parsed: ParsedArgs): Promise<void> {
  if (!canAsk(deps, parsed)) {
    return;
  }

  if (isSshSession(deps.env)) {
    notice(deps, [
      `This is an SSH session, so ${DASHBOARD_URL} is on the machine you are logged in to, not on the one your browser runs on.`,
      `To open the dashboard from there, forward the port first: ssh -L 8080:localhost:8080 <this machine>, then open ${DASHBOARD_URL}.`,
    ]);
    return;
  }

  await offerBrowserOpen(deps, {
    // Once the stack is up, Ctrl+C on this question means "not now", the
    // same as declining: the command's work is done and must not be reported
    // as failed over it.
    abort: "decline",
    lead: `The dashboard is at ${DASHBOARD_URL}. Sign in as ${LOCAL_ADMIN_EMAIL} — it is prefilled, one click.`,
    message: "Open the dashboard in your browser?",
    url: DASHBOARD_URL,
  });
}

/** Whether this terminal is at the far end of an ssh connection. */
export function isSshSession(env: Record<string, string | undefined>): boolean {
  return ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"].some(
    (name) => (env[name] ?? "").trim().length > 0,
  );
}

/**
 * Points `cmpatch` at the stack, so the banner's commands work as printed —
 * and returns whether they actually will.
 *
 * Only an empty user-level default is taken silently. A machine that already
 * names a server — someone evaluating next to a real deployment — is asked,
 * because a `release create` that quietly went to localhost instead of
 * production is worse than one extra question; and a scripted run keeps what
 * it had. The user-level default is not the last word, though: the
 * environment and the project config of the directory this runs in outrank
 * it (the order localContext.ts applies), so a run from inside an app that
 * names its own server is told that server still wins, and the commands
 * shown carry `--server-url` — there is nothing to ask in that case.
 */
async function adoptDefaultServer(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<boolean> {
  const override = await serverOverride(deps);
  const config = await loadCliConfig({ env: deps.env });

  if (config.serverUrl === undefined) {
    await saveCliConfig({ ...config, serverUrl: SERVER_URL }, { env: deps.env });
    if (override === null) {
      notice(
        deps,
        `cmpatch commands now default to ${SERVER_URL} (change it with \`cmpatch config set server-url <url>\`).`,
      );
    }
  } else if (config.serverUrl !== SERVER_URL && override === null) {
    if (!canAsk(deps, parsed)) {
      notice(
        deps,
        `cmpatch commands keep defaulting to ${config.serverUrl}; pass --server-url ${SERVER_URL} to use the evaluation stack.`,
      );
      return false;
    }

    // Said before it is asked: the question decides a machine-wide default,
    // and the address alone does not say that the stack is a second server
    // next to the one this machine already uses. Default no, deliberately:
    // a `release create` that quietly went to localhost instead of
    // production is worse than one declined question. Once the stack is up,
    // Ctrl+C here means what "No" means.
    notice(
      deps,
      [
        `cmpatch commands on this machine default to ${config.serverUrl} when a project does not name its own server.`,
        `The evaluation stack is a second server, at ${SERVER_URL}; commands meant for it need that default, or --server-url on each one.`,
      ].join(" "),
    );
    const agreed = await confirmFinishStep(deps, {
      initial: false,
      message: `Make ${SERVER_URL} the default server for cmpatch on this machine?`,
    });
    if (!agreed) {
      return false;
    }

    await saveCliConfig({ ...config, serverUrl: SERVER_URL }, { env: deps.env });
  }

  if (override !== null && override.value !== SERVER_URL) {
    notice(
      deps,
      `${override.source} sets the server to ${override.value}, which outranks the default; pass --server-url ${SERVER_URL} to cmpatch commands run from here to reach the evaluation stack.`,
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
async function effectiveServerUrl(deps: CommandDeps): Promise<string | undefined> {
  const override = await serverOverride(deps);
  if (override !== null) {
    return override.value;
  }
  return (await loadCliConfig({ env: deps.env })).serverUrl;
}

/**
 * What the user needs right after the stack is up, and nothing else: where
 * it is, how to run the guided demo, how to sign in separately, and how to
 * stop it. The demo handles sign-in and uses the evaluation checkout.
 * Everything else up.sh's banner prints — MinIO, the seeded token, the
 * sample release command — is reference material, and `status` is where it
 * lives. The spinner has already said the stack is ready, so there is no
 * title.
 */
export function renderBanner(input: { defaulted: boolean }): string {
  const serverNote = input.defaulted
    ? "cmpatch commands now default to it"
    : `pass --server-url ${SERVER_URL} to cmpatch commands`;
  const login = input.defaulted
    ? "cmpatch login"
    : `cmpatch login --server-url ${SERVER_URL}`;

  return [
    `Dashboard  ${DASHBOARD_URL}  (sign in as ${LOCAL_ADMIN_EMAIL}, one click)`,
    `API        ${SERVER_URL}  (${serverNote})`,
    "",
    "Optional demo: cmpatch demo  (watch an update apply on a simulator or emulator; includes sign-in)",
    `CLI sign-in: ${login}`,
    "Stop: cmpatch selfhost local-eval down",
    "",
    "Evaluation only — no authentication, localhost only.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

async function runDown(deps: CommandDeps, parsed: ParsedArgs): Promise<string> {
  const checkout = resolveCheckout(deps, parsed);
  if (!(await isCheckout(deps, checkout.path))) {
    return "Nothing to stop: the evaluation stack has not been set up on this machine.";
  }

  if ((await probeDocker(deps)) !== "ready") {
    return "Docker is not running, so the evaluation stack is not running either.";
  }

  const deleteData = await confirmDeleteData(deps, parsed);
  const progress = createProgress({ label: LABEL, stderr: deps.stderr });
  try {
    progress.write(
      deleteData
        ? "stopping the stack and deleting its data"
        : "stopping the stack",
    );
    await runRenderedScript(deps, {
      interruptNotice: (logPath) => [
        "The stack may be partly stopped.",
        ...(logPath !== undefined ? [`Full log: ${logPath}`] : []),
        "Run the same command again to finish.",
      ],
      launch: (onOutput) =>
        deps.runProcess({
          args: [
            ...composeArgs(checkout.path, deps.env),
            "down",
            ...(deleteData ? ["--volumes"] : []),
          ],
          command: "docker",
          onOutput,
        }),
      milestones: [],
      name: "local-eval-down",
      prefix: "[local-eval] ",
      progress,
      wording: { subject: "docker compose", tailHeading: "Last output:" },
    });
    progress.stop(
      deleteData
        ? "Stopped the evaluation stack and deleted its data."
        : "Stopped the evaluation stack.",
    );
  } catch (error) {
    progress.fail("The evaluation stack could not be stopped.");
    throw error;
  }

  return deleteData
    ? "The evaluation stack is stopped and its data is gone. `cmpatch selfhost local-eval` starts it again from scratch."
    : "The evaluation stack is stopped; its data is kept for the next `cmpatch selfhost local-eval`. Pass --delete-data to remove it too.";
}

async function confirmDeleteData(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<boolean> {
  if (readBooleanFlag(parsed, "--delete-data")) {
    return true;
  }
  if (!canAsk(deps, parsed)) {
    return false;
  }

  return (
    (await deps.confirm?.({
      initial: false,
      message:
        "Also delete the stack's data (its database and stored bundles)?",
    })) ?? false
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * The reference view: everything the ready banner leaves out. This is the
 * "where were those URLs again" command, so it carries the seeded token, the
 * sample release, and the on-device demo alongside the services' state.
 */
async function runStatus(deps: CommandDeps, parsed: ParsedArgs): Promise<string> {
  const checkout = resolveCheckout(deps, parsed);
  if (!(await isCheckout(deps, checkout.path))) {
    return "The evaluation stack has not been set up on this machine. Run `cmpatch selfhost local-eval` to start it.";
  }

  const docker = await probeDocker(deps);
  if (docker !== "ready") {
    return `Docker is ${docker === "missing" ? "not installed" : "not running"}, so the evaluation stack is not running.`;
  }

  const services = await listServices(deps, checkout);
  const ready = await stackReady(deps);
  const revision = await checkoutRevision(deps, checkout);
  const serverFlag =
    (await effectiveServerUrl(deps)) === SERVER_URL
      ? ""
      : ` --server-url ${SERVER_URL}`;
  const bundle = join(
    checkout.path,
    "examples/local-dev/bundles/ios-hermes-v1.zip",
  );

  return [
    `Dashboard   ${DASHBOARD_URL}  ${ready ? "ready" : "not answering"}`,
    `            sign in as ${LOCAL_ADMIN_EMAIL} (prefilled, one click)`,
    `API         ${SERVER_URL}`,
    `MinIO       ${MINIO_CONSOLE_URL}  (minio / minio12345)`,
    `Source      ${checkout.path}${revision === null ? "" : `  (${revision})`}`,
    "",
    "Services",
    ...(services.length > 0
      ? services.map((service) => `  ${service.name.padEnd(12)}${service.status}`)
      : ["  none running — run `cmpatch selfhost local-eval` to start the stack"]),
    "",
    "Seeded API token (scripting / CI)",
    `  ${SEEDED_TOKEN}`,
    "",
    "Publish a sample release to the seeded demo app",
    `  cmpatch login${serverFlag}`,
    `  cmpatch release create${serverFlag} \\`,
    "    --app demo-app-ios --deployment cli-smoke-test \\",
    `    --bundle-path ${bundle} \\`,
    "    --target-binary-version 1.0.0 --fingerprint local-dev-fingerprint",
    "",
    "Optional: see an update apply on a device (simulator / emulator)",
    "  cmpatch demo  (includes sign-in, setup, and the OTA walkthrough)",
    `  Source: ${join(checkout.path, "examples/on-device-demo")}/`,
    "",
    "Stop: cmpatch selfhost local-eval down",
  ].join("\n");
}

async function listServices(
  deps: CommandDeps,
  checkout: Checkout,
): Promise<Array<{ name: string; status: string }>> {
  const listing = await captureLocal(deps, {
    args: [
      ...composeArgs(checkout.path, deps.env),
      "ps",
      "--format",
      "{{.Service}}\t{{.Status}}",
    ],
    command: "docker",
  });
  if (listing.exitCode !== 0) {
    return [];
  }

  return listing.output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = "", ...status] = line.split("\t");
      return { name, status: status.join(" ") };
    });
}

/**
 * Which source the stack was built from, for the report of something that
 * went wrong: the CLI's version is in the header, and this is its other half.
 */
async function checkoutRevision(
  deps: CommandDeps,
  checkout: Checkout,
): Promise<string | null> {
  const head = await captureLocal(deps, {
    args: ["-C", checkout.path, "rev-parse", "--short", "HEAD"],
    command: "git",
  });
  if (head.spawnError !== null || head.exitCode !== 0) {
    return null;
  }
  const revision = head.output.trim();
  return revision.length > 0 ? revision : null;
}

async function stackReady(deps: CommandDeps): Promise<boolean> {
  try {
    const response = await deps.fetch(`${DASHBOARD_URL}/health/ready`);
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}
