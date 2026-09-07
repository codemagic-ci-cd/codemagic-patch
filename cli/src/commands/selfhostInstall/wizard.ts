/**
 * The wizard proper: the recovery question a rerun opens with, the answers a
 * first install collects, the GitHub OAuth pair, and the repair edge's smaller
 * version of all of it.
 */

import { PRODUCT_NAME } from "../../branding";
import {
  checkAccessKeyId,
  checkDistributionId,
  checkSecretAccessKey,
} from "../../providers/cloudfront";
import {
  buildOAuthAppUrl,
  callbackUrl,
  checkGithubPair,
  checkGithubPairShape,
} from "../../providers/github";
import { detectDnsProvider, findZoneApex } from "../../selfhostDns";
import {
  buildRepairEnv,
  defaultRecoveryEdge,
  type DeliverySelection,
  type InstallAnswers,
  type InstallState,
  type RecoveryEdge,
  type RepairScope,
  type RepairValues,
} from "../../selfhostInstall";
import {
  renderCdnPurpose,
  renderCloudflareUnavailable,
  renderIncompleteIntro,
  renderOAuthFormValues,
  renderOAuthIntro,
  renderOAuthShapeProblem,
} from "../../selfhostSetupCopy";
import {
  readBooleanFlag,
  readStringFlag,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { type CommandDeps } from "../shared";
import {
  askChecked,
  askDomain,
  askSelect,
  askValue,
  noteBlock,
  notice,
  offerBrowserOpen,
  paletteFor,
} from "./ask";
import {
  deliveryFlagsComplete,
  readDelivery,
  readInstallAnswers,
  readRepairValues,
  suggestStorageDomain,
  supplied,
} from "./answers";
import { collectCloudflare, repairCloudflare } from "./cloudflare";
import { collectCloudFront } from "./cloudfront";
import { runDnsStep } from "./dns";

// ---------------------------------------------------------------------------
// The wizard: picking up an install that did not finish
// ---------------------------------------------------------------------------

export async function askRecoveryEdge(
  deps: CommandDeps,
  session: SelfhostSession,
  state: Extract<InstallState, { kind: "incomplete" }>,
): Promise<RecoveryEdge> {
  session.progress.settle();
  notice(deps, renderIncompleteIntro(state));

  const choices = [
    { title: "Try again with the same settings", value: "resume" },
    { title: "Change a setting I got wrong, then try again", value: "repair" },
    { title: "Start from scratch (deletes what is there)", value: "start-over" },
  ];
  // Defaulted from what the previous run died on: replaying a wrong value
  // cannot help, and re-asking for values that were right wastes the user's
  // time. Both are only defaults — every edge stays reachable.
  const preferred = defaultRecoveryEdge(state.failure);

  const chosen = await askSelect(deps, {
    choices,
    fallback: "",
    initial: choices.findIndex((choice) => choice.value === preferred),
    message: "How would you like to continue?",
  });
  return chosen === "repair" || chosen === "start-over" ? chosen : "resume";
}

// ---------------------------------------------------------------------------
// The wizard: collecting the answers
// ---------------------------------------------------------------------------

export async function collectAnswers(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  interactive: boolean,
): Promise<InstallAnswers> {
  if (!interactive) {
    return readInstallAnswers(deps, parsed);
  }

  session.progress.settle();

  const apiDomain =
    readStringFlag(parsed, "--api-domain") ??
    (await askDomain(deps, {
      message: "What domain should your server use?",
      purpose:
        "This is the address your apps check for updates, and where you sign in to the dashboard. A subdomain of a domain you own works well: updates.example.com.",
    }));

  const storageDomain =
    readStringFlag(parsed, "--storage-domain") ??
    (await askDomain(deps, {
      initial: await suggestStorageDomain(deps, apiDomain),
      message: "What domain should downloads use?",
      purpose:
        "Update files are served from a second address, so they can be cached separately from the server itself. The suggested one is fine unless you have a reason to change it.",
    }));

  const adminEmail =
    readStringFlag(parsed, "--email") ?? (await askAdminEmail(deps));

  await runDnsStep(deps, session, [
    { hostname: apiDomain, purpose: "The address your apps and dashboard use" },
    {
      hostname: storageDomain,
      purpose: "The address update files are downloaded from",
    },
  ]);

  const flagClientId = readStringFlag(parsed, "--github-oauth-client-id");
  const flagClientSecret = supplied(deps, parsed, {
    env: "GITHUB_OAUTH_CLIENT_SECRET",
    flag: "--github-oauth-client-secret",
  })?.value;
  const github =
    flagClientId !== undefined &&
    flagClientSecret !== undefined &&
    flagClientSecret.length > 0
      ? { clientId: flagClientId, clientSecret: flagClientSecret }
      : await collectGithubPair(deps, apiDomain);

  return {
    adminEmail,
    apiDomain,
    delivery: await chooseDelivery(
      deps,
      session,
      parsed,
      apiDomain,
      storageDomain,
    ),
    githubClientId: github.clientId,
    githubClientSecret: github.clientSecret,
    storageDomain,
  };
}

// ---------------------------------------------------------------------------
// The wizard: the CDN
// ---------------------------------------------------------------------------

/**
 * Offered on a first install only.
 *
 * The delivery adapter is fixed when the env file is written — switching it
 * later is not something `--repair-env` will do — so the resume and repair
 * edges never reach this, and the select is not a place a rerun can change its
 * mind.
 */
async function chooseDelivery(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  apiDomain: string,
  storageDomain: string,
): Promise<DeliverySelection> {
  const flagged = readBooleanFlag(parsed, "--cloudflare")
    ? ("cloudflare" as const)
    : readBooleanFlag(parsed, "--cloudfront")
      ? ("cloudfront" as const)
      : null;

  // Flags win outright when they carry the whole answer. A flag that only
  // names the CDN instead skips the select and lands in that CDN's collector
  // below: the values it lacks — the zone id, the distribution — are exactly
  // what the collectors exist to derive, and demanding them as flags would
  // dead-end the run the help text invites.
  if (flagged !== null && deliveryFlagsComplete(deps, parsed, flagged)) {
    return readDelivery(deps, parsed);
  }

  const zone = await findZoneApex(storageDomain, deps.dnsClient);
  const nameservers = zone === null ? [] : await deps.dnsClient.resolveNs(zone);
  // Listed (and defaulted) only when the domain's nameservers say it really is
  // on Cloudflare: offering it otherwise sends the user to create a token on
  // an account that cannot serve this domain.
  const provider = detectDnsProvider(nameservers);
  const onCloudflare = provider?.name === "Cloudflare";

  let chosen: string;
  if (flagged !== null) {
    chosen = flagged;
  } else {
    notice(deps, renderCdnPurpose());

    const choices = [
      ...(onCloudflare
        ? [{ title: "Cloudflare (this domain is already on it)", value: "cloudflare" }]
        : []),
      {
        title: "Amazon CloudFront (set up by hand in the AWS Console)",
        value: "cloudfront",
      },
      { title: "No CDN for now — I can turn it on later", value: "none" },
      ...(onCloudflare
        ? []
        : [
            {
              title: "Cloudflare (not available: this domain is not on Cloudflare)",
              value: "unavailable",
            },
          ]),
    ];

    // The unavailable row is a question, not an answer: it is listed so the
    // option is discoverable, and picking it earns the explanation and the
    // select again. Proceeding from it — which is what it used to do — would
    // commit the install to no CDN on a press the user meant as "I want
    // Cloudflare", and this select is offered on the first install only.
    for (;;) {
      chosen = await askSelect(deps, {
        choices,
        fallback: "none",
        initial: 0,
        message: "How should update files be delivered?",
      });
      if (chosen !== "unavailable") {
        break;
      }

      notice(
        deps,
        renderCloudflareUnavailable({
          // Every DNS failure on the way here reads as an empty answer, so what
          // the copy may claim depends on whether anything was read at all.
          nameserversRead: nameservers.length > 0,
          storageDomain,
          zone,
        }),
      );
    }
  }

  if (chosen === "cloudfront") {
    return collectCloudFront(deps, session, parsed, {
      apiDomain,
      provider,
      storageDomain,
      zone,
    });
  }

  if (chosen !== "cloudflare") {
    return { kind: "none" };
  }

  return collectCloudflare(deps, parsed, {
    nameserversAreCloudflare: onCloudflare,
    storageDomain,
    zone,
  });
}

async function askAdminEmail(deps: CommandDeps): Promise<string> {
  // The match matters: the server creates the admin account for whoever signs
  // in with this address, and GitHub only reports an address it has verified.
  notice(deps, [
    "Which email address should be the administrator? Use the verified primary email of the GitHub account you will sign in with — that is how the server knows which account is yours.",
    "Not sure which one is primary? It is listed at https://github.com/settings/emails",
  ]);

  return askChecked(deps, {
    check: (value) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
        ? null
        : "That does not look like an email address.",
    message: "Administrator email",
    type: "text",
  });
}

// ---------------------------------------------------------------------------
// The wizard: the GitHub OAuth app
// ---------------------------------------------------------------------------

async function collectGithubPair(
  deps: CommandDeps,
  apiDomain: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const creationUrl = buildOAuthAppUrl({ apiDomain, name: PRODUCT_NAME });
  notice(deps, renderOAuthIntro({ creationUrl }));
  noteBlock(
    deps,
    "What the form needs",
    renderOAuthFormValues(
      { apiDomain, callbackUrl: callbackUrl(apiDomain), name: PRODUCT_NAME },
      paletteFor(deps),
    ),
  );

  await offerBrowserOpen(deps, {
    message: "Open GitHub in your browser?",
    url: creationUrl,
  });

  for (;;) {
    const clientId = await askValue(deps, {
      message: "Client ID",
      type: "text",
    });
    // A password prompt, so the secret is not left on screen or in the
    // terminal's scrollback for whoever looks next.
    const clientSecret = await askValue(deps, {
      message: "Client secret",
      type: "password",
    });

    const problem = checkGithubPairShape(clientId, clientSecret);
    if (problem !== null) {
      notice(deps, renderOAuthShapeProblem(problem));
      continue;
    }

    const check = await checkGithubPair({
      clientId,
      clientSecret,
      fetch: deps.fetch,
    });

    if (check.kind === "valid") {
      notice(deps, "Checked with GitHub — these work.");
      return { clientId, clientSecret };
    }

    if (check.kind === "unknown") {
      // Never a failure: the pair is checked for real at the first sign-in,
      // and refusing to continue here would strand anyone behind a proxy.
      notice(
        deps,
        `Could not reach GitHub to check these (${check.reason}). Continuing — they are checked again the first time someone signs in.`,
      );
      return { clientId, clientSecret };
    }

    notice(
      deps,
      "GitHub did not accept that pair. The client ID is right at the top of the app's page; the secret is only shown once, so if it has been closed, generate a new one.",
    );
  }
}

// ---------------------------------------------------------------------------
// The wizard: repairing one thing
// ---------------------------------------------------------------------------

export async function collectRepairValues(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  interactive: boolean,
  scope: RepairScope,
): Promise<Record<string, string>> {
  if (!interactive) {
    return readRepairValues(deps, parsed);
  }

  // Only the values the failure implicates. Re-asking everything would make
  // the user retype answers that were right and are already recorded, which is
  // the difference between this edge and starting over.
  //
  // *Every* value a failure implicates, though. The installer's checks cannot
  // tell the halves of a credential apart — one Cloudflare failure covers the
  // token, the zone id, the account, and a hostname outside the zone; one
  // CloudFront failure covers the distribution and either half of the key — so
  // asking for a single field per failure leaves the other causes with no way
  // out of the wizard at all.
  const values: RepairValues = {};

  if (scope === "all" || scope === "domains") {
    values.apiDomain = await askDomain(deps, {
      message: "What domain should your server use?",
      purpose: "This is the one to correct if the server was never reachable.",
    });
    values.storageDomain = await askDomain(deps, {
      initial: await suggestStorageDomain(deps, values.apiDomain),
      message: "What domain should downloads use?",
    });
  }

  if (scope === "all" || scope === "oauth") {
    const pair = await collectGithubPair(
      deps,
      await apiDomainForOAuthRepair(deps, session, parsed, values.apiDomain),
    );
    values.githubClientId = pair.clientId;
    values.githubClientSecret = pair.clientSecret;
  }

  if (scope === "cloudflare") {
    const repaired = await repairCloudflare(deps, session, parsed);
    values.cloudflareApiToken = repaired.apiToken;
    values.cloudflareZoneId = repaired.zoneId;
  }

  if (scope === "cloudfront") {
    notice(
      deps,
      "CloudFront would not accept a cache-clearing request with these settings. Any of the three can be the cause — the distribution, or either half of the key — so all three are asked again.",
    );
    values.cloudfrontDistributionId = await askChecked(deps, {
      check: checkDistributionId,
      message: "Distribution ID",
      type: "text",
    });
    values.cloudfrontAccessKeyId = await askChecked(deps, {
      check: checkAccessKeyId,
      message: "Access key ID",
      type: "text",
    });
    values.cloudfrontSecretAccessKey = await askChecked(deps, {
      check: checkSecretAccessKey,
      message: "Secret access key",
      type: "password",
    });
  }

  const env = buildRepairEnv(values);
  if (Object.keys(env).length === 0) {
    return readRepairValues(deps, parsed);
  }

  return env;
}

/**
 * The domain the GitHub callback URL is built from.
 *
 * An OAuth-only repair collects no domain, so without the deployment's own
 * settings the intro would print `https:///auth/callback` — a URL GitHub
 * rejects and the user has no way to correct from inside the wizard.
 */
async function apiDomainForOAuthRepair(
  deps: CommandDeps,
  session: SelfhostSession,
  parsed: ParsedArgs,
  collected: string | undefined,
): Promise<string> {
  const known =
    collected ??
    readStringFlag(parsed, "--api-domain") ??
    hostOfUrl(session.facts.serverUrl);
  if (known !== undefined && known.length > 0) {
    return known;
  }

  return askDomain(deps, {
    message: "What domain does your server use?",
    purpose:
      "The GitHub callback URL is built from it, and this machine has no record of it.",
  });
}

function hostOfUrl(url: string | null): string | undefined {
  if (url === null) {
    return undefined;
  }

  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
