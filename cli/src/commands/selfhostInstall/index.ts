/**
 * `cmpatch selfhost install` — the walking skeleton.
 *
 * It drives `scripts/selfhost/install.sh` on a remote host end to end, with
 * every answer supplied by flag or environment. That order is deliberate: the
 * step that proves the whole design — pairing, preflight, bootstrapping
 * Docker, and reaching a healthy server over ssh — is built and exercised
 * first, and the question-and-answer wizard is layered in front of it
 * afterwards rather than the other way round.
 *
 * Everything the command *decides* lives in `selfhostInstall.ts` as pure
 * functions; this file connects those decisions to a host.
 *
 * The rest of the run lives beside it, roughly in the order it happens:
 *
 * - `hostBootstrap.ts` — preflight, the Docker and curl/git bootstraps, the
 *   source checkout, and the start-over edge.
 * - `wizard.ts` — the recovery question, the answers a first install collects,
 *   the GitHub OAuth pair, and the repair edge.
 * - `dns.ts` — the records the user is asked to create, and the waits for them.
 * - `answers.ts` — the same answers read from flags and the environment.
 * - `cloudflare.ts` / `cloudfront.ts` — one file per CDN, each collecting its
 *   settings before the install and finishing its cutover after it.
 * - `ask.ts` — the prompt-side helpers all of the above share.
 */

