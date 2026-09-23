/**
 * The wizard proper: the recovery question a rerun opens with, the answers a
 * first install collects, the OAuth pair, and the repair edge's smaller
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
  checkOAuthCredential,
  defaultRecoveryEdge,
  describeDomainProblem,
  OAUTH_PROVIDERS,
  type DeliverySelection,
  type OAuthExtraRepair,
  type InstallAnswers,
  type OAuthCredentials,
  type OAuthExtraField,
  type OAuthProvider,
  type InstallState,
  type RecoveryEdge,
  type RepairScope,
  type RepairValues,
} from "../../selfhostInstall";
import {
  oauthAppUrl,
  renderCdnPurpose,
  renderCloudflareUnavailable,
  renderIncompleteIntro,
  renderManualOAuthFormValues,
  renderManualOAuthVerifiedLater,
  renderOAuthFormValues,
  renderOAuthIntro,
  renderOAuthRepairIntro,
  renderOAuthShapeProblem,
} from "../../selfhostSetupCopy";
import {
  readBooleanFlag,
  readStringFlag,
  type ParsedArgs,
  type SelfhostSession,
} from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
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
  readNonOAuthRepairValues,
  suggestStorageDomain,
  checkSuppliedOAuthCredentials,
  suppliedOAuthProvider,
  suppliedOAuthCredentials,
} from "./answers";
import { collectCloudflare, repairCloudflare } from "./cloudflare";
import { collectCloudFront } from "./cloudfront";
import { runDnsStep } from "./dns";
import { chooseStorage, prepareExternalStorage } from "./storage";

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
    const answers = await readInstallAnswers(deps, parsed);
    const plan = await chooseStorage(deps, session, parsed, answers.apiDomain, false);
    if (readStringFlag(parsed, "--dns-setup") === "cloudflare") {
      await runDnsStep(deps, session, [
        { hostname: answers.apiDomain, purpose: "API and dashboard" },
        ...(plan === null ? [{ hostname: answers.storageDomain, purpose: "Downloads" }] : []),
        ...(plan === null && answers.delivery.kind === "cloudfront" && answers.delivery.storageOriginDomain
          ? [{ hostname: answers.delivery.storageOriginDomain, purpose: "CloudFront origin" }] : []),
      ], false);
    }
    if (plan === null) return answers;
    const external = await prepareExternalStorage(deps, session, parsed, plan, false);
    return { ...answers, ...external, storageDomain: "" };
  }

  session.progress.settle();

  const apiDomain =
    readStringFlag(parsed, "--api-domain") ??
    (await askDomain(deps, {
      message: "What domain should your server use?",
      purpose:
        "This is the address your apps check for updates, and where you sign in to the dashboard. A subdomain of a domain you own works well: updates.example.com.",
    }));

  const apiProblem = describeDomainProblem(apiDomain);
  if (apiProblem) throw new UsageError(apiProblem);

  const storagePlan = await chooseStorage(deps, session, parsed, apiDomain, true);

  const storageDomain = storagePlan !== null ? "" :
    readStringFlag(parsed, "--storage-domain") ??
    (await askDomain(deps, {
      initial: await suggestStorageDomain(deps, apiDomain),
      message: "What domain should downloads use?",
      differentFrom: [apiDomain],
      purpose:
        "Update files are served from a second address, so they can be cached separately from the server itself. The suggested one is fine unless you have a reason to change it.",
    }));

  if (storagePlan === null) {
    const problem = describeDomainProblem(storageDomain);
    if (problem) throw new UsageError(problem);
    if (apiDomain.toLowerCase() === storageDomain.toLowerCase())
      throw new UsageError("The API and download hostnames must differ.");
  }

  await runDnsStep(deps, session, [
    { hostname: apiDomain, purpose: "The address your apps and dashboard use" },
    ...(storagePlan === null ? [{
      hostname: storageDomain,
      purpose: "The address update files are downloaded from",
    }] : []),
  ], true);

  // The OAuth pair and the administrator email come before storage
  // provisioning and the CDN walkthrough: provisioning creates cloud
  // resources, and the runtime secret it generates lives only in memory until
  // install.sh writes the env file, so no question may sit between the two —
  // a rerun after an interruption there finds no env file and provisions
  // again.
  // An install always collects the pair; the origin-only outcome is a repair's.
  const oauth = (await collectOAuth(deps, parsed, apiDomain)) as OAuthCredentials;

  const adminEmail =
    readStringFlag(parsed, "--email") ?? (await askAdminEmail(deps, oauth.provider));

  const storageAnswers = storagePlan !== null
    ? {
        ...await prepareExternalStorage(deps, session, parsed, storagePlan, true),
        storageDomain: "",
      }
    : {
        delivery: await chooseDelivery(deps, session, parsed, apiDomain, storageDomain),
        storageDomain,
      };

  return {
    ...storageAnswers,
    adminEmail,
    apiDomain,
    oauth,
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

async function askAdminEmail(deps: CommandDeps, provider: OAuthProvider): Promise<string> {
  // The match matters: the server creates the admin account for whoever signs
  // in with this address, and GitHub only reports an address it has verified.
  notice(deps, [
    `Which email address should be the administrator? Use the verified primary email of the ${OAUTH_PROVIDERS[provider].displayName} account you will sign in with — that is how the server knows which account is yours.`,
    ...(provider === "github" ? ["Not sure which one is primary? It is listed at https://github.com/settings/emails"] : []),
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
// The wizard: the OAuth provider and application
// ---------------------------------------------------------------------------

/** The pair, or on a repair handed only the extra fields (the GitLab origin), just those. */
async function collectOAuth(
  deps: CommandDeps,
  parsed: ParsedArgs,
  apiDomain: string,
  intent: "install" | "repair" = "install",
  /** The deployed extra-field values by provider and flag suffix, for repair guidance only. */
  deployedExtra: Partial<Record<OAuthProvider, Record<string, string | null>>> = {},
): Promise<OAuthCredentials | OAuthExtraRepair> {
  const provider = suppliedOAuthProvider(deps, parsed) ?? (await askSelect(deps, {
    message: "Which provider should people use to sign in to Codemagic Patch?",
    choices: Object.entries(OAUTH_PROVIDERS).map(([value, { displayName }]) => ({ value, title: displayName })),
    fallback: "github",
    initial: 0,
  }) as OAuthProvider);
  const pair = suppliedOAuthCredentials(deps, parsed, provider);
  checkSuppliedOAuthCredentials(provider, pair);
  const extra = await collectOAuthExtraFields(deps, provider, pair.extra, intent);
  const credentials = Object.keys(extra).length > 0 ? { extra } : {};
  if (pair.clientId && pair.clientSecret) {
    return { provider, clientId: pair.clientId, clientSecret: pair.clientSecret, ...credentials };
  }
  if (provider === "github") return { provider, ...await collectGithubPair(deps, apiDomain, pair, intent) };

  // Past GitHub's own flow, every provider walks its page by hand.
  const { app, clientIdLabel, clientSecretLabel, displayName } = OAUTH_PROVIDERS[provider];
  // A supplied value aims the guidance; on a repair the deployed one does
  // when nothing was supplied, and it never enters the repair payload.
  const deployed = Object.fromEntries(
    Object.entries(intent === "repair" ? deployedExtra[provider] ?? {} : {}).filter((entry): entry is [string, string] => entry[1] !== null),
  );
  const appUrl = oauthAppUrl(provider, { ...deployed, ...extra });
  if (intent === "repair") {
    notice(deps, renderOAuthRepairIntro({ callbackUrl: callbackUrl(apiDomain), provider, settingsUrl: appUrl }));
    noteBlock(deps, "Check these options", [...app.create.options]);
  } else {
    notice(deps, [app.create.whereToCreate, appUrl]);
    notice(deps, renderManualOAuthFormValues({ callbackUrl: callbackUrl(apiDomain), provider }));
    noteBlock(deps, "Select these options", [...app.create.options]);
    notice(deps, app.create.afterSave);
  }
  await offerBrowserOpen(deps, {
    message: `Open ${displayName} in your browser?`,
    url: appUrl,
  });
  // A repair that was handed only the extra fields (the origin) may be
  // nothing but those: the pair is kept when the ID is left empty, so a
  // mistyped address does not cost a "Renew secret" round-trip.
  const extraOnly = intent === "repair" && Object.keys(extra).length > 0 && !pair.clientId && !pair.clientSecret;
  const clientId = pair.clientId || (extraOnly
    ? await askOptionalCredential(deps, `${clientIdLabel} (Enter to keep the current ID and secret)`)
    : await askChecked(deps, { check: checkOAuthCredential, message: clientIdLabel, type: "text" }));
  if (clientId === "" && extraOnly) return { provider, extra };
  const clientSecret = pair.clientSecret || await askChecked(deps, { check: checkOAuthCredential, message: clientSecretLabel, type: "password" });
  notice(deps, renderManualOAuthVerifiedLater(provider));
  return { provider, clientId, clientSecret, ...credentials };
}

