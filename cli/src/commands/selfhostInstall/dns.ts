/**
 * The DNS step: the records a first install asks the user to create, and the
 * waits that watch for each one to go live.
 */

import { applyDnsRecord } from "./dnsSetup";
import {
  detectDnsProvider,
  findZoneApex,
  waitForDnsRecord,
  type DnsProvider,
  type RecordDiagnosis,
} from "../../selfhostDns";
import { publicIpv4OrNull } from "../../selfhostRemote";
import {
  describePublicAddressProblem,
  renderDnsAbandoned,
  renderDnsIntro,
  renderDnsRecords,
  renderDnsWaitDetail,
  renderDnsWaitStep,
  renderPublicAddressQuestion,
  renderPublicAddressRequired,
  renderRecordExplanation,
  renderRecordWaitTimeout,
  renderResolverFallbackWarning,
  type DnsRecordRequest,
} from "../../selfhostSetupCopy";
import { type SelfhostSession } from "../selfhostSession";
import { DeclinedError, UsageError, type CommandDeps } from "../shared";
import {
  askChecked,
  noteBlock,
  notice,
  offerBrowserOpen,
  onSignal,
  paletteFor,
} from "./ask";
import { hostOf } from "./hostBootstrap";

/** One record: the hostname, and what it is for in the user's terms. */
type PlannedRecord = { hostname: string; purpose: string };

export async function runDnsStep(
  deps: CommandDeps,
  session: SelfhostSession,
  planned: readonly PlannedRecord[],
  interactive: boolean,
): Promise<void> {
  const address = await resolvePublicAddress(deps, session, interactive);

  const records: DnsRecordRequest[] = planned.map((record) => ({
    ...record,
    type: "A" as const,
    value: address,
  }));

  const zone = await findZoneApex(records[0]?.hostname ?? "", deps.dnsClient);
  const nameservers = zone === null ? [] : await deps.dnsClient.resolveNs(zone);
  const provider: DnsProvider | null = detectDnsProvider(nameservers);

  notice(deps, renderDnsIntro({ nameservers, provider }));
  noteBlock(deps, "Records to add", renderDnsRecords(records, zone, paletteFor(deps)));

  let allApplied = true;
  for (const record of records) {
    if (!(await applyDnsRecord(session, record))) allApplied = false;
  }

  if (!allApplied && provider !== null) {
    await offerBrowserOpen(deps, {
      message: `Open ${provider.name} in your browser?`,
      url: provider.consoleUrl,
    });
  }

  for (const record of records) {
    await waitForRecord(deps, session, record, records);
  }
}

/**
 * The address every record points at.
 *
 * The survey's answer when it has one, else the ssh target itself when that
 * is already a public address. When neither can say — a host behind NAT, an
 * IPv6-only host, a cloud whose metadata service the survey does not know —
 * the user is asked, with whatever the ssh hostname resolves to offered as
 * the default; a scripted run is refused naming `--public-ip`, because a
 * name in front of a CDN or an old record resolves to exactly the wrong
 * value to print into records unattended. The answer is kept on the session
 * so the later record waits (the CloudFront origin, the proxy switch) read
 * the same address.
 */
async function resolvePublicAddress(
  deps: CommandDeps,
  session: SelfhostSession,
  interactive: boolean,
): Promise<string> {
  const known = session.facts.install?.publicIp ?? publicIpFromTarget(session);
  if (known !== null) {
    return known;
  }

  if (!interactive) {
    throw new UsageError(renderPublicAddressRequired(session.sshTarget));
  }

  const host = hostOf(session.sshTarget);
  const resolvedFromTarget = await resolveTargetAddress(deps, host);
  notice(
    deps,
    renderPublicAddressQuestion({ host, resolvedFromTarget, sshTarget: session.sshTarget }),
  );
  const address = await askChecked(deps, {
    check: describePublicAddressProblem,
    ...(resolvedFromTarget === null ? {} : { initial: resolvedFromTarget }),
    message: "Public IP address of the server",
    type: "text",
  });

  if (session.facts.install !== undefined) {
    session.facts.install.publicIp = address;
  }
  return address;
}