import { createDnsSetup, DNS_FLAGS, dnsMode } from "./dnsSetup";
import {
  CLOUDFRONT_DOCS_URL,
  PRODUCT_NAME,
  SELFHOST_DOCS_URL,
} from "../../branding";
import { loadCliConfig, saveCliConfig } from "../../configStore";
import { normalizeServerUrl } from "../../credentialStore";
import { INSTALL_MILESTONES } from "../../remoteOutput";
import {
  buildInstallEnv,
  classifyInstallFailure,
  classifyInstallState,
  defaultRecoveryEdge,
  OAUTH_PROVIDERS,
  repairScopeFor,
  type InstallAnswers,
  type OAuthProvider,
  type InstallState,
  type RecoveryEdge,
} from "../../selfhostInstall";
import {
  describePublicAddressProblem,
  renderBeforeYouStart,
  renderCloudflareRemaining,
} from "../../selfhostSetupCopy";
import {
  readPendingInstall,
  readPendingOAuthRepair,
  withPendingOAuthRepair,
  withoutPendingOAuthRepair,
  withoutPendingInstall,
  withPendingInstall,
  withSelfhostMapping,
} from "../../selfhostTarget";
import {
  canAsk,
  COMMON_FLAGS,
  openSession,
  parseArgs,
  readBooleanFlag,
  readStringFlag,
  RemoteScriptFailure,
  runSelfhostScript,
  takeSingleTarget,
  type FlagShape,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { createProgress } from "../../progress";
import { UsageError, type CommandDeps } from "../shared";
import { OAUTH_FLAGS, suppliedOAuthProvider } from "./answers";
import {
  confirmFinishStep,
  noteBlock,
  notice,
  onSignal,
  type FinishPhase,
} from "./ask";
import { finishCloudflare } from "./cloudflare";
import { finishCloudFront } from "./cloudfront";
import {
  ensureCheckout,
  runHostPreflight,
  startOver,
} from "./hostBootstrap";
import {
  askRecoveryEdge,
  collectAnswers,
  collectRepairValues,
} from "./wizard";

import { STORAGE_FLAGS, storageMode } from "./storage";

export { DOCKER_BOOTSTRAP_DISTROS } from "./hostBootstrap";

const INSTALL_FLAGS = {
  ...COMMON_FLAGS,
  ...STORAGE_FLAGS,
  ...DNS_FLAGS,
  /**
   * Recognised only to be refused with directions: install.sh's plain-HTTP
   * mode serves the machine the stack runs on alone, which an ssh install
   * of a server other machines reach can never be. See runInstall.
   */
  "--allow-http": "boolean",
  "--api-domain": "value",
  "--cloudflare": "boolean",
  "--cloudflare-api-token": "value",
  "--cloudflare-zone-id": "value",
  "--cloudfront": "boolean",
  "--cloudfront-access-key-id": "value",
  "--cloudfront-distribution-id": "value",
  "--cloudfront-origin-verify-secret": "value",
  "--cloudfront-secret-access-key": "value",
  /** The irreversible half of `--start-over`; see readRequestedEdge. */
  "--discard-data": "boolean",
  "--email": "value",
  ...OAUTH_FLAGS,
  "--install-curl": "boolean",
  "--install-docker": "boolean",
  "--install-git": "boolean",
  /** The address the DNS records point at, when the server cannot report it. */
  "--public-ip": "value",
  "--remote-path": "value",
  "--repair": "boolean",
  "--resume": "boolean",
  "--skip-cloudflare-check": "boolean",
  "--skip-cloudfront-check": "boolean",
  "--skip-memory-check": "boolean",
  "--skip-port-check": "boolean",
  "--skip-public-check": "boolean",
  "--start-over": "boolean",
  "--storage-domain": "value",
  "--storage-origin-domain": "value",
  "--yes": "boolean",
} as const satisfies FlagShape;

/**
 * What the install leaves the caller with. `cmpatch selfhost install` prints
 * the summary and is done; `cmpatch init` hands off to this command and then
 * carries on with the URL it installed.
 */
export type InstallOutcome = {
  /**
   * The administrator address this run collected, when it collected one: the
   * first sign-in has to use the provider account that owns it, and the run that
   * asked for it is the only thing that can say so.
   */
  adminEmail?: string;
  serverUrl: string | null;
  /**
   * The provider this run configured, as the summary names it ("GitLab at
   * https://gitlab.example.com"), when it configured one.
   */
  signInProvider?: string;
  summary: string;
};

export type InstallOptions = {
  /**
   * `cmpatch init` handing off, rather than a standalone run.
   *
   * One flag for one fact, because everything it changes follows from it: the
   * user chose "install" over the server this machine already knows, so a
   * host recorded for that server is not offered but asked past — and init
   * signs the user in itself, so the summary must not hand them
   * `cmpatch login` as the next thing to do.
   */
  handoff?: boolean;
};

export async function runInstall(
  deps: CommandDeps,
  argv: readonly string[],
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const parsed = parseArgs(argv, INSTALL_FLAGS);
  const sshTarget = takeSingleTarget(parsed, "install");
  const requestedEdge = readRequestedEdge(parsed);
  storageMode(parsed);
  dnsMode(parsed);
  suppliedOAuthProvider(deps, parsed);
  const publicIp = readPublicIp(parsed);
  const remotePath = readStringFlag(parsed, "--remote-path");
  // Rejected before anything connects: install.sh refuses the pair too, but
  // twenty minutes and one pairing later.
  if (
    readBooleanFlag(parsed, "--cloudflare") &&
    readBooleanFlag(parsed, "--cloudfront")
  ) {
    throw new UsageError(
      "Cloudflare and CloudFront are alternative CDNs; pass only one of --cloudflare or --cloudfront.",
    );
  }

  // Plain HTTP (install.sh --allow-http) serves the machine the stack runs on
  // alone — the API site is localhost — while this command sets up, over ssh,
  // a server other machines reach. The two never meet: a localhost-only
  // server on a remote host is unreachable from here, and a server other
  // machines reach needs the certificate, DNS, and open ports the https
  // install is built around. Refused before anything connects, naming the
  // two commands that do cover the local case.
  if (readBooleanFlag(parsed, "--allow-http")) {
    throw new UsageError(
      [
        "--allow-http is not available here: plain HTTP serves only the machine the stack runs on (as localhost), and cmpatch selfhost install sets up a server other machines reach — which needs HTTPS.",
        "",
        "To run the real self-host stack on this machine over plain HTTP, run scripts/selfhost/install.sh --allow-http from a clone here. For a quick evaluation with no OAuth app, use cmpatch selfhost local-eval.",
      ].join("\n"),
    );
  }

  // The step tree opens here, before anything is said or asked, so the
  // opening notice and the ssh questions sit inside it rather than above a
  // bracket that would otherwise appear once they were answered. From here on
  // this function owns it: every exit path below reaches stop or fail. On a
  // handoff the tree is init's, opened with its welcome, and the steps here
  // continue it: a second bracket would read as a second command starting.
  const progress = createProgress({
    intro: options.handoff === true ? "inherited" : "at-start",
    label: "cmpatch selfhost install",
    ...(deps.stderr !== undefined ? { stderr: deps.stderr } : {}),
  });

  let dnsSetup: ReturnType<typeof createDnsSetup> | undefined;
  try {
    // Before the ssh question, so the list of what the run will need from
    // outside this terminal is read before any of it is asked for. Not on a
    // recovery edge: that is a rerun, by someone who has seen it.
    if (requestedEdge === undefined && canAsk(deps, parsed)) {
      noteBlock(deps, "Before you start", renderBeforeYouStart());
    }

    // A recovery edge names the interrupted install, and that lives on the
    // recorded host: there is nothing to choose. Otherwise a recorded host is
    // offered, or on the init path skipped past — see `recordedTarget`.
    const recordedTarget =
      options.handoff === true
        ? ("ask-new" as const)
        : requestedEdge === undefined
          ? ("offer" as const)
          : undefined;
    const session = await openSession(deps, {
      label: "cmpatch selfhost install",
      mode: "install",
      parsed,
      progress,
      ...(recordedTarget !== undefined ? { recordedTarget } : {}),
      ...(remotePath !== undefined ? { remotePath } : {}),
      ...(sshTarget !== undefined ? { sshTarget } : {}),
    });

    const config = await loadCliConfig({ env: deps.env });
    const state = classifyInstallState({
      facts: session.facts,
      pendingInstall: readPendingInstall(config, session.sshTarget),
      pendingOAuthRepair: readPendingOAuthRepair(config, session.sshTarget),
    });

    if (state.kind === "installed" && requestedEdge !== "repair") {
      // Reconciled from the server's own facts, not merely tidied up. A
      // healthy install ends any pending-install story however it finished —
      // a record left by an interrupted run must not outlive a recovery made
      // out-of-band, since it is the one piece of evidence that later turns a
      // deployment that is merely down into an "incomplete" install with a
      // start-over edge on offer. But the same interrupt (or an install run
      // from another machine) is also why this machine can be looking at a
      // healthy server it has no active URL for, so the identity is committed
      // here too rather than only on the path that installed it.
      const serverUrl = await commitServerIdentity(
        deps,
        session,
        parsed,
        undefined,
        options,
      );

      session.progress.stop("Already installed.");
      return {
        serverUrl,
        summary: renderAlreadyInstalled(
          session,
          serverUrl,
          remainingForRecordedAdapter(session),
        ),
      };
    }

    if (state.kind === "unknown-unhealthy") {
      // State (d). Every mutating edge is refused *regardless of the flags*:
      // this is far more likely a deployment that installed fine and is down
      // right now than a half-finished install, and the CLI has no evidence
      // either way.
      throw new UsageError(renderUnknownUnhealthy(session, state.serverUrl));
    }

    if (
      state.kind === "oauth-repair" &&
      requestedEdge !== undefined &&
      requestedEdge !== "repair"
    ) {
      throw new UsageError(
        "This server has a pending OAuth repair. Use --repair to correct only the OAuth credentials; resume and start-over are not available.",
      );
    }

    const oauthRepair = state.kind === "installed" || state.kind === "oauth-repair";
    const interactive = canAsk(deps, parsed);
    dnsSetup = createDnsSetup(deps, parsed, interactive, session.progress);
    session.dnsSetup = dnsSetup;

    // Before the recovery question, not after: the host checks are the same
    // whichever edge is taken, one of them can end the run outright, and the
    // start-over edge below cannot remove a stack without a working Docker.
    await runHostPreflight(deps, session, parsed);
    // The flag wins over the survey: it exists for the hosts whose survey
    // answer is wrong or empty, and the DNS step reads the address from here.
    if (publicIp !== undefined && session.facts.install !== undefined) {
      session.facts.install.publicIp = publicIp;
    }
    await ensureCheckout(deps, session);

    let edge: RecoveryEdge | null =
      oauthRepair
        ? "repair"
        : state.kind === "incomplete"
          ? (requestedEdge ??
            (interactive
              ? await askRecoveryEdge(deps, session, state)
              : defaultRecoveryEdge(state.failure)))
          : null;

    const startedOver = edge === "start-over";
    if (startedOver) {
      await startOver(deps, session, parsed, interactive);
      // The env file is gone, so this is a first install again — including the
      // questions, which the resume and repair edges deliberately skip.
      edge = null;
    }

    // Kept, not just serialized: the CloudFront cutover needs the distribution
    // domain, which install.sh has no setting for and so never appears in the
    // environment below.
    const answers =
      edge === null
        ? await collectAnswers(deps, session, parsed, interactive)
        : null;

    // `--repair` from the flag skips askRecoveryEdge — the only settle on this
    // path — so the survey/checkout spinner would still be animating under the
    // repair questions.
    if (edge === "repair") {
      session.progress.settle();
    }

    const scriptEnv =
      edge === "resume"
        ? // The whole point of the resume edge: replay the env the previous
          // run wrote, collecting nothing. Passing values here would be
          // ignored by install.sh anyway, which is what makes state (c)
          // absorbing without the repair edge.
          {}
        : edge === "repair"
          ? await collectRepairValues(
              deps,
              session,
              parsed,
              interactive,
              oauthRepair
                ? "oauth-only"
                : state.kind === "incomplete"
                  ? repairScopeFor(state.failure)
                  : "all",
            )
          : buildInstallEnv(answers as InstallAnswers);

    const args = ["-y"];
    if (edge === "repair") {
      args.push("--repair-env");
    }
    for (const flag of [
      "--skip-cloudflare-check",
      "--skip-cloudfront-check",
      "--skip-public-check",
      "--skip-storage-check",
    ] as const) {
      if (readBooleanFlag(parsed, flag)) {
        args.push(flag);
      }
    }

    // Existing-server repairs use a separate record so failures or interrupts
    // cannot expose unfinished-install recovery.
    // Written *before* the first invocation and cleared on completion: it is
    // the only evidence that distinguishes state (c) from state (d), so a run
    // interrupted between here and the end must leave it behind.
    //
    // The previous record's fields are carried over, not replaced: `startedAt`
    // is when the install began (recordFailure's own contract), and the
    // recorded failure keeps selecting the right recovery default until a new
    // outcome replaces it — a rerun interrupted before any outcome must not
    // degrade "repair the OAuth pair" back to "resume". Only a start-over
    // discards them, because that install is gone.
    //
    // An OAuth-repair record is only ever cleared by success or a healthy
    // observation, so a failed repair leaves it behind; a run that is not one
    // (the env file is gone: a fresh install) drops it here, or it would
    // force the next unhealthy rerun onto `--repair-env`.
    const loaded = await loadCliConfig({ env: deps.env });
    const startConfig = oauthRepair ? loaded : withoutPendingOAuthRepair(loaded, session.sshTarget);
    const prior = startedOver
      ? undefined
      : oauthRepair
        ? readPendingOAuthRepair(startConfig, session.sshTarget)
        : readPendingInstall(startConfig, session.sshTarget);
    await saveConfig(
      deps,
      (oauthRepair ? withPendingOAuthRepair : withPendingInstall)(startConfig, session.sshTarget, {
        ...(prior?.failure !== undefined ? { failure: prior.failure } : {}),
        identityFile: session.identityFile,
        startedAt: prior?.startedAt ?? new Date(deps.now()).toISOString(),
      }),
    );

    try {
      await runSelfhostScript(deps, session, {
        args,
        env: scriptEnv,
        milestones: INSTALL_MILESTONES,
        name: "install",
        script: "install.sh",
      });
    } catch (error) {
      if (!oauthRepair) {
        await recordFailure(deps, session, error);
      }
      throw error;
    }

    const serverUrl = await commitServerIdentity(
      deps,
      session,
      parsed,
      scriptEnv.CODEMAGIC_PATCH_API_DOMAIN,
      options,
    );

    // One hook for the whole finish phase, on top of the per-wait ones.
    //
    // The waits are not the only place a Ctrl+C can land here: between them
    // the phase runs probes and checks that animate a spinner of their own,
    // and under clack an animating spinner with nobody listening answers the
    // key by ending the process — success code, no summary, and through
    // `cmpatch init` no sign-in either. Registered for the phase's whole
    // duration, this is who the press reaches there, and it means what
    // declining the step means: stop asking, and carry what is left into the
    // closing summary. A wait's own hook is nested inside it and takes the
    // press first, so "stop waiting" still stops only the waiting.
    let stopped = false;
    const removeFinishHook = onSignal(session, () => {
      stopped = true;
    });

    // Only after the server is healthy, and only on a first install: the
    // record has to stay grey-clouded until Caddy has its certificate, so
    // this is the earliest the switch can be asked for.
    let remaining: string[];
    try {
      remaining = await finishDelivery(deps, session, parsed, {
        answers,
        interactive,
        phase: { stopped: () => stopped },
      });
    } finally {
      removeFinishHook();
    }

    dnsSetup.dispose();
    session.progress.stop("Install complete.");
    const signInProvider = describeConfiguredProvider(scriptEnv);
    return {
      ...(answers === null ? {} : { adminEmail: answers.adminEmail }),
      serverUrl,
      ...(signInProvider === undefined ? {} : { signInProvider }),
      summary: renderCompletion(serverUrl, remaining, options, signInProvider),
    };
  } catch (error) {
    // Idempotent over openSession's own fail: the tree closes once, with
    // this message when the failure is this command's to name.
    progress.fail("Install failed.");
    throw error;
  } finally {
    dnsSetup?.dispose();
  }
}

/**
 * `--public-ip`, held to the same check the typed answer gets, before anything
 * connects: a scripted run that passes a private or malformed address would
 * otherwise print it into the records and wait for it.
 */
function readPublicIp(parsed: ParsedArgs): string | undefined {
  const value = readStringFlag(parsed, "--public-ip");
  if (value === undefined) {
    return undefined;
  }

  const problem = describePublicAddressProblem(value);
  if (problem !== null) {
    throw new UsageError(`${problem}\n\nCorrect the value passed as --public-ip and run the command again.`);
  }

  return value;
}

// ---------------------------------------------------------------------------
// Which edge a rerun takes
// ---------------------------------------------------------------------------

/**
 * `--start-over` and `--discard-data` are two flags for one action on purpose.
 * "Start over" is a soft phrase a user reaches for when they only mean "try
 * again", and this edge deletes the database and the release files; the second
 * flag is the one that says out loud what is lost. The wizard replaces it with
 * a typed confirmation, the same gate `restore` uses.
 */
function readRequestedEdge(parsed: ParsedArgs): RecoveryEdge | undefined {
  const requested = (
    [
      ["--repair", "repair"],
      ["--resume", "resume"],
      ["--start-over", "start-over"],
    ] as const
  ).filter(([flag]) => readBooleanFlag(parsed, flag));

  if (requested.length > 1) {
    throw new UsageError(
      "Pass only one of --resume, --repair, or --start-over.",
    );
  }

  const edge = requested[0]?.[1];
  if (edge === "start-over" && !readBooleanFlag(parsed, "--discard-data")) {
    throw new UsageError(
      [
        "--start-over deletes this server's database and every release file it holds, and that cannot be undone.",
        "",
        "Add --discard-data to confirm, or use --resume to continue the interrupted install instead.",
      ].join("\n"),
    );
  }

  return edge;
}

/**
 * Whatever the chosen CDN still needs, once the server is healthy. Returns
 * what is left for the closing summary; nothing here can fail the command,
 * because downloads are already being served from the server itself.
 */
async function finishDelivery(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: {
    answers: InstallAnswers | null;
    interactive: boolean;
    phase: FinishPhase;
  },
): Promise<string[]> {
  if (input.answers?.storage && input.answers.storage.kind !== "bundled") {
    const storage = input.answers.storage;
    return [...(input.answers.storageWarnings ?? []), `Storage: ${storage.kind.toUpperCase()}; public bucket ${storage.publicBucket}; internal bucket ${storage.internalBucket}.`, `Verified download URL: ${storage.publicBaseUrl}`, "Storage, delivery and privacy probes passed. After signing in and creating a token, run ./scripts/selfhost/smoke.sh on the server with CODEMAGIC_PATCH_TOKEN set to verify an authenticated release."];
  }
  const delivery = input.answers?.delivery;
  if (delivery === undefined) {
    // The resume and repair edges collect no answers, so there is no selection
    // to finish — but the deployment may still be mid-way through a CDN setup
    // it was interrupted during, and its own env file is the authority on that.
    return remainingForRecordedAdapter(session);
  }

  if (delivery.kind === "none") {
    return [];
  }

  return delivery.kind === "cloudflare"
    ? finishCloudflare(deps, session, parsed, {
        interactive: input.interactive,
        phase: input.phase,
        storageDomain: (input.answers as InstallAnswers).storageDomain,
      })
    : finishCloudFront(deps, session, parsed, {
        delivery,
        interactive: input.interactive,
        phase: input.phase,
        storageDomain: (input.answers as InstallAnswers).storageDomain,
      });
}

/**
 * What a resumed or repaired install still owes its CDN, read from the env
 * file rather than from answers this run never collected.
 */
function remainingForRecordedAdapter(session: SelfhostSession): string[] {
  const storageDomain = session.facts.storageDomain;
  if (storageDomain === null) {
    return [];
  }

  switch (session.facts.deliveryAdapter) {
    case "cloudflare":
      return renderCloudflareRemaining(
        storageDomain,
        "If downloads are not going through Cloudflare yet:",
      );
    case "cloudfront":
      return [
        `If downloads are not going through CloudFront yet, the last step is pointing ${storageDomain} at the distribution with a CNAME.`,
        "",
        `Full guide: ${CLOUDFRONT_DOCS_URL}`,
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Completion and reporting
// ---------------------------------------------------------------------------

/**
 * The install's local half: the ssh mapping, and the active server URL that
 * makes the `cmpatch login` this command prints work at all.
 *
 * Run the moment the server is healthy and *before* the delivery finish steps
 * (plan rev 21: the server URL is persisted before anything that can be
 * interrupted). Those steps prompt, poll DNS, and can wait on a console visit,
 * so they are exactly where a Ctrl+C lands — and every remote component is
 * healthy by then. The only thing such an interrupt could still cost is local
 * state, which is why none of it is left until afterwards.
 */
async function commitServerIdentity(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  apiDomain: string | undefined,
  options: InstallOptions,
): Promise<string | null> {
  // install.sh's last milestone can leave its spinner animating, and the
  // adopt-this-server question below must not draw under it.
  session.progress.settle();

  // On the resume and repair edges the CLI was given no domain at all, so the
  // env file the server already holds is the only authority for the URL.
  const serverUrl =
    apiDomain === undefined ? session.facts.serverUrl : `https://${apiDomain}`;

  let config = withoutPendingInstall(
    withoutPendingOAuthRepair(
      await loadCliConfig({ env: deps.env }),
      session.sshTarget,
    ),
    session.sshTarget,
  );

  if (serverUrl !== null) {
    config = withSelfhostMapping(config, serverUrl, {
      identityFile: session.identityFile,
      remotePath: session.remotePath,
      sshTarget: session.sshTarget,
    });

    // The mapping is keyed *by* server URL but is not a source of one: the
    // effective URL resolves env -> project config -> user config. Writing only
    // the mapping would leave a machine that just installed a server with no
    // active URL, and the `cmpatch login` this command prints would drop the
    // user straight back into server discovery.
    if (
      await shouldAdoptServerUrl(
        deps,
        parsed,
        config.serverUrl,
        serverUrl,
        options,
      )
    ) {
      config = { ...config, serverUrl: safeNormalize(serverUrl) };
    }
  }

  await saveConfig(deps, config);

  return serverUrl;
}

/**
 * Asked, not assumed: a machine that already talks to another server must not
 * have it replaced silently by an install run for someone else. With no
 * current server there is nothing to lose, so it is adopted without a question.
 */
async function shouldAdoptServerUrl(
  deps: CommandDeps,
  parsed: ParsedArgs,
  current: string | undefined,
  installed: string,
  options: InstallOptions,
): Promise<boolean> {
  if (current === undefined || current === safeNormalize(installed)) {
    return true;
  }

  // Asked on the init path too. init continues against the server just
  // installed whatever the answer — it carries that URL itself, signs in to
  // it, and links the project to it — so all this decides is what projects
  // with no server of their own use from now on, and that is the machine
  // owner's call, not a side effect of setting up one more project.
  if (!canAsk(deps, parsed)) {
    // A scripted run keeps whatever the machine was pointed at; the mapping is
    // recorded either way, so `selfhost` commands still reach the new server.
    return false;
  }

  // Through the finish-phase reader: this question is asked from inside
  // `commitServerIdentity`, before the save. Letting an abort unwind from here
  // reported "Install failed." over a healthy server *and* dropped the write
  // that records how to reach it — the mapping and the cleared pending record
  // along with the URL. Read as "no", the machine keeps pointing where it did
  // and everything else is still persisted.
  // Said before it is asked: the question decides a machine-wide default, and
  // "this machine currently uses" alone reads as though the project or the
  // install itself might be pointed elsewhere by the answer.
  notice(
    deps,
    [
      `cmpatch commands on this machine default to ${current} when a project does not name its own server.`,
      // Only init has a project in hand; a standalone install has nothing
      // that "this project" could refer to.
      ...(options.handoff === true
        ? [`This project will use ${installed} either way.`]
        : []),
    ].join(" "),
  );

  return confirmFinishStep(deps, {
    initial: true,
    message: `Make ${installed} the default server for cmpatch on this machine?`,
  });
}

function safeNormalize(serverUrl: string): string {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return serverUrl;
  }
}

async function recordFailure(
  deps: CommandDeps,
  session: SelfhostSession,
  error: unknown,
): Promise<void> {
  const failure = classifyInstallFailure(
    error instanceof RemoteScriptFailure ? error.failureMessage : null,
  );

  // The record already exists; this only stamps what it failed on, which is
  // what selects the default recovery edge on the next run. `startedAt` is
  // carried over rather than restamped — the next run says "started here on
  // <date>", and that is when the install began, not when it gave up.
  const config = await loadCliConfig({ env: deps.env });
  const existing = readPendingInstall(config, session.sshTarget);

  await saveConfig(
    deps,
    withPendingInstall(config, session.sshTarget, {
      failure,
      identityFile: session.identityFile,
      startedAt: existing?.startedAt ?? new Date(deps.now()).toISOString(),
    }),
  );
}

async function saveConfig(
  deps: CommandDeps,
  config: Awaited<ReturnType<typeof loadCliConfig>>,
): Promise<void> {
  await saveCliConfig(config, { env: deps.env });
}

/**
 * "GitLab at https://gitlab.example.com": the provider the env sent to
 * install.sh configures, read back from it so an install and a repair name
 * it the same way. A resume sends none and names nothing.
 */
function describeConfiguredProvider(env: Record<string, string>): string | undefined {
  const provider = (Object.keys(OAUTH_PROVIDERS) as OAuthProvider[]).find((candidate) =>
    Object.keys(env).some((key) => key.startsWith(`${OAUTH_PROVIDERS[candidate].envPrefix}_OAUTH_`)),
  );
  if (provider === undefined) return undefined;
  const { displayName, envPrefix, extraFields } = OAUTH_PROVIDERS[provider];
  // A self-managed instance is named; the provider's default is not.
  const instance = extraFields
    .map((field) => env[`${envPrefix}_OAUTH_${field.env}`] ?? field.default)
    .find((value, index) => value !== extraFields[index].default);
  return instance === undefined ? displayName : `${displayName} at ${instance}`;
}

function renderCompletion(
  serverUrl: string | null,
  remaining: readonly string[],
  options: InstallOptions,
  signInProvider: string | undefined,
): string {
  return [
    serverUrl === null
      ? `${PRODUCT_NAME} is installed.`
      : `${PRODUCT_NAME} is installed at ${serverUrl}`,
    ...(serverUrl === null ? [] : ["", "Dashboard:", `  ${serverUrl}/`]),
    // Left out when init is driving: it opens that sign-in itself, moments
    // from now, so printing the command for it would read as something the
    // user still has to do.
    ...(options.handoff === true
      ? []
      : [
          "",
          signInProvider === undefined
            ? "Sign in to create the admin account, then connect this machine:"
            : `Sign in with ${signInProvider} to create the admin account, then connect this machine:`,
          serverUrl === null
            ? "  cmpatch login"
            : `  cmpatch login --server-url ${serverUrl}`,
        ]),
    // Anything the CDN step could not finish is carried here as a next step
    // rather than reported as a failure: the server itself is installed and
    // working, and downloads are served from it in the meantime.
    ...(remaining.length === 0 ? [] : ["", ...remaining]),
  ].join("\n");
}

function renderAlreadyInstalled(
  session: SelfhostSession,
  serverUrl: string | null,
  remaining: readonly string[],
): string {
  return [
    serverUrl === null
      ? `${session.sshTarget} already runs ${PRODUCT_NAME}, and it is healthy.`
      : `${session.sshTarget} already runs ${PRODUCT_NAME} at ${serverUrl}, and it is healthy.`,
    "",
    "To update it to the latest version:",
    "  cmpatch selfhost upgrade",
    "",
    "To install onto another host:",
    "  cmpatch selfhost install user@vps",
    // A run interrupted during the CDN finish leaves a server that is healthy
    // in every respect the health check can see, and one manual step short of
    // serving downloads through the CDN. Nothing else would ever mention it.
    ...(remaining.length === 0 ? [] : ["", ...remaining]),
  ].join("\n");
}

function renderUnknownUnhealthy(
  session: SelfhostSession,
  serverUrl: string | null,
): string {
  return [
    `${session.sshTarget} already has ${PRODUCT_NAME} set up${
      serverUrl === null ? "" : ` at ${serverUrl}`
    }, but it is not answering, or is not ready to serve, right now.`,
    "",
    "This machine has no record of starting an install here, so this looks like a server that was set up and is currently down — not a half-finished install. Nothing will be changed or deleted.",
    "",
    "What usually helps:",
    "  cmpatch selfhost upgrade      rebuild and restart the server",
    `  ${SELFHOST_DOCS_URL}`,
  ].join("\n");
}

export type { InstallState };