/** A credential prompt Enter may leave empty; anything typed gets the shape check. */
async function askOptionalCredential(deps: CommandDeps, message: string): Promise<string> {
  for (;;) {
    const value = await askValue(deps, { message, optional: true, type: "text" });
    const problem = value === "" ? null : checkOAuthCredential(value);
    if (problem === null) return value;
    notice(deps, problem);
  }
}

/**
 * The provider's extra fields, ahead of the credential shortcut: a pair
 * supplied in advance says nothing about which instance issued it. A supplied
 * value is kept, normalized. Otherwise a first install asks, and Enter keeps
 * the default, which is then left unset rather than written out. A repair
 * does not ask: the deployed env file already holds the value and
 * `--repair-env` leaves unsupplied keys alone, so only an explicit flag or
 * variable changes it.
 */
async function collectOAuthExtraFields(
  deps: CommandDeps,
  provider: OAuthProvider,
  suppliedExtra: Record<string, string>,
  intent: "install" | "repair",
): Promise<Record<string, string>> {
  const extra: Record<string, string> = {};
  for (const field of OAUTH_PROVIDERS[provider].extraFields) {
    const suppliedValue = suppliedExtra[field.flag];
    const value = suppliedValue !== undefined
      ? field.normalize(suppliedValue)
      : intent === "repair" ? undefined : await askOAuthExtraField(deps, field);
    if (value !== undefined) extra[field.flag] = value;
  }
  return extra;
}

