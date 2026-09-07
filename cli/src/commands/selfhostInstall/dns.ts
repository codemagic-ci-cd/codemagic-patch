/**
 * The DNS step: the records a first install asks the user to create, and the
 * waits that watch for each one to go live.
 */

import {
  detectDnsProvider,
  findZoneApex,
  waitForDnsRecord,
  type DnsProvider,
} from "../../selfhostDns";
import {
  renderDnsAbandoned,
  renderDnsIntro,
  renderDnsRecords,
  renderDnsWaitDetail,
  renderDnsWaitStep,
  renderRecordDiagnosis,
  renderRecordWaitTimeout,
  renderResolverFallbackWarning,
  type DnsRecordRequest,
} from "../../selfhostSetupCopy";
import { type SelfhostSession } from "../selfhostSession";
import { DeclinedError, UsageError, type CommandDeps } from "../shared";
import { noteBlock, notice, offerBrowserOpen, onSignal, paletteFor } from "./ask";
import { hostOf } from "./hostBootstrap";

/** One record: the hostname, and what it is for in the user's terms. */
type PlannedRecord = { hostname: string; purpose: string };

export async function runDnsStep(
  deps: CommandDeps,
  session: SelfhostSession,
  planned: readonly PlannedRecord[],
): Promise<void> {
  const address = session.facts.install?.publicIp ?? publicIpFromTarget(session);
  if (address === null) {
    // Honest rather than helpful-sounding: without the server's own address
    // there is no value to print in the record, and a made-up one is worse
    // than none.
    notice(
      deps,
      `Could not work out ${session.sshTarget}'s public address, so the DNS records cannot be checked from here. Point ${planned
        .map((record) => record.hostname)
        .join(" and ")} at the server before it can be reached.`,
    );
    return;
  }

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

  if (provider !== null) {
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

  try {
    const outcome = await waitForDnsRecord({
      client: deps.dnsClient,
      expected: record.value,
      hostname: record.hostname,
      now: deps.now,
      onAttempt: (diagnosis) => {
        session.progress.detail(
          renderDnsWaitDetail(record.hostname, diagnosis),
        );
      },
      onFallback: resolverFallbackWarning(session, stepLabel),
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

    notice(
      deps,
      renderRecordDiagnosis(record.hostname, record.value, outcome.last),
    );

    throw new UsageError(
      renderRecordWaitTimeout(record.hostname, outcome.last),
    );
  } finally {
    removeHook();
  }
}

/** The ssh target's host part, when it is already a bare IPv4 address. */
export function publicIpFromTarget(session: SelfhostSession): string | null {
  const host = hostOf(session.sshTarget);
  return /^\d{1,3}(\.\d{1,3}){3}$/u.test(host) ? host : null;
}
