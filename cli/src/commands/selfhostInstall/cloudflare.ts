/**
 * The Cloudflare branch: collecting the token and zone (on a first install and
 * as the repair unit), and turning the proxy on once the server is up.
 */

import { PRODUCT_NAME } from "../../branding";
import {
  buildTokenTemplateUrl,
  CacheRuleConflict,
  classifyProxiedResponse,
  createCacheRule,
  findZoneId,
  ORIGIN_CACHE_RULE,
  readZoneSslMode,
} from "../../providers/cloudflare";
import { DISTRIBUTION_PROBE_PATH } from "../../providers/cloudfront";
import {
  DnsPreparationError,
  enableCloudflareProxy,
  lookupCloudflareZoneId,
} from "../../providers/dns";
import { ProviderHttpError } from "../../providers/providerError";
import {
  detectDnsProvider,
  findZoneApex,
  isCloudflareEdgeAddress,
  waitForDnsRecord,
  type RecordDiagnosis,
} from "../../selfhostDns";
import { type DeliverySelection } from "../../selfhostInstall";
import {
  renderCacheRule,
  renderCacheRuleAdded,
  renderCacheRuleNextSteps,
  renderCacheRuleSteps,
  renderCloudflareRemaining,
  renderCloudflareTokenIntro,
  renderFullSslAdvice,
  renderProxiedCheckProblem,
  renderProxySwitch,
  renderProxySwitchWaitDetail,
  renderProxySwitchWaitStep,
  renderProxyUnconfirmedLeadIn,
  renderSslBlockedLeadIn,
  renderSslBlocksProxy,
  renderZoneLookupProblem,
} from "../../selfhostSetupCopy";
import {
  readBooleanFlag,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
import { supplied } from "./answers";
import {
  askValue,
  confirmFinishStep,
  notice,
  offerBrowserOpen,
  onSignal,
  paletteFor,
  type FinishPhase,
} from "./ask";
import { publicIpFromTarget, resolverFallbackWarning } from "./dns";

export async function collectCloudflare(
  deps: CommandDeps,
  parsed: ParsedArgs,
  context: {
    nameserversAreCloudflare: boolean;
    storageDomain: string;
    zone: string | null;
  },
): Promise<Extract<DeliverySelection, { kind: "cloudflare" }>> {
  const templateUrl = buildTokenTemplateUrl({
    name: `${PRODUCT_NAME} cache purge`,
  });
  const suppliedToken = supplied(deps, parsed, {
    env: "CLOUDFLARE_API_TOKEN",
    flag: "--cloudflare-api-token",
  });
  // Only when the token is about to be asked for: a run that already carries
  // it via flag or environment has nothing to do on that page.
  if (suppliedToken === undefined) {
    notice(
      deps,
      renderCloudflareTokenIntro(
        {
          storageDomain: context.storageDomain,
          templateUrl,
          zone: context.zone,
        },
        paletteFor(deps),
      ),
    );
    await offerBrowserOpen(deps, {
      message: "Open Cloudflare in your browser?",
      url: templateUrl,
    });
  }

  for (;;) {
    const apiToken =
      suppliedToken?.value ??
      (await askValue(deps, { message: "Cloudflare API token", type: "password" }));

    // The escape hatch for a token minted by hand without Zone > Read.
    const suppliedZoneId = supplied(deps, parsed, { flag: "--cloudflare-zone-id", env: "CLOUDFLARE_ZONE_ID" })?.value;
    if (suppliedZoneId !== undefined) {
      return { apiToken, kind: "cloudflare", zoneId: suppliedZoneId };
    }

    // Named in the user's terms: "zone" is Cloudflare's word, not theirs.
    notice(deps, `Checking ${context.zone ?? context.storageDomain} on your Cloudflare account…`);
    const lookup = await findZoneId({
      apiToken,
      fetch: deps.fetch,
      zoneName: context.zone ?? context.storageDomain,
    });

    if (lookup.kind === "found") {
      return { apiToken, kind: "cloudflare", zoneId: lookup.zoneId };
    }

    notice(
      deps,
      renderZoneLookupProblem({
        kind: lookup.kind,
        nameserversAreCloudflare: context.nameserversAreCloudflare,
        zone: context.zone ?? context.storageDomain,
      }),
    );

    // A token supplied by flag or environment cannot be re-asked for, so a
    // scripted run stops here rather than looping on the same value.
    if (suppliedToken !== undefined) {
      throw new UsageError(
        `Could not find ${context.zone ?? context.storageDomain} with this Cloudflare token.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The wizard: turning Cloudflare on, once the server is up
// ---------------------------------------------------------------------------

/**
 * How Cloudflare is reached for the proof-of-proxy request: the same MinIO
 * readiness path the CloudFront probes use, aliased rather than respelled so
 * the two branches cannot drift apart.
 */
const PROXY_CHECK_PATH = DISTRIBUTION_PROBE_PATH;

type FinishInput = {
  interactive: boolean;
  phase: FinishPhase;
  storageDomain: string;
};

const NOT_THROUGH_CLOUDFLARE_YET = "Downloads are not going through Cloudflare yet:";

/**
 * Returns whatever is left for the user to do, for the closing summary.
 *
 * Nothing in here can fail the command: the server is installed and healthy by
 * this point, and downloads work from it directly. What this step buys is
 * knowing whether the CDN is *actually* in front of them — without it the
 * install would report a working CDN while Cloudflare serves nothing.
 *
 * When this run wrote the storage record through the Cloudflare API, the same
 * setup token finishes the job — cache rule, SSL/TLS check, proxy switch —
 * and any step it cannot do falls back to the printed walkthrough for that
 * step alone. Otherwise the walkthrough is the whole step.
 */
export async function finishCloudflare(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: FinishInput,
): Promise<string[]> {
  const apiToken =
    (await session.dnsSetup?.cloudflareSetupToken(input.storageDomain)) ?? null;
  return apiToken === null
    ? finishCloudflareByHand(deps, session, parsed, input, { cacheRuleDone: false })
    : finishCloudflareForYou(deps, session, parsed, input, apiToken);
}

async function finishCloudflareByHand(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: FinishInput,
  state: { cacheRuleDone: boolean },
): Promise<string[]> {
  const storageDomain = input.storageDomain;
  if (!input.interactive) {
    return renderCloudflareRemaining(storageDomain, NOT_THROUGH_CLOUDFLARE_YET, {
      cacheRule: !state.cacheRuleDone,
    });
  }

  session.progress.settle();
  notice(deps, renderProxySwitch(storageDomain));
  return confirmProxyByHand(deps, session, parsed, input, {
    attempted: false,
    cacheRuleDone: state.cacheRuleDone,
    declined: renderCloudflareRemaining(storageDomain, NOT_THROUGH_CLOUDFLARE_YET, {
      cacheRule: !state.cacheRuleDone,
    }),
  });
}

/**
 * The switch, the proof and the rule, done with the setup token. Each step
 * that cannot be done here — a permission the token lacks, a rule or record
 * that is not this run's to change, an SSL/TLS mode that would loop — is
 * handed to the walkthrough for that step, so a partial success still ends
 * with exactly what is left.
 */
async function finishCloudflareForYou(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: FinishInput,
  apiToken: string,
): Promise<string[]> {
  const storageDomain = input.storageDomain;
  const api = { apiToken, fetch: deps.fetch };
  session.progress.settle();

  const zone = await findZoneApex(storageDomain, deps.dnsClient);
  let zoneId: string;
  try {
    if (zone === null) {
      throw new DnsPreparationError(`Could not find the zone for ${storageDomain}.`);
    }
    session.progress.write(`checking ${zone} on Cloudflare`);
    zoneId = await lookupCloudflareZoneId({ ...api, zone });
  } catch (error) {
    session.progress.settle();
    notice(deps, [cloudflareProblem(error), "The Cloudflare steps are yours to finish:"]);
    return finishCloudflareByHand(deps, session, parsed, input, { cacheRuleDone: false });
  }

  const cacheRuleDone = await addCacheRule(deps, session, {
    ...api,
    shouldStop: input.phase.stopped,
    storageDomain,
    zoneId,
  });
  // A Ctrl+C anywhere above ends the automation here: what was not submitted
  // is listed for the user rather than done after they asked to stop.
  if (input.phase.stopped()) {
    return renderCloudflareRemaining(storageDomain, NOT_THROUGH_CLOUDFLARE_YET, {
      cacheRule: !cacheRuleDone,
    });
  }
  const ssl = await settleSslMode(deps, session, { ...api, zone, zoneId }, input);
  const advice = ssl.kind === "ready" && ssl.full && !input.interactive
    ? [renderFullSslAdvice(zone), ""]
    : [];

  if (ssl.kind === "blocked") {
    return renderCloudflareRemaining(storageDomain, renderSslBlockedLeadIn(zone, ssl.mode), {
      cacheRule: !cacheRuleDone,
    });
  }

  const address =
    session.facts.install?.publicIp ?? publicIpFromTarget(session);
  if (ssl.kind === "unknown" || address === null) {
    return finishCloudflareByHand(deps, session, parsed, input, { cacheRuleDone });
  }

  const switched = await switchProxyOn(deps, session, parsed, input, {
    ...api,
    record: { type: "A", hostname: storageDomain, value: address },
    shouldStop: input.phase.stopped,
    zone,
  });
  if (switched === "declined") {
    return renderCloudflareRemaining(storageDomain, NOT_THROUGH_CLOUDFLARE_YET, {
      cacheRule: !cacheRuleDone,
    });
  }
  if (switched === "failed") {
    return finishCloudflareByHand(deps, session, parsed, input, { cacheRuleDone });
  }

  const check = await checkProxiedDomain(deps, session, storageDomain);
  session.progress.settle();
  if (check.kind === "served") {
    notice(deps, `Downloads now go through Cloudflare (${check.rayId}).`);
    return [
      ...advice,
      ...(cacheRuleDone
        ? renderCacheRuleNextSteps()
        : await cacheRuleByHand(deps, parsed, storageDomain, input)),
    ];
  }

  notice(deps, renderProxiedCheckProblem(storageDomain, check));
  const unconfirmed = [
    ...advice,
    ...renderCloudflareRemaining(storageDomain, renderProxyUnconfirmedLeadIn(storageDomain), {
      cacheRule: !cacheRuleDone,
    }),
  ];
  return input.interactive
    ? confirmProxyByHand(deps, session, parsed, input, {
        attempted: true,
        cacheRuleDone,
        declined: unconfirmed,
      })
    : unconfirmed;
}

/** Whether the rule is in place, added now or found already there. */
async function addCacheRule(
  deps: CommandDeps,
  session: SelfhostSession,
  input: {
    apiToken: string;
    fetch: typeof fetch;
    shouldStop: () => boolean;
    storageDomain: string;
    zoneId: string;
  },
): Promise<boolean> {
  session.progress.write(`adding the Cloudflare cache rule for ${input.storageDomain}`);
  try {
    const result = await createCacheRule({
      ...input,
      domain: input.storageDomain,
      profile: ORIGIN_CACHE_RULE,
    });
    session.progress.settle();
    if (result === "stopped") return false;
    notice(deps, renderCacheRuleAdded(input.storageDomain, result === "written"));
    return true;
  } catch (error) {
    session.progress.settle();
    notice(deps, [cloudflareProblem(error), "The cache rule is left for you to add."]);
    return false;
  }
}

type SslSettlement =
  | { kind: "ready"; full: boolean }
  /** Flexible or off: turning the proxy on would loop or go unencrypted. */
  | { kind: "blocked"; mode: string }
  /** Could not be read — the user checks it as part of the walkthrough. */
  | { kind: "unknown" };

/**
 * Reads the zone's SSL/TLS mode, and on an interactive run waits while a
 * mode that would break the proxy is changed. `full` is accepted — the
 * server's certificate is a real one, so it works — with a nudge to strict.
 */
async function settleSslMode(
  deps: CommandDeps,
  session: SelfhostSession,
  input: { apiToken: string; fetch: typeof fetch; zone: string; zoneId: string },
  finish: FinishInput,
): Promise<SslSettlement> {
  for (;;) {
    let mode: string;
    session.progress.write(`checking SSL/TLS for ${input.zone}`);
    try {
      mode = await readZoneSslMode(input);
    } catch (error) {
      session.progress.settle();
      notice(deps, cloudflareProblem(error));
      return { kind: "unknown" };
    }
    session.progress.settle();

    if (mode === "strict") return { kind: "ready", full: false };
    if (mode === "full") {
      if (finish.interactive) notice(deps, renderFullSslAdvice(input.zone));
      return { kind: "ready", full: true };
    }
    if (!finish.interactive) return { kind: "blocked", mode };

    notice(deps, renderSslBlocksProxy(input.zone, mode));
    const changed = await confirmFinishStep(
      deps,
      {
        active: "Yes, check again",
        inactive: "No, skip it for now",
        initial: true,
        message: "Changed it?",
      },
      finish.phase,
    );
    if (!changed) return { kind: "blocked", mode };
  }
}

/**
 * Flips the storage record to proxied. Asked on an interactive run, since it
 * changes a live record; a scripted run got here only through an explicit
 * `--dns-setup cloudflare`, which is the go-ahead.
 */
async function switchProxyOn(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: FinishInput,
  request: Parameters<typeof enableCloudflareProxy>[0],
): Promise<"switched" | "declined" | "failed"> {
  const hostname = request.record.hostname;
  const go =
    !input.phase.stopped() &&
    (!input.interactive ||
      readBooleanFlag(parsed, "--yes") ||
      (await confirmFinishStep(
        deps,
        {
          initial: true,
          message: `Turn on the Cloudflare proxy (orange cloud) for ${hostname} now?`,
        },
        input.phase,
      )));
  if (!go) return "declined";

  session.progress.write(`turning on the Cloudflare proxy for ${hostname}`);
  try {
    const result = await enableCloudflareProxy(request);
    session.progress.settle();
    if (result === "stopped") return "declined";
    notice(
      deps,
      result === "enabled"
        ? `Turned on the Cloudflare proxy for ${hostname}.`
        : `${hostname} is already proxied by Cloudflare.`,
    );
    return "switched";
  } catch (error) {
    session.progress.settle();
    notice(deps, cloudflareProblem(error));
    return "failed";
  }
}

/**
 * Only messages this code wrote itself are shown: a provider error names the
 * call and status, never the request, and anything else — a network failure
 * whose text is not ours — is reduced to a generic line.
 */
function cloudflareProblem(error: unknown): string {
  return error instanceof DnsPreparationError ||
    error instanceof ProviderHttpError ||
    error instanceof CacheRuleConflict
    ? error.message
    : "Cloudflare could not be reached.";
}

/** The "check it now / fixed it?" loop, entered with or without a first try. */
async function confirmProxyByHand(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: FinishInput,
  state: { attempted: boolean; cacheRuleDone: boolean; declined: string[] },
): Promise<string[]> {
  const storageDomain = input.storageDomain;
  let attempted = state.attempted;
  for (;;) {
    const ready = await confirmFinishStep(
      deps,
      attempted
        ? {
            active: "Yes, check again",
            inactive: "No, skip it for now",
            initial: true,
            message: "Fixed it?",
          }
        : {
            active: "Yes, check it now",
            inactive: "Not yet, skip it for now",
            initial: true,
            message: "Have you turned the cloud orange and checked SSL/TLS?",
          },
      input.phase,
    );
    attempted = true;
    if (!ready) {
      return state.declined;
    }

    const check = await checkProxiedDomain(deps, session, storageDomain);
    // The check ends on its own `write`; every branch below draws or asks.
    session.progress.settle();
    if (check.kind === "served") {
      notice(deps, `Downloads now go through Cloudflare (${check.rayId}).`);
      return state.cacheRuleDone
        ? renderCacheRuleNextSteps()
        : askCacheRule(deps, parsed, storageDomain, input.phase);
    }

    notice(deps, renderProxiedCheckProblem(storageDomain, check));
  }
}

/**
 * The plan's shape, in two stages: an authoritative poll until the record
 * enters Cloudflare's edge ranges, then the `cf-ray` request. The stages
 * split one ambiguous state into two named ones — "the toggle was never
 * flipped (or the wrong record was)" can only be told apart from "this
 * machine's resolver is stale" by asking the zone's own nameservers, and
 * without the first stage the old check asserted the record was right
 * while never having looked at it.
 */
type ProxiedDomainCheck =
  | ReturnType<typeof classifyProxiedResponse>
  /** Cloudflare's own nameservers still answer outside the edge ranges. */
  | { kind: "not-proxied-at-authority"; last: RecordDiagnosis };

// Short on purpose: Cloudflare's own nameservers reflect the toggle within
// seconds, so a poll that is still outside the edge ranges after this long
// means the toggle was not flipped — and the user should be told so while
// they are still looking at the instructions, not half an hour later.
const PROXY_SWITCH_POLL_INTERVAL_MILLISECONDS = 5_000;
const PROXY_SWITCH_POLL_TIMEOUT_MILLISECONDS = 90_000;

async function checkProxiedDomain(
  deps: CommandDeps,
  session: SelfhostSession,
  storageDomain: string,
): Promise<ProxiedDomainCheck> {
  // Stage one: the record itself, from the zone's own nameservers — the half
  // the request below cannot see. `expected` is the server's address so the
  // narration can say "still points straight at this server" while the
  // toggle is off; readiness is the answer entering the edge ranges. When the
  // address cannot be worked out, the empty `expected` is safe: it can never
  // match, and no line of the narration or the diagnosis renders it.
  const stepLabel = renderProxySwitchWaitStep();
  session.progress.write(stepLabel);
  let lastSeen: RecordDiagnosis = { kind: "missing" };
  // Ctrl-C during the poll means "stop waiting", not "kill the run" — the
  // same hook the record waits install. An abandoned poll flows into the
  // ordinary diagnosis-and-retry handling, so the closing summary and the
  // Cache Rule instructions still print instead of dying with the process.
  let abandoned = false;
  const removeHook = onSignal(session, () => {
    abandoned = true;
  });
  try {
    const wait = await waitForDnsRecord({
      client: deps.dnsClient,
      expected:
        session.facts.install?.publicIp ?? publicIpFromTarget(session) ?? "",
      hostname: storageDomain,
      intervalMilliseconds: PROXY_SWITCH_POLL_INTERVAL_MILLISECONDS,
      isReady: (diagnosis) => diagnosis.kind === "cloudflare-proxied",
      now: deps.now,
      onAttempt: (diagnosis) => {
        lastSeen = diagnosis;
        session.progress.detail(
          renderProxySwitchWaitDetail(storageDomain, diagnosis),
        );
      },
      onFallback: resolverFallbackWarning(session, stepLabel),
      shouldAbandon: () => abandoned,
      sleep: deps.sleep,
      timeoutMilliseconds: PROXY_SWITCH_POLL_TIMEOUT_MILLISECONDS,
    });
    if (wait.kind !== "ready") {
      return {
        kind: "not-proxied-at-authority",
        last: wait.kind === "timed-out" ? wait.last : lastSeen,
      };
    }
  } finally {
    removeHook();
  }

  // Stage two, through the system resolver deliberately: that is the resolver
  // the request below will use, so an origin answer here — with the authority
  // verified just above — means only that this machine's view is stale.
  session.progress.write(`checking ${storageDomain}`);
  let addresses: string[];
  try {
    addresses = await deps.dnsClient.resolveA(storageDomain);
  } catch (error) {
    // The system resolver itself could not be asked. Neither "not through
    // Cloudflare" nor the stale-cache story fits — nothing was looked up —
    // and the request below would fail the same way.
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the DNS lookup failed",
    };
  }

  if (!addresses.some((address) => isCloudflareEdgeAddress(address))) {
    return { kind: "not-through-cloudflare" };
  }

  const requestUrl = `https://${storageDomain}${PROXY_CHECK_PATH}`;
  try {
    const response = await deps.fetch(requestUrl, { redirect: "manual" });
    return classifyProxiedResponse({
      headers: response.headers,
      requestUrl,
      status: response.status,
    });
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the request failed",
    };
  }
}

/**
 * A printed block the user confirms, not something the CLI can create: the
 * Cache-Purge-scoped token this branch collected cannot read or write
 * Cloudflare's rules. It is still not optional — without the rule the manifest
 * files are never eligible for the edge cache, and the purge has nothing to
 * purge.
 */
async function askCacheRule(
  deps: CommandDeps,
  parsed: ParsedArgs,
  storageDomain: string,
  phase: FinishPhase,
): Promise<string[]> {
  notice(deps, renderCacheRule(storageDomain, paletteFor(deps)));

  const done =
    readBooleanFlag(parsed, "--yes") ||
    (await confirmFinishStep(
      deps,
      { initial: true, message: "Rule added?" },
      phase,
    ));

  return done
    ? renderCacheRuleNextSteps()
    : [
        "Still to do, or releases will keep serving from a cache that never fills:",
        ...renderCacheRuleSteps(storageDomain),
      ];
}

/** The printed rule after the token could not add it; asked only when a person is there. */
async function cacheRuleByHand(
  deps: CommandDeps,
  parsed: ParsedArgs,
  storageDomain: string,
  input: FinishInput,
): Promise<string[]> {
  return input.interactive
    ? askCacheRule(deps, parsed, storageDomain, input.phase)
    : [
        "Still to do, or releases will keep serving from a cache that never fills:",
        ...renderCacheRuleSteps(storageDomain),
      ];
}

/**
 * The Cloudflare setup step, reused as the repair unit.
 *
 * It is the same walkthrough as the first install — token, zone lookup, the
 * explicit zone-id escape hatch — which is what makes a zone id pasted from
 * the wrong zone, or a token minted on the wrong account, correctable here
 * rather than over ssh in `.env.selfhost`.
 */
export async function repairCloudflare(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
): Promise<{ apiToken: string; zoneId: string }> {
  const storageDomain = session.facts.storageDomain;
  if (storageDomain === null) {
    // No env file to read the domain from, so the lookup has nothing to look
    // up: both values are taken as given.
    return {
      apiToken: await askValue(deps, {
        message: "Cloudflare API token",
        type: "password",
      }),
      zoneId: await askValue(deps, {
        message: "Cloudflare Zone ID",
        type: "text",
      }),
    };
  }

  const zone = await findZoneApex(storageDomain, deps.dnsClient);
  const nameservers = zone === null ? [] : await deps.dnsClient.resolveNs(zone);
  const selection = await collectCloudflare(deps, parsed, {
    nameserversAreCloudflare: detectDnsProvider(nameservers)?.name === "Cloudflare",
    storageDomain,
    zone,
  });

  return { apiToken: selection.apiToken, zoneId: selection.zoneId };
}
