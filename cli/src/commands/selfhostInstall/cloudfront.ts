/**
 * The CloudFront branch: the Console walkthrough that collects the
 * distribution, and the cutover that moves the download hostname onto it once
 * the server is up.
 */

import { CLOUDFRONT_DOCS_URL } from "../../branding";
import {
  buildPurgePolicy,
  checkAccessKeyId,
  checkDistributionDomain,
  checkDistributionId,
  checkOriginVerifySecret,
  checkSecretAccessKey,
  classifyDistributionProbe,
  classifyOriginProbe,
  classifyRequestFailure,
  CONSOLE_URLS,
  DISTRIBUTION_PROBE_PATH,
  doubledValidationName,
  generateOriginVerifySecret,
  ORIGIN_VERIFY_HEADER,
  SYNTHETIC_PROBE_PATH,
  type RequestFailure,
} from "../../providers/cloudfront";
import {
  findZoneApex,
  waitForCnameRecord,
  type CnameDiagnosis,
  type DnsProvider,
} from "../../selfhostDns";
import {
  deriveStorageOriginDomain,
  type DeliverySelection,
} from "../../selfhostInstall";
import {
  renderAccessKeyNotCreated,
  renderAcmStep,
  renderAcmValidationRecord,
  renderAcmWaitDetail,
  renderAcmWaitGaveUp,
  renderAcmWaitStep,
  renderCertificateNotIssued,
  renderCloudFrontIntro,
  renderCloudFrontNextSteps,
  renderCloudFrontProbeProblem,
  renderCutoverCertificateMismatch,
  renderCutoverOriginRejection,
  renderCutoverStep,
  renderCutoverStopped,
  renderCutoverTimedOut,
  renderCutoverWaitDetail,
  renderCutoverWaitStep,
  renderDistributionNotCreated,
  renderDistributionStep,
  renderIamStep,
  renderOriginSecret,
  renderOriginSecretLookup,
  renderOriginSecretRegenerating,
  renderOriginSecretRerunAsk,
  renderOriginTlsWaitDetail,
  renderOriginTlsWaitGaveUp,
  renderOriginTlsWaitStep,
  type CutoverQuietSighting,
} from "../../selfhostSetupCopy";
import type { TlsNameProbe } from "../../selfhostTls";
import {
  readStringFlag,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
import { supplied, suppliedAccessKeyId } from "./answers";
import {
  askChecked,
  askDomain,
  askValue,
  confirmFinishStep,
  holdUntilConfirmed,
  noteBlock,
  notice,
  offerBrowserOpen,
  onSignal,
  paletteFor,
  type FinishPhase,
} from "./ask";
import { resolverFallbackWarning, runDnsStep } from "./dns";

// ---------------------------------------------------------------------------
// The wizard: the CloudFront branch
// ---------------------------------------------------------------------------

/**
 * Collects everything the install needs, in the order the Console requires it.
 *
 * The origin inputs come first because one of them is a DNS record that must
 * already resolve when the install runs: the origin Caddy site cannot obtain
 * its certificate otherwise, and the whole branch stalls at the end instead of
 * at the beginning.
 */
export async function collectCloudFront(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  context: {
    apiDomain: string;
    provider: DnsProvider | null;
    storageDomain: string;
    zone: string | null;
  },
): Promise<DeliverySelection> {
  const originDomain =
    readStringFlag(parsed, "--storage-origin-domain") ??
    (await askDomain(deps, {
      initial: deriveStorageOriginDomain(context.storageDomain),
      message: "What hostname should CloudFront fetch from?",
      purpose:
        "CloudFront needs a second address for your server that it alone talks to. The suggested one is fine.",
    }));

  notice(
    deps,
    renderCloudFrontIntro({
      apiDomain: context.apiDomain,
      guideUrl: CLOUDFRONT_DOCS_URL,
      originDomain,
      storageDomain: context.storageDomain,
    }),
  );

  // `origin-storage.` and `storage.` are one word apart and are routinely
  // transposed; install.sh rejects a collision, but only after the build.
  const hostnames = new Set([context.apiDomain, context.storageDomain, originDomain]);
  if (hostnames.size !== 3) {
    throw new UsageError(
      `The three hostnames must all differ: ${context.apiDomain}, ${context.storageDomain}, and ${originDomain}.`,
    );
  }

  const flaggedSecret = readStringFlag(
    parsed,
    "--cloudfront-origin-verify-secret",
  );
  // The flag is the non-interactive form of the same answer — a caller that
  // already knows the value is not asked for it again.
  const existingSecret =
    flaggedSecret ?? (await askExistingOriginSecret(deps, originDomain));
  const originVerifySecret = existingSecret ?? generateOriginVerifySecret();
  noteBlock(
    deps,
    "Origin header",
    renderOriginSecret(
      {
        headerName: ORIGIN_VERIFY_HEADER,
        secret: originVerifySecret,
        source:
          flaggedSecret !== undefined
            ? "supplied"
            : existingSecret === null
              ? "generated"
              : "existing",
      },
      paletteFor(deps),
    ),
  );

  // Record 3, and it has to be in place *before* the install: the origin
  // Caddy site obtains its own certificate during the run, and it cannot do
  // that for a hostname that does not resolve here yet.
  await runDnsStep(deps, session, [
    {
      hostname: originDomain,
      purpose: "The address CloudFront fetches from — this one stays put",
    },
  ]);

  await walkThroughConsole(deps, session, {
    originDomain,
    provider: context.provider,
    storageDomain: context.storageDomain,
    zone: context.zone,
  });

  const distributionId =
    readStringFlag(parsed, "--cloudfront-distribution-id") ??
    (await askChecked(deps, {
      check: checkDistributionId,
      message: "Distribution ID",
      type: "text",
    }));
  const distributionDomain = await askChecked(deps, {
    check: checkDistributionDomain,
    message: "Distribution domain name",
    type: "text",
  });
  const accessKeyId =
    suppliedAccessKeyId(deps, parsed) ??
    (await askChecked(deps, {
      check: checkAccessKeyId,
      message: "Access key ID",
      type: "text",
    }));
  const secretAccessKey =
    supplied(deps, parsed, {
      env: "CLOUDFRONT_SECRET_ACCESS_KEY",
      flag: "--cloudfront-secret-access-key",
    })?.value ??
    (await askChecked(deps, {
      check: checkSecretAccessKey,
      message: "Secret access key",
      type: "password",
    }));

  return {
    accessKeyId,
    distributionDomain,
    distributionId,
    kind: "cloudfront",
    originVerifySecret,
    secretAccessKey,
    storageOriginDomain: originDomain,
  };
}

/**
 * The header value an earlier, interrupted run already pasted into AWS — or
 * null when there is no such run, or the user cannot produce the value, and
 * one should be generated.
 *
 * This is the one wizard answer that a rerun cannot re-derive and must not
 * re-invent. Every other CloudFront value is either asked for again (the
 * distribution id, the key pair) or re-checked against reality (the DNS
 * records, the probes); the origin-verify secret is the single value that
 * lives on the distribution *and* in the server's settings, and the only run
 * that knew it may have been stopped before it wrote either one — a Ctrl+C
 * anywhere between the distribution screen and the end of the install. A
 * fresh secret then reads as a working install whose every download 403s.
 *
 * Asking is what avoids keeping a copy: the plan (rev 29) declined to
 * checkpoint the secret to local disk — a new secret at rest, and a second
 * authoritative configuration beside the env file — and the value the user
 * needs is on the distribution's own origin settings page in the Console.
 * A run with nobody to ask generates, exactly as before; the flag carries the
 * same answer for scripted runs.
 */
async function askExistingOriginSecret(
  deps: CommandDeps,
  originDomain: string,
): Promise<string | null> {
  if (deps.confirm === undefined) {
    return null;
  }

  notice(deps, renderOriginSecretRerunAsk());

  // Default no: the first install is the common case, and the question is
  // being asked of someone who may never have seen a distribution.
  const existing = await deps.confirm({
    initial: false,
    message: "Did an earlier run already create a distribution for this server?",
  });
  if (!existing) {
    return null;
  }

  notice(deps, renderOriginSecretLookup({ headerName: ORIGIN_VERIFY_HEADER, originDomain }));

  // Not `askChecked`: this question needs a way out that a required prompt
  // cannot give it. A user who says yes and then cannot produce the value —
  // it was never written down, the distribution's origin was edited by hand —
  // would otherwise be held at a prompt with nothing valid to type, on this
  // run and on every rerun. An empty line takes the generate path instead,
  // and step ② says to replace the distribution's header value with the new
  // one.
  for (;;) {
    const value = await askValue(deps, {
      // Echoed, unlike the access key's secret half: the walkthrough prints
      // this value back anyway, and a paste that lost a character is only
      // catchable on screen.
      message: `The ${ORIGIN_VERIFY_HEADER} value on that distribution`,
      optional: true,
      type: "text",
    });

    if (value.length === 0) {
      notice(deps, renderOriginSecretRegenerating());

      return null;
    }

    const problem = checkOriginVerifySecret(value);
    if (problem === null) {
      return value;
    }

    notice(deps, problem);
  }
}

/**
 * The three Console screens, each opened, printed, and advanced by the user.
 *
 * The checkmarks here are confirmations, not verifications — the wizard holds
 * no AWS credential that could check any of it. The one exception is the ACM
 * validation record, which is a DNS record the wizard *can* watch, and which
 * is also the only value in the walkthrough that is never pasted back.
 */
async function walkThroughConsole(
  deps: CommandDeps,
  session: SelfhostSession,
  input: {
    originDomain: string;
    provider: DnsProvider | null;
    storageDomain: string;
    zone: string | null;
  },
): Promise<void> {
  notice(
    deps,
    renderAcmStep(
      {
        consoleUrl: CONSOLE_URLS.acmRequest,
        provider: input.provider,
        storageDomain: input.storageDomain,
      },
      paletteFor(deps),
    ),
  );

  await offerBrowserOpen(deps, {
    message: "Open the ACM console in your browser?",
    url: CONSOLE_URLS.acmRequest,
  });

  await watchAcmValidation(deps, session, input);

  notice(
    deps,
    renderDistributionStep(
      {
        consoleUrl: CONSOLE_URLS.distributionCreate,
        headerName: ORIGIN_VERIFY_HEADER,
        originDomain: input.originDomain,
        storageDomain: input.storageDomain,
      },
      paletteFor(deps),
    ),
  );

  await offerBrowserOpen(deps, {
    message: "Open the CloudFront console in your browser?",
    url: CONSOLE_URLS.distributionCreate,
  });

  await holdUntilConfirmed(deps, {
    message: "Distribution created?",
    nudge: renderDistributionNotCreated,
  });

  notice(
    deps,
    renderIamStep(
      {
        consoleUrl: CONSOLE_URLS.iamPolicyCreate,
        policy: buildPurgePolicy(
          "arn:aws:cloudfront::YOUR_AWS_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID",
        ),
      },
      paletteFor(deps),
    ),
  );

  await offerBrowserOpen(deps, {
    message: "Open the IAM console in your browser?",
    url: CONSOLE_URLS.iamPolicyCreate,
  });

  await holdUntilConfirmed(deps, {
    message: "Access key created?",
    nudge: renderAccessKeyNotCreated,
  });
}

/**
 * Prints the validation record, then waits for it the way the A records are
 * waited for.
 *
 * The old shape of this step asked for both halves and only then said to add
 * the record, which read as "paste it here and the wizard handles it" — the
 * one thing it cannot do. So the record block comes first, the wait names the
 * user as the actor, and nothing here fails the run — but the confirm at the
 * end gates for real: the distribution screen cannot attach a certificate
 * that has not reached Issued.
 */
async function watchAcmValidation(
  deps: CommandDeps,
  session: SelfhostSession,
  input: {
    provider: DnsProvider | null;
    storageDomain: string;
    zone: string | null;
  },
): Promise<void> {
  const name = await askValue(deps, {
    message: "CNAME name from AWS (or press Enter to skip)",
    optional: true,
    type: "text",
  });
  if (name.length === 0) {
    notice(
      deps,
      `Skipping the check. Add the CNAME AWS showed you at ${input.provider?.name ?? "your DNS provider"} and wait for the certificate to reach Issued before continuing.`,
    );
    await confirmCertificateIssued(deps);
    return;
  }

  const value = await askValue(deps, {
    message: "CNAME value from AWS",
    type: "text",
  });
  const bare = name.replace(/\.$/u, "");
  const zone = input.zone ?? (await findZoneApex(input.storageDomain, deps.dnsClient));

  const validation = renderAcmValidationRecord(
    { name: bare, provider: input.provider, value, zone },
    paletteFor(deps),
  );
  notice(deps, validation.intro);
  noteBlock(deps, "Validation record", validation.record);
  notice(deps, validation.after);

  if (input.provider !== null) {
    await offerBrowserOpen(deps, {
      message: `Open ${input.provider.name} in your browser?`,
      url: input.provider.consoleUrl,
    });
  }

  const diagnosis = await waitForValidationRecord(deps, session, {
    doubledAt: doubledValidationName(bare, zone),
    expected: value,
    name: bare,
    provider: input.provider,
  });

  if (diagnosis !== null) {
    notice(
      deps,
      renderAcmWaitGaveUp({ expected: value, name: bare, zone }, diagnosis),
    );
  }

  await confirmCertificateIssued(deps);
}

/** The first of the walkthrough's three gates; reached from both ACM paths. */
async function confirmCertificateIssued(deps: CommandDeps): Promise<void> {
  await holdUntilConfirmed(deps, {
    message: "Certificate issued?",
    nudge: renderCertificateNotIssued,
  });
}

/**
 * The wait itself. Returns the last unhappy diagnosis, or null once the record
 * is live — Ctrl+C and the timeout are both "carry on without it".
 */
async function waitForValidationRecord(
  deps: CommandDeps,
  session: SelfhostSession,
  input: {
    doubledAt: string | null;
    expected: string;
    name: string;
    provider: DnsProvider | null;
  },
): Promise<CnameDiagnosis | null> {
  const stepLabel = renderAcmWaitStep();
  session.progress.write(stepLabel);

  let abandoned = false;
  const removeHook = onSignal(session, () => {
    abandoned = true;
  });

  try {
    const outcome = await waitForCnameRecord({
      client: deps.dnsClient,
      doubledAt: input.doubledAt,
      expected: input.expected,
      name: input.name,
      now: deps.now,
      onAttempt: (diagnosis) => {
        session.progress.detail(renderAcmWaitDetail(input.name, diagnosis));
      },
      onFallback: resolverFallbackWarning(session, stepLabel),
      shouldAbandon: () => abandoned,
      sleep: deps.sleep,
    });

    if (outcome.kind === "ready") {
      session.progress.write(`${input.name} is live — AWS can see it now`);
    }

    // Settled either way: the questions that follow would be erased by a
    // spinner still redrawing itself.
    session.progress.settle();
    if (outcome.kind === "ready") {
      return null;
    }

    // Ctrl+C here means "I will add it later", which is the same advice the
    // missing-record copy gives.
    return outcome.kind === "timed-out" ? outcome.last : { kind: "missing" };
  } finally {
    removeHook();
  }
}

// ---------------------------------------------------------------------------
// The wizard: the CloudFront cutover
// ---------------------------------------------------------------------------

/**
 * The cutover, in the one order that works.
 *
 * The viewer hostname stays on this server for the whole install so Caddy can
 * complete certificate issuance; only after the origin is reachable over
 * HTTPS, the distribution answers, and the origin refuses an unverified
 * request does the record move. Each of those checks exists because skipping
 * it leaves a state that looks fine and serves nothing — or, for the origin
 * check, serves everything to anyone who knows the hostname.
 */
export async function finishCloudFront(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  input: {
    delivery: Extract<DeliverySelection, { kind: "cloudfront" }>;
    interactive: boolean;
    phase: FinishPhase;
    storageDomain: string;
  },
): Promise<string[]> {
  const distributionDomain = input.delivery.distributionDomain;
  const originDomain = input.delivery.storageOriginDomain;
  if (
    !input.interactive ||
    distributionDomain === undefined ||
    originDomain === undefined
  ) {
    return [
      "Downloads are not going through CloudFront yet — the last step is a DNS change:",
      `  point ${input.storageDomain} at the distribution with a CNAME, once the distribution answers and ${originDomain ?? "the origin hostname"} refuses a request without the secret header.`,
      "",
      `Full guide: ${CLOUDFRONT_DOCS_URL}`,
    ];
  }

  session.progress.settle();

  // Origin readiness first, and issuance-tolerant: install.sh has no wait for
  // the origin host's HTTPS — Caddy obtains that certificate in the
  // background after the install returns — so the probes below are *expected*
  // to find TLS not ready on their first run. Without this wait that state
  // rendered the "check that the record still points at this server"
  // diagnosis, which is misconfiguration advice for a server doing exactly
  // what it should. Timing out or Ctrl+C falls through to the probes, which
  // report whatever is really there.
  await waitForOriginTls(deps, session, originDomain);

  for (;;) {
    const probes = await probeBeforeCutover(deps, session, {
      distributionDomain,
      originDomain,
      storageDomain: input.storageDomain,
    });
    // The probe ends on its own `write`; every branch below draws.
    session.progress.settle();

    if (probes === null) {
      break;
    }

    notice(deps, probes);

    const retry = await confirmFinishStep(
      deps,
      { initial: true, message: "Check again?" },
      input.phase,
    );
    if (!retry) {
      return [
        `Downloads are not going through CloudFront yet. Once the checks above pass, point ${input.storageDomain} at ${distributionDomain} with a CNAME.`,
        "",
        `Full guide: ${CLOUDFRONT_DOCS_URL}`,
      ];
    }
  }

  const zone = await findZoneApex(input.storageDomain, deps.dnsClient);
  noteBlock(
    deps,
    "The last DNS change",
    renderCutoverStep(
      { distributionDomain, storageDomain: input.storageDomain, zone },
      paletteFor(deps),
    ),
  );

  const moved = await confirmFinishStep(
    deps,
    { initial: true, message: "Record changed?" },
    input.phase,
  );
  if (!moved) {
    return [
      `Last step: point ${input.storageDomain} at ${distributionDomain} with a CNAME.`,
      "",
      ...renderCloudFrontNextSteps({ storageDomain: input.storageDomain }),
    ];
  }

  const cutOver = await waitForCutover(deps, session, input.storageDomain);
  // The poll leaves its spinner animating either way; the notice below has to
  // outlive it, and a prompt drawn over it would corrupt both lines.
  session.progress.settle();

  if (cutOver.kind === "certificate-name") {
    const cutoverInput = {
      distributionDomain,
      storageDomain: input.storageDomain,
    };
    // Coloured on screen, plain in the summary: the summary is the command's
    // result and goes wherever stdout does.
    notice(deps, renderCutoverCertificateMismatch(cutoverInput, paletteFor(deps)));
    const mismatch = renderCutoverCertificateMismatch(cutoverInput);

    // Carried into the closing summary too: this cutover outcome leaves
    // downloads failing, and it must not scroll away.
    return [...mismatch, "", ...renderCloudFrontNextSteps({ storageDomain: input.storageDomain })];
  }

  if (cutOver.kind === "origin-header-rejected") {
    const rejection = renderCutoverOriginRejection({
      distributionDomain,
      originDomain,
      storageDomain: input.storageDomain,
    });
    notice(deps, rejection);

    // Carried into the closing summary for the same reason as the certificate
    // case: downloads are failing until the header is fixed.
    return [...rejection, "", ...renderCloudFrontNextSteps({ storageDomain: input.storageDomain })];
  }

  if (cutOver.kind === "timed-out") {
    const timedOutInput = {
      distributionDomain,
      originDomain,
      storageDomain: input.storageDomain,
    };
    // Coloured on screen, plain in the summary, as above.
    notice(deps, renderCutoverTimedOut(timedOutInput, cutOver.seen, paletteFor(deps)));
    const timedOut = renderCutoverTimedOut(timedOutInput, cutOver.seen);

    // "Still this server" is the one timeout that leaves downloads working,
    // so its reassurance can scroll away like the success line. The other
    // two mean downloads are failing, and are carried into the closing
    // summary the way the certificate and header findings are.
    return cutOver.seen === "still-this-server"
      ? renderCloudFrontNextSteps({ storageDomain: input.storageDomain })
      : [...timedOut, "", ...renderCloudFrontNextSteps({ storageDomain: input.storageDomain })];
  }

  notice(
    deps,
    cutOver.kind === "served"
      ? "Downloads now come from CloudFront."
      : renderCutoverStopped(input.storageDomain, cutOver.seen),
  );

  return renderCloudFrontNextSteps({ storageDomain: input.storageDomain });
}

/**
 * Polls the viewer hostname until CloudFront is the one answering it.
 *
 * `x-cache` proves who is answering, for the same reason `cf-ray` is on the
 * Cloudflare branch: the record can have moved while this machine's resolver
 * still holds the old address, and a plain 200 from the server would then
 * read as a completed cutover. A healthy status is required *beside* it,
 * because an origin refusal travels through CloudFront with `x-cache` intact
 * — trusting the header alone printed the success line over a CDN that 403s
 * every device.
 */
type CutoverOutcome =
  /** CloudFront is answering the viewer hostname, and healthily. */
  | { kind: "served" }
  /**
   * CloudFront answers, but with a certificate that does not cover the name.
   * Reported only once the wait is over: mid-deploy distributions do this and
   * then stop, so seeing it is not on its own a reason to give up.
   */
  | { kind: "certificate-name" }
  /**
   * CloudFront answers, but relays this server's 403 — the origin-verify
   * header on the distribution does not match. Like the certificate case it
   * is reported once the wait is over, and unlike slow DNS it never clears
   * on its own.
   */
  | { kind: "origin-header-rejected" }
  /**
   * The user stopped the wait, and it had seen nothing decisive. Distinct from
   * the timeout because the two have different last words: a wait that ran out
   * explains that DNS is slow, while one that was stopped has to say it
   * stopped, and report what it had got to.
   */
  | { kind: "stopped"; seen: CutoverQuietSighting }
  /**
   * The wait ran out with nothing decisive seen. It carries where the poll
   * had got to for the same reason the stop does: "still this server" is the
   * ordinary "give it a minute", but a name that answers nothing, or a
   * CloudFront that relays an error, means every download is failing right
   * now — and a timeout that reported all three as slow DNS reassured the
   * user over an outage.
   */
  | { kind: "timed-out"; seen: CutoverQuietSighting };

async function waitForCutover(
  deps: CommandDeps,
  session: SelfhostSession,
  storageDomain: string,
): Promise<CutoverOutcome> {
  // One spinner for the whole wait. `write` settles the step in flight into a
  // permanent line before starting the next, so writing the same label on
  // every attempt printed a fresh copy of it every ten seconds; the DNS waits
  // already do this the other way round — `write` once, `detail` per attempt.
  session.progress.write(renderCutoverWaitStep(storageDomain));

  // Ctrl+C means "stop waiting", not "kill the run" — the hook every other
  // wait in the wizard installs, and the reason this one is the last thing the
  // install asks for: the record either reached the edges or it did not, and
  // both readings belong in the closing summary rather than in an exit.
  let abandoned = false;
  const removeHook = onSignal(session, () => {
    abandoned = true;
  });

  const deadline = deps.now() + CUTOVER_TIMEOUT_MILLISECONDS;
  let sawCertificateMismatch = false;
  let sawOriginRejection = false;
  // Where the poll had got to, for a wait that ends with nothing decisive to
  // report. "Still this server" is the honest starting value: it is the state
  // the record was left in, and what a wait stopped before its first answer
  // knows.
  let lastQuiet: CutoverQuietSighting = "still-this-server";
  /**
   * What the wait concluded when it ran out of time or the user stopped it.
   * The rejection outranks the certificate report: seeing it means CloudFront
   * already answers the viewer name, handshake included. Both outrank the stop
   * itself — an observed problem is worth reporting however the wait ended.
   */
  const conclude = (): CutoverOutcome =>
    sawOriginRejection
      ? { kind: "origin-header-rejected" }
      : sawCertificateMismatch
        ? { kind: "certificate-name" }
        : abandoned
          ? { kind: "stopped", seen: lastQuiet }
          : { kind: "timed-out", seen: lastQuiet };

  try {
    for (;;) {
      // Whatever the poll had already seen still decides the report: an
      // abandoned wait must not fabricate a cutover that has not happened,
      // nor bury a rejection it did observe.
      if (abandoned) {
        return conclude();
      }

      const response = await requestThrough(
        deps,
        storageDomain,
        DISTRIBUTION_PROBE_PATH,
      );
      const probe =
        response.kind === "answered"
          ? classifyDistributionProbe({
              headers: response.headers,
              status: response.status,
            })
          : null;
      if (probe?.kind === "served") {
        return { kind: "served" };
      }

      // Kept as a distinct state rather than a stop: a distribution deploying
      // an alternate-domain-name change serves its old certificate until the
      // change reaches every edge, so this clears on its own about as often as
      // it does not. What it must not do is masquerade as "the record has not
      // spread".
      const certificateName =
        response.kind === "failed" && response.failure === "certificate-name";
      sawCertificateMismatch ||= certificateName;
      // The relayed 403, by contrast, never clears on its own — but stopping
      // on the first one would misread CloudFront's brief error caching, so it
      // too is reported once the wait is over.
      const originRejected = probe?.kind === "origin-header-rejected";
      sawOriginRejection ||= originRejected;

      // Kept apart from the two findings above because it outlives the
      // repaint: it is also what a stopped wait reports having got to.
      lastQuiet =
        probe?.kind === "unhealthy"
          ? "unhealthy"
          : response.kind === "failed"
            ? "no-answer"
            : "still-this-server";

      session.progress.detail(
        renderCutoverWaitDetail(
          storageDomain,
          originRejected
            ? "origin-header-rejected"
            : certificateName
              ? "certificate-name"
              : lastQuiet,
        ),
      );

      if (deps.now() >= deadline || abandoned) {
        // Re-read after the probe, not only at the top of the loop: a press
        // that landed while the request was in flight would otherwise be
        // answered ten seconds later, long enough to read as ignored.
        return conclude();
      }

      await deps.sleep(CUTOVER_POLL_INTERVAL_MILLISECONDS);
    }
  } finally {
    removeHook();
  }
}

const CUTOVER_POLL_INTERVAL_MILLISECONDS = 10_000;
// Fifteen rather than ten: a distribution that is deploying an alternate
// domain name routinely takes longer than a DNS change to reach every edge,
// and this wait used to end while that was still in flight.
const CUTOVER_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;

/**
 * Waits for the origin hostname to answer a TLS handshake with a certificate
 * that covers it — the plan's "certificate still being issued — retrying"
 * wait.
 *
 * A handshake refusal or a wrong-name certificate here is what issuance in
 * flight looks like — an ACME-managed site usually refuses the handshake
 * until its order completes, and some setups answer with a placeholder
 * certificate instead — so both narrate as issuance rather than as a problem.
 * Only a successful handshake ends the wait early; the timeout and Ctrl+C
 * both mean "stop waiting and let the probes speak" — the misconfiguration
 * diagnosis stays unreachable until this wait has had its say.
 */
async function waitForOriginTls(
  deps: CommandDeps,
  session: SelfhostSession,
  originDomain: string,
): Promise<void> {
  session.progress.write(renderOriginTlsWaitStep(originDomain));

  // Ctrl+C means "stop waiting", not "kill the run" — the same hook every
  // other wait in the wizard installs.
  let abandoned = false;
  const removeHook = onSignal(session, () => {
    abandoned = true;
  });

  try {
    const deadline = deps.now() + ORIGIN_TLS_TIMEOUT_MILLISECONDS;
    // What the last handshake saw, so a stopped wait can settle on the same
    // line the timeout does. Refusal is the honest starting value: it is what
    // an origin whose certificate has not been issued yet answers, and it is
    // all a wait interrupted before its first handshake knows.
    let lastSeen: Exclude<TlsNameProbe, { kind: "covers" }> = {
      kind: "refused",
    };
    // Settled like the timeout branch: the last thing repainted was "still
    // being issued — retrying", and leaving that as the final word makes the
    // probes' diagnosis right after it read as a contradiction.
    const stopWaiting = () => {
      session.progress.write(renderOriginTlsWaitGaveUp(originDomain, lastSeen));
    };

    for (;;) {
      if (abandoned) {
        stopWaiting();
        return;
      }

      // The origin's own name as SNI: the question every CloudFront fetch
      // will ask once the distribution is in front of it.
      const handshake = await deps.probeTlsName({
        host: originDomain,
        servername: originDomain,
      });
      if (handshake.kind === "covers") {
        session.progress.write(`${originDomain} is serving HTTPS`);
        return;
      }

      lastSeen = handshake;

      if (deps.now() >= deadline) {
        // The last thing narrated was "still being issued, retrying"; left as
        // the final word, the probes' diagnosis right after it reads as a
        // contradiction. Settle the wait's own ending first — and when the
        // window closed on a certificate for another name, carry that name:
        // it is a strong hint the hostname reaches a different server, and
        // the one piece of evidence the probes cannot see.
        session.progress.write(
          renderOriginTlsWaitGaveUp(originDomain, handshake),
        );
        return;
      }

      session.progress.detail(
        renderOriginTlsWaitDetail(
          originDomain,
          // A TLS-layer answer — refused, or a certificate for another name —
          // is issuance in flight; only a network-layer failure is narrated
          // as the host not answering at all.
          handshake.kind === "unreachable" ? "no-answer" : "issuing",
        ),
      );

      // Re-read after the handshake, not only at the top of the loop: a press
      // that landed while it was in flight would otherwise wait out the whole
      // interval before anything happened.
      if (abandoned) {
        stopWaiting();
        return;
      }

      await deps.sleep(ORIGIN_TLS_POLL_INTERVAL_MILLISECONDS);
    }
  } finally {
    removeHook();
  }
}

const ORIGIN_TLS_POLL_INTERVAL_MILLISECONDS = 5_000;
// Five minutes covers a routine Let's Encrypt issuance (usually well under
// one) with room for an ACME retry, without holding a genuinely broken origin
// hostage for the cutover wait's fifteen.
const ORIGIN_TLS_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;

/**
 * Returns null when both probes pass, or the lines explaining which one did
 * not. Split from the loop above so the two failure shapes stay readable.
 */
async function probeBeforeCutover(
  deps: CommandDeps,
  session: SelfhostSession,
  input: {
    distributionDomain: string;
    originDomain: string;
    storageDomain: string;
  },
): Promise<string[] | null> {
  // Only ever shown, never carried into the summary, so it may be coloured.
  const palette = paletteFor(deps);
  session.progress.write(`checking ${input.distributionDomain}`);
  // The readiness path, not the synthetic one: its status is what separates a
  // distribution whose origin-verify header the server accepts (2xx) from one
  // whose requests the server refuses (a relayed 403) — the synthetic path
  // answers 403 in both cases, because the bucket policy has no ListBucket.
  const distribution = await requestThrough(
    deps,
    input.distributionDomain,
    DISTRIBUTION_PROBE_PATH,
  );
  if (distribution.kind === "failed") {
    return renderCloudFrontProbeProblem(
      { kind: "unreachable" },
      input,
      palette,
    );
  }

  const probe = classifyDistributionProbe({
    headers: distribution.headers,
    status: distribution.status,
  });
  if (probe.kind !== "served") {
    return renderCloudFrontProbeProblem(probe, input, palette);
  }

  // The check fetch cannot make: a request to the distribution domain sends
  // that domain as SNI, and CloudFront answers it with its default
  // certificate whether or not the alternate domain name is attached. Asking
  // for the viewer name in the handshake is exactly what every device will do
  // after the cutover — so a distribution missing the name is caught here,
  // while the record still points at the server, instead of as an outage.
  session.progress.write(
    `checking ${input.distributionDomain} answers for ${input.storageDomain}`,
  );
  const claim = await deps.probeTlsName({
    host: input.distributionDomain,
    servername: input.storageDomain,
  });
  if (claim.kind === "wrong-name" || claim.kind === "refused") {
    return renderCloudFrontProbeProblem(
      {
        certificateFor: claim.kind === "wrong-name" ? claim.certificateFor : null,
        kind: "name-not-claimed",
      },
      input,
      palette,
    );
  }

  if (claim.kind === "unreachable") {
    // It answered the HTTPS probe moments ago, so this is transient — the
    // "still deploying, keep trying" copy is the right advice either way.
    return renderCloudFrontProbeProblem({ kind: "unreachable" }, input, palette);
  }

  // The same path against the origin hostname, deliberately **without** the
  // verification header CloudFront sends: the answer must be a refusal, or the
  // cutover would leave storage open to anyone who knows the hostname.
  session.progress.write(`checking ${input.originDomain} is protected`);
  const origin = await requestThrough(
    deps,
    input.originDomain,
    SYNTHETIC_PROBE_PATH,
  );
  if (origin.kind === "failed") {
    return renderCloudFrontProbeProblem({ kind: "origin-unreachable" }, input, palette);
  }

  const originProbe = classifyOriginProbe({ status: origin.status });
  return originProbe.kind === "protected"
    ? null
    : renderCloudFrontProbeProblem(originProbe, input, palette);
}

type ProbeResult =
  | { headers: Headers; kind: "answered"; status: number }
  | { failure: RequestFailure; kind: "failed" };

/**
 * Why the failure is carried rather than flattened to null: a certificate that
 * does not cover the hostname is permanent, and the cutover wait has to stop
 * on it instead of polling for ten minutes as if DNS were still spreading.
 */
async function requestThrough(
  deps: CommandDeps,
  hostname: string,
  path: string,
): Promise<ProbeResult> {
  try {
    const response = await deps.fetch(`https://${hostname}${path}`, {
      redirect: "manual",
    });
    return {
      headers: response.headers,
      kind: "answered",
      status: response.status,
    };
  } catch (error) {
    return { failure: classifyRequestFailure(error), kind: "failed" };
  }
}