/** The normalized answer, or undefined when Enter kept the default. */
async function askOAuthExtraField(deps: CommandDeps, field: OAuthExtraField): Promise<string | undefined> {
  const value = field.normalize(await askChecked(deps, {
    check: field.check,
    initial: field.default,
    message: field.prompt,
    type: "text",
  }));
  return value === field.default ? undefined : value;
}

async function collectGithubPair(
  deps: CommandDeps,
  apiDomain: string,
  suppliedPair: { clientId?: string; clientSecret?: string } = {},
  intent: "install" | "repair" = "install",
): Promise<{ clientId: string; clientSecret: string }> {
  const url = intent === "repair"
    ? oauthAppUrl("github")
    : buildOAuthAppUrl({ apiDomain, name: PRODUCT_NAME });
  if (intent === "repair") {
    notice(deps, renderOAuthRepairIntro({ callbackUrl: callbackUrl(apiDomain), provider: "github", settingsUrl: url }));
  } else {
    notice(deps, renderOAuthIntro({ creationUrl: url }));
    noteBlock(
      deps,
      "What the form needs",
      renderOAuthFormValues(
        { apiDomain, callbackUrl: callbackUrl(apiDomain), name: PRODUCT_NAME },
        paletteFor(deps),
      ),
    );
  }

  await offerBrowserOpen(deps, {
    message: "Open GitHub in your browser?",
    url,
  });

  for (;;) {
    const clientId = suppliedPair.clientId || await askValue(deps, {
      message: "Client ID",
      type: "text",
    });
    // A password prompt, so the secret is not left on screen or in the
    // terminal's scrollback for whoever looks next.
    const clientSecret = suppliedPair.clientSecret || await askValue(deps, {
      message: "Client secret",
      type: "password",
    });

    const problem = checkGithubPairShape(clientId, clientSecret);
    if (problem !== null) {
      const suppliedValueIsInvalid =
        (problem === "client-id-shape" && suppliedPair.clientId) ||
        (problem === "client-secret-shape" && suppliedPair.clientSecret);
      if (suppliedValueIsInvalid) throw new UsageError(renderOAuthShapeProblem(problem));
      if (problem === "swapped") suppliedPair = {};
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

    // A rejected pair does not identify which half is wrong. Let the user
    // correct both, including a value initially supplied through flags/env.
    suppliedPair = {};
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
    return readRepairValues(deps, parsed, scope);
  }
  if (scope === "oauth-only") readNonOAuthRepairValues(deps, parsed, scope);

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
    if (session.facts.storageMode !== "s3" && session.facts.storageMode !== "gcs") {
      values.storageDomain = await askDomain(deps, {
        initial: await suggestStorageDomain(deps, values.apiDomain),
        message: "What domain should downloads use?",
      });
    }
  }

  if (scope === "all" || scope === "oauth" || scope === "oauth-only") {
    notice(deps, "Choose the provider whose credentials need correcting. Other configured providers keep their settings.");
    values.oauth = await collectOAuth(
      deps, parsed,
      await apiDomainForOAuthRepair(deps, session, values.apiDomain),
      "repair",
      { gitlab: { "base-url": session.facts.gitlabBaseUrl } },
    );
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
 * The domain the OAuth callback URL is built from.
 *
 * An OAuth-only repair collects no domain, so without the deployment's own
 * settings the intro would print `https:///auth/callback` — a URL GitHub
 * rejects and the user has no way to correct from inside the wizard.
 */
async function apiDomainForOAuthRepair(
  deps: CommandDeps,
  session: SelfhostSession,
  collected: string | undefined,
): Promise<string> {
  const known = collected ?? hostOfUrl(session.facts.serverUrl);
  if (known !== undefined && known.length > 0) {
    return known;
  }

  return askDomain(deps, {
    message: "What domain does your server use?",
    purpose:
      "The OAuth callback URL is built from it, and this machine has no record of it.",
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