/** What the ssh hostname resolves to, when that is one public IPv4 address. */
async function resolveTargetAddress(
  deps: CommandDeps,
  host: string,
): Promise<string | null> {
  if (!host.includes(".")) {
    return null;
  }

  try {
    const found = await deps.dnsClient.resolveA(host);
    return found.length === 1 ? publicIpv4OrNull(found[0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * A wait's `onFallback`: says once, as a warning line, that the wait moved to
 * the system resolver. The warning settles the animating step, so the step is
 * started again under the same label and the polls that follow have a line
 * to repaint.
 */
export function resolverFallbackWarning(
  session: SelfhostSession,
  stepLabel: string,
): () => void {
  return () => {
    session.progress.warn(renderResolverFallbackWarning());
    session.progress.write(stepLabel);
  };
}

async function waitForRecord(
  deps: CommandDeps,
  session: SelfhostSession,
  record: DnsRecordRequest,
  allRecords: readonly DnsRecordRequest[],
): Promise<void> {
  // Named as the user's move: a spinner that only says "waiting for
  // <hostname>" reads as the wizard working on something, and people sit and
  // wait for it to finish a step only they can do.
  const stepLabel = renderDnsWaitStep(record.hostname);
  session.progress.write(stepLabel);

  // Ctrl-C during the wait means "I will set this up later", not "something
  // went wrong": it leaves the records printed above as the next step, with
  // nothing installed and nothing to undo.
  let abandoned = false;
  const removeHook = onSignal(session, () => {
    abandoned = true;
  });

  // Each kind of finding is explained once, the first time it is seen, not
  // at the end of the wait: the orange cloud is Cloudflare's default for a
  // record added minutes ago, and half an hour of "still has the orange
  // cloud on" told nobody what to click.
  const explained = new Set<RecordDiagnosis["kind"]>();
  // Remembered for the timeout message: after the move to the system
  // resolver, a record that was added can still read as missing for as long
  // as that resolver caches the old answer.
  let fellBack = false;
  const warnFallback = resolverFallbackWarning(session, stepLabel);

  try {
    const outcome = await waitForDnsRecord({
      client: deps.dnsClient,
      expected: record.value,
      hostname: record.hostname,
      now: deps.now,
      onAttempt: (diagnosis) => {
        const explanation = renderRecordExplanation(
          record.hostname,
          record.value,
          diagnosis,
        );
        if (explanation !== null && !explained.has(diagnosis.kind)) {
          explained.add(diagnosis.kind);
          session.progress.settle();
          notice(deps, explanation);
          session.progress.write(stepLabel);
        }
        session.progress.detail(
          renderDnsWaitDetail(record.hostname, diagnosis),
        );
      },
      onFallback: () => {
        fellBack = true;
        warnFallback();
      },
      shouldAbandon: () => abandoned,
      sleep: deps.sleep,
    });

    if (outcome.kind === "ready") {
      session.progress.write(`${record.hostname} points at this server`);
      // The step is already complete; left animating, its redraw would erase
      // the wizard questions that follow.
      session.progress.settle();
      return;
    }

    session.progress.settle();
    if (outcome.kind === "abandoned") {
      notice(deps, renderDnsAbandoned(allRecords));

      throw new DeclinedError("Setup stopped before anything was installed.");
    }

    throw new UsageError(
      renderRecordWaitTimeout(record.hostname, record.value, outcome.last, fellBack),
    );
  } finally {
    removeHook();
  }
}

/** The ssh target's host part, when it is already a public IPv4 address. */
export function publicIpFromTarget(session: SelfhostSession): string | null {
  return publicIpv4OrNull(hostOf(session.sshTarget));
}
