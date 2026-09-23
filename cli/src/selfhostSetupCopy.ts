/**
 * The words the install wizard says.
 *
 * Kept as pure `string[]` builders, apart from the flow that calls them, for
 * the same reason the provider clients are pure: the copy is the product here,
 * and it is easier to get right — and to keep right — when it can be read and
 * asserted in one place. Everything is written for someone setting up their
 * first server: no "env file", no "zone", no "A record" without saying what
 * to do with it.
 */

import { listOAuthProviders, OAUTH_PROVIDERS, type OAuthProvider } from "./selfhostInstall";
import {
  CLOUDFLARE_ENABLE_LATER_URL,
  CLOUDFLARE_VERIFY_DOCS_URL,
  PRODUCT_NAME,
} from "./branding";
import { PLAIN_PALETTE, type Palette } from "./output";
import { ORIGIN_VERIFY_HEADER } from "./providers/cloudfront";
import {
  DEFAULT_POLL_INTERVAL_MILLISECONDS,
  DEFAULT_POLL_TIMEOUT_MILLISECONDS,
  type CnameDiagnosis,
  type DnsProvider,
  type RecordDiagnosis,
} from "./selfhostDns";
import { isIP } from "node:net";
import { publicIpv4OrNull } from "./selfhostRemote";

// ---------------------------------------------------------------------------
// Before the first question
// ---------------------------------------------------------------------------

/**
 * What the install will ask for outside this terminal, said up front.
 *
 * Every one of these surfaced mid-run before: the DNS wait, the OAuth form
 * and the CDN dashboards each arrived as a surprise to someone who had opened
 * the terminal expecting the command to do the work. Printed once, before the
 * ssh question, and not on a rerun — a `--resume` or `--repair` has already
 * seen it. The body of a titled block; the title is the caller's.
 */
export function renderBeforeYouStart(): string[] {
  return [
    "The install asks you to do a few things outside this terminal along the way, so have these ready:",
    "",
    "  1. A server to install onto",
    "     A fresh Linux VPS (Ubuntu or Debian is the usual choice) with at least 2 GB of RAM, and SSH access to it as root or a user with sudo.",
    "",
    "  2. Access to your domain's DNS",
    "     You will add two records at your DNS provider, and the install waits until they resolve.",
    "",
    `  3. A ${listOAuthProviders((provider) => OAUTH_PROVIDERS[provider].displayName)} account that can create an OAuth app`,
    `     Your chosen provider handles sign-in, so the install has you register the server there.`,
    "",
    "  4. Optional: a Cloudflare or AWS account for the CDN",
    "     Update files can be served through a CDN. Skipping this keeps the install complete; you can add it later.",
    "",
    "Nothing is installed until the DNS records are in place, so stopping at any question before then leaves nothing behind.",
  ];
}

export type DnsRecordRequest = {
  /** The full hostname the record is for. */
  hostname: string;
  /** One line saying what this record is for, in the user's terms. */
  purpose: string;
  type: "A" | "CNAME";
  value: string;
};

/**
 * One numbered block per record.
 *
 * Both spellings of the Name field are printed: consoles are split between
 * wanting the full hostname and wanting only the part in front of the domain,
 * and a user who types the wrong one ends up with
 * `updates.example.com.example.com` — which then reads as "the record is
 * missing" for the rest of the setup.
 *
 * The type, the name and the value are what gets entered in the console, and
 * are the only things the palette touches.
 */
export function renderDnsRecordBlock(
  record: DnsRecordRequest,
  index: number | null,
  zone: string | null,
  palette: Palette = PLAIN_PALETTE,
): string[] {
  const relative =
    zone !== null && record.hostname.endsWith(`.${zone}`)
      ? record.hostname.slice(0, -(zone.length + 1))
      : null;

  return [
    // Unnumbered when it stands alone: a "1." inside the ①②③ walkthrough
    // reads as a fourth screen to visit.
    index === null ? `  ${record.purpose}` : `  ${String(index)}. ${record.purpose}`,
    `       Type   ${palette.value(record.type)}`,
    relative === null
      ? `       Name   ${palette.value(record.hostname)}`
      : `       Name   ${palette.value(relative)}   (some consoles want the whole ${record.hostname})`,
    `       Value  ${palette.value(record.value)}`,
    // Not a number: consoles disagree about units and about whether "Auto" is
    // an option, and the only thing that matters is that it is short while the
    // records are still being set up.
    "       TTL    the lowest value offered (often 60 or \"Auto\")",
  ];
}

/**
 * The paragraph before the records: why they are needed, and where they go.
 * The records themselves are `renderDnsRecords`, boxed under their own title.
 */
export function renderDnsIntro(input: {
  provider: DnsProvider | null;
  nameservers: readonly string[];
}): string[] {
  const lines = [
    "Your server needs a name people's apps can reach it by, so the next step is adding records to your domain.",
    "",
  ];

  if (input.provider !== null) {
    lines.push(
      `Your domain's records are managed by ${input.provider.name}:`,
      `  ${input.provider.consoleUrl}`,
    );
  } else if (input.nameservers.length > 0) {
    // Naming what was found beats a generic instruction: the nameserver
    // hostname is usually enough for a user to recognise their own provider.
    lines.push(
      "Your domain's records are managed by whoever runs these nameservers:",
      ...input.nameservers.map((nameserver) => `  ${nameserver}`),
    );
  } else {
    lines.push("Add these where you manage your domain's DNS records:");
  }

  // The cadence and the cap, said before the wait rather than at its end.
  lines.push(
    "",
    `Each record is checked every ${String(DEFAULT_POLL_INTERVAL_MILLISECONDS / 1_000)} seconds, for up to ${String(DEFAULT_POLL_TIMEOUT_MILLISECONDS / 60_000)} minutes.`,
  );

  return lines;
}

// ---------------------------------------------------------------------------
// The server's public address, when the server itself cannot say
// ---------------------------------------------------------------------------

/**
 * Said before the address is asked for. The survey reads it from the cloud's
 * metadata service or the interface, and both come back empty on a host
 * behind NAT (Oracle Cloud, a VM behind a router) or one that is IPv6-only —
 * and without it the records cannot be printed or checked.
 */
export function renderPublicAddressQuestion(input: {
  /** The hostname part of the ssh target — the thing that resolves. */
  host: string;
  resolvedFromTarget: string | null;
  sshTarget: string;
}): string[] {
  return [
    `Could not work out ${input.sshTarget}'s public IP address from the server itself — it reports no public address of its own, which is usual behind NAT (Oracle Cloud, a VM behind a router) or on an IPv6-only host.`,
    "The DNS records need it, so enter it here. It is on your provider's console page for this server.",
    ...(input.resolvedFromTarget === null
      ? []
      : [
          `${input.host} resolves to ${input.resolvedFromTarget} from this machine; press Enter if that is the server's public address.`,
        ]),
  ];
}

/** The check behind the public-address prompt. Null when the value is usable. */
export function describePublicAddressProblem(value: string): string | null {
  if (isIP(value) !== 4) {
    return "Enter the server's public IPv4 address, in the form 203.0.113.7.";
  }

  return publicIpv4OrNull(value) === null
    ? `${value} is a private address. The records need the address people reach the server at from the internet.`
    : null;
}

/** A scripted run has nobody to ask, so it names the flag that answers instead. */
export function renderPublicAddressRequired(sshTarget: string): string {
  return `Could not work out ${sshTarget}'s public IP address, and the DNS records cannot be created or checked without it. Pass --public-ip <address> and run the command again.`;
}

/** The records to add, one numbered block each. */
export function renderDnsRecords(
  records: readonly DnsRecordRequest[],
  zone: string | null,
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return records.flatMap((record, index) => [
    ...(index === 0 ? [] : [""]),
    ...renderDnsRecordBlock(record, index + 1, zone, palette),
  ]);
}

/**
 * What a wait has found that the user can act on, said the first time it is
 * seen rather than when the wait gives up. Each cause has a different fix, and
 * the two the wizard is most likely to meet — an old A record left in place,
 * and Cloudflare's orange cloud on by default for a record added minutes ago —
 * look identical to "not added yet" from the spinner line alone. Null for
 * the kinds with nothing to explain: no answer yet, or the answer wanted.
 */
export function renderRecordExplanation(
  hostname: string,
  expected: string,
  diagnosis: RecordDiagnosis,
): string[] | null {
  switch (diagnosis.kind) {
    case "match":
    case "missing":
      return null;
    case "different":
      return [
        `${hostname} resolves to ${diagnosis.found.join(", ")}, not to this server (${expected}).`,
        "If you just changed the record, it can take a few minutes. If it has been longer, check for an older record for the same name — replacing the value is not the same as adding a second record. This keeps checking meanwhile.",
      ];
    case "cloudflare-proxied":
      return [
        `${hostname} is going through Cloudflare's proxy (the orange cloud) rather than straight to this server.`,
        "Turn the proxy off for this record for now — click the orange cloud so it turns grey. The server needs a direct connection to get its HTTPS certificate; you can turn the proxy back on afterwards. This keeps checking meanwhile.",
      ];
  }
}

/**
 * The last word of a record wait that ran its full course.
 *
 * Named by what was found, not a bare "still does not point here": a proxied
 * record is not a wrong record — it already points at the right place, just
 * through Cloudflare — so "fix the record" sends the user hunting for a typo
 * that is not there, and an old record needs replacing where a missing one
 * needs adding. The explanation for the found value was printed when it was
 * first seen, so this only says what to do next.
 */
export function renderRecordWaitTimeout(
  hostname: string,
  expected: string,
  diagnosis: RecordDiagnosis,
  /** The wait moved to the system resolver, whose cached "no record" can outlast the wait. */
  fellBack = false,
): string {
  switch (diagnosis.kind) {
    case "cloudflare-proxied":
      return `The record for ${hostname} exists and points at Cloudflare — turn the orange cloud next to it grey (DNS only), then run the same command again.`;
    case "different":
      return `${hostname} still points at ${diagnosis.found.join(", ")}, not at this server (${expected}). Replace the old record with the value above, then run the same command again.`;
    case "match":
    case "missing":
      return `${hostname} still does not resolve — the record was not added, or was added under a different name (some consoles double the domain when the Name field is given the whole hostname)${
        fellBack ? ", or your network's resolver is still caching the old answer" : ""
      }. ${fellBack ? "Check the record, wait a little, and" : "Add it, then"} run the same command again.`;
  }
}

/**
 * The step label for the record wait. The record may be the user's to add or
 * one the wizard just wrote through an API, so the line names only what is
 * awaited and how to leave; who acts was said in the intro above.
 *
 * Every spinner line here is kept short on purpose: clack's spinner miscounts
 * the rows a line takes once the frame and timer it adds push the text past
 * the terminal's width, and then every frame leaves a copy behind instead of
 * repainting (bombshell-dev/clack#132). The provider, the poll interval, and
 * the record itself were all printed above, so the label does not repeat them.
 */
export function renderDnsWaitStep(hostname: string): string {
  return `waiting for ${hostname} (Ctrl+C to set up later)`;
}

/**
 * What each poll found. This replaces the animating spinner text on every
 * attempt, so it is the line the user actually stares at during the wait. The
 * expected address is left out: it is in the record printed above, and the
 * line has to stay within one terminal row (see `renderDnsWaitStep`).
 */
export function renderDnsWaitDetail(
  hostname: string,
  diagnosis: RecordDiagnosis,
): string {
  switch (diagnosis.kind) {
    case "match":
      return `${hostname} points at this server`;
    case "missing":
      return `waiting — ${hostname} does not resolve yet`;
    case "different":
      return `waiting — ${hostname} still points at ${diagnosis.found.join(", ")}`;
    case "cloudflare-proxied":
      return `waiting — ${hostname} still has the orange cloud on`;
  }
}

/**
 * Said once, as a warning line, when the zone's own nameservers could not be
 * asked and the wait moved to the system resolver. The wait is still fine,
 * only slower — a record added now shows up when the resolver's cache
 * expires, not in seconds — and a user watching "does not resolve yet"
 * deserves to know why. A warning rather than part of the detail line so
 * the explanation can be a full sentence without pushing the spinner line
 * past the terminal's width.
 */
export function renderResolverFallbackWarning(): string {
  return "asking your network's resolver instead of the zone's nameservers — a new record can take a few minutes longer to show up here";
}

export function renderDnsAbandoned(
  records: readonly DnsRecordRequest[],
): string[] {
  return [
    "Stopping here. Nothing has been installed yet.",
    "",
    "Add the records above, then run the same command again:",
    ...records.map((record) => `  ${record.hostname} -> ${record.value}`),
  ];
}

// ---------------------------------------------------------------------------
// The GitHub sign-in step
// ---------------------------------------------------------------------------

/**
 * The paragraph before the form. The pre-filled URL lives here, not in the
 * boxed values below it: a URL this long is wider than the box, and a box
 * hard-wraps what does not fit, which a pasted URL does not survive.
 */
export function renderOAuthIntro(input: {
  creationUrl: string;
}): string[] {
  return [
    `People use GitHub for ${PRODUCT_NAME} sign-in, so GitHub needs to know about your server.`,
    "",
    // A reference, not an instruction: the question that follows offers to
    // open it, and a line that reads "open this" gets clicked before the
    // question is seen — then answered, and the page opened twice.
    "The form comes pre-filled at:",
    `  ${input.creationUrl}`,
    "",
    // Stated, not asked. The organization form is the same form at a different
    // URL, it 404s for anyone who is not an owner, and an app on a personal
    // account works identically — so a prompt here would cost every user a
    // question to save a few the trouble of moving one later.
    "This creates the app on your own GitHub account. If your team should own it instead, create it under the organization's Settings > Developer settings — everything below is the same.",
  ];
}

/**
 * Where the provider's application is created or found, for the instance in
 * use: a provider with an instance origin among its extra fields aims at that
 * origin, and at its default when none is known.
 */
export function oauthAppUrl(provider: OAuthProvider, extra: Record<string, string> = {}): string {
  const { app, extraFields } = OAUTH_PROVIDERS[provider];
  return app.url({
    ...Object.fromEntries(extraFields.map((field) => [field.flag, field.default])),
    ...extra,
  });
}

export function renderOAuthRepairIntro(input: {
  provider: OAuthProvider;
  callbackUrl: string;
  settingsUrl: string;
}): string[] {
  const { app } = OAUTH_PROVIDERS[input.provider];
  return [
    app.repair.instructions,
    input.settingsUrl,
    app.repair.credentials,
    "Check that the existing app uses this callback value:",
    "",
    app.callbackField,
    input.callbackUrl,
  ];
}

/**
 * The two values to paste, each on its own line under its field name: a
 * wrapped note box would break the callback URL, and a copyable line cannot
 * sit inside one.
 */
export function renderManualOAuthFormValues(input: {
  callbackUrl: string;
  provider: OAuthProvider;
}): string[] {
  return [
    "Copy the value below each field name into the form:",
    "",
    "Name",
    PRODUCT_NAME,
    "",
    OAUTH_PROVIDERS[input.provider].app.callbackField,
    input.callbackUrl,
  ];
}

/** Said once the pair is in hand: there is no probe, so this is the check. */
export function renderManualOAuthVerifiedLater(provider: OAuthProvider): string[] {
  return [
    "These credentials will be checked when you first sign in to the dashboard.",
    `If sign-in rejects them, correct them with: cmpatch selfhost install --repair --oauth-provider ${provider}`,
  ];
}

/** What goes in the form's fields, and what to press once it is filled in. */
export function renderOAuthFormValues(
  input: {
    apiDomain: string;
    callbackUrl: string;
    name: string;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "If anything is blank, these are the three values:",
    `  Application name            ${palette.value(input.name)}`,
    `  Homepage URL                ${palette.value(`https://${input.apiDomain}/`)}`,
    // The field is a repeatable list now, and a second empty row confuses
    // people into thinking something is missing.
    `  Authorization callback URL  ${palette.value(input.callbackUrl)}`,
    "",
    'Press "Register application", then "Generate a new client secret".',
    "GitHub shows the secret once and never again, so copy it before leaving the page.",
  ];
}

export function renderOAuthShapeProblem(problem: string): string {
  switch (problem) {
    case "swapped":
      return "Those look swapped: the long string of letters and numbers is the client secret, and the shorter one is the client ID.";
    case "client-id-shape":
      return "That does not look like a client ID. It is the short value shown at the top of the app's page, next to \"Client ID\".";
    case "client-secret-shape":
      return "That does not look like a client secret. It is the long value shown once after you press \"Generate a new client secret\".";
    default:
      return "Both the client ID and the client secret are needed.";
  }
}

// ---------------------------------------------------------------------------
// Picking up an install that did not finish
// ---------------------------------------------------------------------------

export function renderIncompleteIntro(input: {
  failure: string;
  serverUrl: string | null;
  startedAt: string | null;
}): string[] {
  const what: Record<string, string> = {
    cloudflare: "The Cloudflare token was not accepted.",
    cloudfront: "The CloudFront settings were not accepted.",
    docker: "Docker was not usable on the server.",
    domains: "One of the domains was not accepted.",
    oauth: "The OAuth sign-in settings were not accepted.",
    "public-https":
      "The server never became reachable over HTTPS — usually a domain pointing somewhere else, or ports 80 and 443 still closed.",
    unknown: "It stopped part-way through.",
  };

  return [
    `Setting up${input.serverUrl === null ? "" : ` ${input.serverUrl}`} was started here${
      input.startedAt === null ? "" : ` on ${formatDay(input.startedAt)}`
    } and did not finish.`,
    what[input.failure] ?? (what.unknown as string),
    "",
    "Nothing has been lost. What would you like to do?",
  ];
}

function formatDay(isoTimestamp: string): string {
  const parsed = Date.parse(isoTimestamp);
  return Number.isNaN(parsed)
    ? isoTimestamp
    : new Date(parsed).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The CDN step
// ---------------------------------------------------------------------------

export function renderCdnPurpose(): string[] {
  return [
    "Update files are downloaded by every device that takes an update, so putting a CDN in front of them makes updates faster and takes the load off your server.",
    "You can skip this and turn it on later; nothing about the install changes.",
  ];
}

/**
 * The answer to picking the Cloudflare row that says it is not available.
 *
 * The row is listed rather than hidden so the option is discoverable, which
 * means it can be chosen — and the honest reply is not "continuing without a
 * CDN": the delivery adapter is written when the server is first stood up, so
 * proceeding here is the answer, not a step towards one.
 *
 * What is reported is what the detection actually saw, never the account state
 * it cannot see. Nameservers that do not look like Cloudflare's are evidence,
 * not proof — a partial (CNAME) zone on a Business plan keeps its registrar's
 * nameservers — and a lookup that failed reads identically to one that came
 * back empty, so the two are said differently and neither claims the domain is
 * absent from Cloudflare. That is also why the flags are offered as a way out:
 * they bypass this detection entirely.
 */
export function renderCloudflareUnavailable(input: {
  /** Whether the zone's nameservers were read at all, or the lookup came back empty. */
  nameserversRead: boolean;
  storageDomain: string;
  zone: string | null;
}): string[] {
  const { storageDomain, zone } = input;
  return [
    zone === null
      ? `Couldn't work out which zone holds ${storageDomain}, so this install can't tell whether Cloudflare serves it.`
      : input.nameserversRead
        ? `The nameservers for ${zone} don't look like Cloudflare's, so this install can't set Cloudflare up for you.`
        : `Couldn't read the nameservers for ${zone}, so this install can't tell whether Cloudflare serves it.`,
    "",
    // Stopping now really is free — nothing has been installed, and an abort
    // here leaves no record for a rerun to resume — but that stops being true
    // the moment this run stands a server up, which is what makes the choice
    // one-way rather than merely first-time.
    "Nothing has been installed yet, so stopping here costs nothing. Once this run has stood a server up, though, the CDN it was given is the one it keeps — a later run against that server never asks this again. So either",
    zone === null
      ? `  stop now with Ctrl+C, check that ${storageDomain} resolves, and start the install again, or`
      : `  stop now with Ctrl+C, add ${zone} to Cloudflare, and start the install again once the nameserver change has taken effect, or`,
    // The third exit, for everyone this detection is simply wrong about: a
    // partial setup, or a DNS lookup that failed on the way here.
    "  if it is on Cloudflare already, start the install again with --cloudflare --cloudflare-api-token <token> --cloudflare-zone-id <id>, which skips this check, or",
    "  pick one of the other options — Cloudflare can be turned on by hand afterwards:",
    `  ${CLOUDFLARE_ENABLE_LATER_URL}`,
  ];
}

export function renderCloudflareTokenIntro(
  input: {
    storageDomain: string;
    templateUrl: string;
    zone: string | null;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    `${PRODUCT_NAME} needs permission to clear Cloudflare's cache when you publish a release — otherwise devices keep downloading the previous version until the cache expires on its own.`,
    "",
    "A token with exactly those permissions already ticked can be created at:",
    `  ${input.templateUrl}`,
    "",
    // The manual path is printed alongside, not as a fallback shown after a
    // failure: the deep link opens the right form but the user still has to
    // recognise it, and a token minted by hand is equally good.
    "If you would rather create it by hand: My Profile > API Tokens > Create Token > Create Custom Token, with",
    `  Permissions   ${palette.value("Zone > Cache Purge > Purge")}`,
    `  Permissions   ${palette.value("Zone > Zone > Read")}`,
    `  Zone Resources  ${palette.value(`Include > Specific zone > ${input.zone ?? input.storageDomain}`)}`,
    "",
    'Press "Continue to summary", then "Create Token".',
    "Cloudflare shows the token once and never again, so copy it before leaving the page.",
  ];
}

export function renderZoneLookupProblem(input: {
  kind: string;
  nameserversAreCloudflare: boolean;
  zone: string;
}): string[] {
  switch (input.kind) {
    case "not-on-this-account":
      return input.nameserversAreCloudflare
        ? [
            // Never a bare "not on Cloudflare": the nameservers say it plainly
            // is, so the only thing left is that the token belongs elsewhere.
            `${input.zone} is on Cloudflare, but not on the account this token belongs to.`,
            "Create the token while signed in to the account that holds this domain, or switch accounts in the top-left of the Cloudflare dashboard first.",
          ]
        : [
            `Could not find ${input.zone} on this Cloudflare account.`,
            "Check that the domain is added to Cloudflare and that you created the token on the same account.",
          ];
    case "no-zone-read":
      return [
        "This token cannot list zones, so the zone id cannot be looked up for you.",
        "Either create the token from the link above (it includes Zone > Read), or find the Zone ID on the domain's Overview page in Cloudflare and pass it with --cloudflare-zone-id.",
      ];
    default:
      return [
        "Could not reach Cloudflare to look up the zone id.",
        "Find the Zone ID on the domain's Overview page in Cloudflare and pass it with --cloudflare-zone-id.",
      ];
  }
}

/**
 * The switch to Proxied, which cannot happen before the install: Caddy needs a
 * direct connection to obtain its certificate, and `install.sh` only logs a
 * reminder about it. Without this step the CDN serves nothing while every
 * other check passes.
 */
export function renderProxySwitch(storageDomain: string): string[] {
  return [
    "Downloads are not going through Cloudflare yet. Two settings in the Cloudflare dashboard turn that on, and they are yours to do:",
    "",
    ...renderProxySwitchSteps(storageDomain),
    "",
    'Answer "Not yet" to skip this: the install stays complete, and the steps are repeated at the end so you can finish them later.',
  ];
}

/** The switch itself, without the lead-in — reused by the closing summaries. */
export function renderProxySwitchSteps(storageDomain: string): string[] {
  return [
    `1. DNS > Records: find ${storageDomain} and click its grey cloud so it turns orange (Proxied). The install left it grey because the server had to get its certificate over a direct connection first.`,
    "",
    '2. SSL/TLS > Overview: make sure the mode is "Full (strict)". "Flexible" sends Cloudflare to your server over plain http, which loops forever against a server that only speaks https.',
  ];
}

/**
 * Everything a Cloudflare setup still owes, for a closing summary. The lead-in
 * belongs to the caller ("If downloads are not…" on a resume, "Downloads are
 * not…" after a declined check); the steps are composed from the same builders
 * the walkthrough prints, so the summaries can never drift from it.
 */
export function renderCloudflareRemaining(
  storageDomain: string,
  leadIn: string,
  options: { cacheRule: boolean } = { cacheRule: true },
): string[] {
  return [
    leadIn,
    ...renderProxySwitchSteps(storageDomain),
    ...(options.cacheRule ? ["", ...renderCacheRule(storageDomain)] : []),
  ];
}

/** What the setup token did about the rule, in the user's terms. */
export function renderCacheRuleAdded(
  storageDomain: string,
  written: boolean,
): string {
  return written
    ? `Added a Cloudflare cache rule for ${storageDomain}: downloads are cached by the server's own cache headers.`
    : `${storageDomain} already has a matching Cloudflare cache rule, so it was left as it is.`;
}

/** "Full" works against the server's real certificate; strict also checks it. */
export function renderFullSslAdvice(zone: string): string {
  return `SSL/TLS for ${zone} is "Full", which works. "Full (strict)" also checks the server's certificate and is the safer choice: SSL/TLS > Overview in Cloudflare.`;
}

/** A mode the proxy cannot run on, found before the switch rather than after it. */
export function renderSslBlocksProxy(zone: string, mode: string): string[] {
  return [
    `SSL/TLS for ${zone} is "${renderSslMode(mode)}", so the proxy stays off for now.`,
    mode === "flexible"
      ? "With Flexible, Cloudflare asks your server over plain http, your server redirects to https, and downloads loop forever."
      : "With SSL/TLS off, Cloudflare cannot reach a server that only speaks https.",
    'Set SSL/TLS > Overview to "Full (strict)" in Cloudflare. It applies to the whole domain, so check that its other sites work with it too.',
  ];
}

export function renderSslBlockedLeadIn(zone: string, mode: string): string {
  return `Downloads are not going through Cloudflare yet, because SSL/TLS for ${zone} is "${renderSslMode(mode)}":`;
}

/** The proxy is on, but the proof never came back. */
export function renderProxyUnconfirmedLeadIn(storageDomain: string): string {
  return `The Cloudflare proxy is on for ${storageDomain}, but downloads were not confirmed through it yet. If they still are not, check:`;
}

function renderSslMode(mode: string): string {
  return mode === "off" ? "Off" : mode === "flexible" ? "Flexible" : mode;
}

/**
 * The step label for the proxy-switch wait, mirroring the DNS wait. The
 * switch may be the user's or the wizard's own, so the line does not say
 * whose; the Ctrl+C escape is named because stopping the wait keeps the run
 * alive — the diagnosis and the closing summary still print.
 */
export function renderProxySwitchWaitStep(): string {
  return "waiting for the Cloudflare proxy (Ctrl+C: stop waiting)";
}

/** What each poll of the proxy switch found. */
export function renderProxySwitchWaitDetail(
  hostname: string,
  diagnosis: RecordDiagnosis,
): string {
  switch (diagnosis.kind) {
    case "cloudflare-proxied":
      return `${hostname} now resolves into Cloudflare`;
    case "match":
      return `waiting — ${hostname} still bypasses Cloudflare`;
    case "different":
      return `waiting — ${hostname} still points at ${diagnosis.found.join(", ")}`;
    case "missing":
      return `waiting — ${hostname} is not answering right now`;
  }
}

export function renderProxiedCheckProblem(
  storageDomain: string,
  check: {
    kind: string;
    last?: RecordDiagnosis;
    location?: string;
    status?: number;
  },
): string[] {
  switch (check.kind) {
    case "redirect-loop":
      return [
        `${storageDomain} is redirecting to itself, over and over.`,
        'That is what "Flexible" SSL/TLS does here: Cloudflare asks your server over plain http, your server redirects to https, and Cloudflare asks over http again.',
        'Set SSL/TLS > Overview to "Full (strict)" in Cloudflare, then run this check again.',
      ];
    case "origin-unreachable":
      return [
        `Cloudflare could not reach your server (it answered with ${String(check.status ?? 0)}).`,
        `Check that ${storageDomain} still points at the server's address, and that ports 80 and 443 are open to Cloudflare.`,
      ];
    case "not-proxied-at-authority":
      return [
        // The first line reports only what the poll last saw, branched the
        // way renderRecordExplanation is: "still the direct address" would be
        // false over a timeout that ended on another value or no answer.
        // The answer is deliberately not attributed to the zone's own
        // nameservers by name — the lookup prefers them but falls back to
        // the system resolver when they cannot be asked, and only the wait's
        // own detail line says which one answered.
        check.last?.kind === "missing"
          ? `${storageDomain} did not answer the DNS check at all.`
          : check.last?.kind === "different"
            ? `${storageDomain} resolves to ${check.last.found.join(", ")}, which is not a Cloudflare address.`
            : `${storageDomain} still resolves to this server's own address, not into Cloudflare.`,
        // Never "the record looks right": this is the one state where it
        // does not — nothing was flipped, or the wrong record was. The two
        // are named because they look identical from here.
        `In Cloudflare's DNS > Records, check the cloud next to ${storageDomain}: it may still be grey, or the orange cloud may have been turned on for a different record.`,
      ];
    case "not-through-cloudflare":
      return [
        `${storageDomain} answered, but not through Cloudflare.`,
        // Only reachable after the DNS poll watched the record resolve into
        // Cloudflare's ranges, so the stale local cache is the likely
        // explanation — "likely" rather than certain, and with no claim
        // about *whose* resolver said so, because the poll's lookup can
        // fall back to the system resolver and this copy does not know
        // whether it did.
        "The DNS check just saw the record resolve into Cloudflare, so this machine is most likely still using the old, cached address. Give it a few minutes and run this check again.",
      ];
    default:
      return [
        `Could not confirm that ${storageDomain} is served through Cloudflare.`,
        "Downloads still work; they are just not going through the CDN yet.",
      ];
  }
}

/**
 * The Cache Rule. A Cache-Purge-scoped token cannot read or create rules, so
 * this is a printed block the user confirms — and it is not optional: without
 * it the manifest files are never eligible for the edge cache, and the purge
 * token collected above has nothing to purge.
 */
export function renderCacheRule(
  storageDomain: string,
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "One more setting has to be added by hand in Cloudflare.",
    "",
    ...renderCacheRuleSteps(storageDomain, palette),
  ];
}

/** The rule itself, without the lead-in — reused by the closing summaries. */
export function renderCacheRuleSteps(
  storageDomain: string,
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "In Cloudflare, go to Caching > Cache Rules > Create rule:",
    `  Rule name              ${palette.value("Codemagic Patch manifests")}`,
    `  When incoming requests match   ${palette.value(`Hostname equals ${storageDomain}`)}`,
    `  Cache eligibility      ${palette.value("Eligible for cache")}`,
    `  Edge TTL               ${palette.value("Use cache-control header if present, bypass cache if not")}`,
    // Named explicitly: an Edge TTL override here would keep serving a stale
    // manifest for its whole duration, which is the one thing the purge exists
    // to prevent.
    "  Browser TTL            leave as it is",
    "",
    "Do not set an Edge TTL override — the server sends its own cache headers, and an override would keep old manifests alive past a purge.",
  ];
}

/**
 * What comes after the rule. The check itself needs a published release, and
 * nothing has been published at this point — the apps do not exist yet — so
 * the how-to lives on the docs site, where it can be run when there is
 * something to fetch.
 */
export function renderCacheRuleNextSteps(): string[] {
  return [
    "Downloads are cached at Cloudflare's edge from the first release on. To see it working once one is published:",
    `  ${CLOUDFLARE_VERIFY_DOCS_URL}`,
  ];
}

// ---------------------------------------------------------------------------
// The CloudFront branch
//
// Every checkmark in this walkthrough is the user confirming they did
// something in the AWS Console, not the CLI verifying it. The wizard creates
// nothing in AWS and holds no AWS credential beyond the scoped purge key that
// comes back at the end — so the copy has to be precise enough to work from,
// and honest about what is and is not checked.
// ---------------------------------------------------------------------------

export function renderCloudFrontIntro(input: {
  apiDomain: string;
  guideUrl: string;
  originDomain: string;
  storageDomain: string;
}): string[] {
  return [
    "CloudFront is set up in the AWS Console — this command cannot create AWS resources for you, and will not ask for AWS credentials that could.",
    "",
    "What it does: walks you through each screen, prints the exact values to paste, and checks the result afterwards.",
    "",
    "Three hostnames are involved, and two of them differ by one word, so here they are together:",
    `  ${input.apiDomain}   your dashboard and API — does not change`,
    `  ${input.storageDomain}   where devices download from — moves to CloudFront at the very end`,
    `  ${input.originDomain}   what CloudFront fetches from — stays on this server`,
    "",
    // The single most expensive mistake in this branch: an early cutover
    // leaves neither path able to serve, because Caddy can no longer complete
    // certificate issuance for the viewer name.
    `Do not point ${input.storageDomain} at CloudFront yet. It has to stay on this server for the whole install, or the server cannot get its HTTPS certificate. This command will tell you when to move it.`,
    "",
    `Full guide: ${input.guideUrl}`,
  ];
}

/**
 * The lead-in to the one question a first-time user has no reason to expect.
 *
 * Asked before the value is made, because making one is the thing that goes
 * wrong: a run stopped anywhere after the distribution screen leaves a real
 * distribution sending a real header value, and a fresh value on the next run
 * would be one the distribution has never heard of — every download 403s, and
 * nothing on either side says why. Nobody is asked to keep the old value
 * anywhere: it is on the distribution's own origin settings page, which is
 * where the next block sends them.
 */
export function renderOriginSecretRerunAsk(): string[] {
  return [
    "CloudFront proves it is CloudFront by sending a secret header to your server, and both sides have to carry the same value.",
    "",
    "If a previous run of this command stopped after you had already created the distribution in AWS, that distribution is still sending the value from that run — answer yes below and this command will keep it instead of making a new one.",
    "",
    "Setting up CloudFront for the first time? Answer no.",
  ];
}

/** Where the value is, on the distribution the previous run left behind. */
export function renderOriginSecretLookup(input: {
  headerName: string;
  originDomain: string;
}): string[] {
  return [
    `Open that distribution in the CloudFront console, choose Origins, select ${input.originDomain}, and choose Edit. Under "Add custom header" you will find ${input.headerName} and its value.`,
    "",
    "Paste that value below, exactly as the Console shows it.",
    "",
    // The way out of a question that would otherwise have no answer: a value
    // that cannot be found, or one this command will not accept, must not
    // leave the user stuck at a prompt with nothing valid to type.
    "Cannot find it? Leave the answer empty and press Enter — a new value is made instead, and the step after this says where to paste it over the old one.",
    "",
    // The walkthrough that follows is unchanged — it still steps through the
    // certificate, the distribution, and the access key — so say plainly that
    // the steps already done are confirmed rather than redone. Making the
    // walkthrough itself re-enterable is a larger change than this question.
    "The screens after this are the ones you have already been through. Where a step is done, confirm it and move on; where a value is asked for, read it off the distribution you made — except the access key's secret half, which AWS shows once and never again. Step ③ says what to do if that one was not saved.",
  ];
}

/** Said when the lookup is answered with an empty line. */
export function renderOriginSecretRegenerating(): string[] {
  return [
    "No value given, so a new one is below. The distribution you already created is still sending the old one, so its custom header has to be changed to match — step ② below is where that is done.",
  ];
}

/** Where the value about to be printed came from. */
export type OriginSecretSource =
  /** Made here, for a distribution that does not exist yet. */
  | "generated"
  /** Read back off a distribution an earlier run created. */
  | "existing"
  /** Passed on the command line by the caller. */
  | "supplied";

export function renderOriginSecret(
  input: {
    headerName: string;
    secret: string;
    source?: OriginSecretSource;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  const source = input.source ?? "generated";
  return [
    source === "existing"
      ? "Keeping the header value your distribution already sends. Your server will be set up to accept exactly this:"
      : source === "supplied"
        ? "Using the header value you passed on the command line. Your server will be set up to accept exactly this:"
        : // The sentence explaining what the header is for has already been
          // said by the question that comes before this block; repeating it
          // here made the same paragraph appear twice, a few lines apart.
          "Here is the value, then — you will paste it into the distribution in a moment:",
    "",
    `  Header name   ${palette.value(input.headerName)}`,
    `  Header value  ${palette.value(input.secret)}`,
    "",
    source === "generated"
      ? // Shown once, like every other generated secret: it is written straight
        // into the server's settings and never printed again.
        "This is shown once. Copy it now."
      : "Compare it with the distribution once more before continuing: one wrong character and every download fails.",
  ];
}

export function renderAcmStep(
  input: {
    consoleUrl: string;
    provider: DnsProvider | null;
    storageDomain: string;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "① A certificate for the download domain, in AWS Certificate Manager.",
    "",
    `  ${input.consoleUrl}`,
    "",
    // The region is not a preference: CloudFront only reads certificates from
    // us-east-1, and a certificate requested elsewhere never appears in the
    // distribution's picker.
    `  Region        ${palette.value("US East (N. Virginia) — us-east-1")}. CloudFront cannot use a certificate from any other region.`,
    `  Domain name   ${palette.value(input.storageDomain)}`,
    `  Validation    ${palette.value("DNS validation")}`,
    "",
    // The step people get stuck on. ACM shows the record and then sits at
    // "Pending validation" forever, and nothing on that screen says the
    // record has to be added somewhere else entirely — so the instruction to
    // go add it has to be here, before the paste rather than after it.
    input.provider === null
      ? `AWS then shows a CNAME record, and it is yours to add: it goes in your domain's DNS, the same place the records above went. The certificate stays "Pending validation" until it is there — this command cannot add it for you.`
      : `AWS then shows a CNAME record, and it is yours to add: it goes in ${input.provider.name}, the same place the records above went. The certificate stays "Pending validation" until it is there — this command cannot add it for you.`,
    ...(input.provider === null ? [] : ["", `  ${input.provider.consoleUrl}`]),
    "",
    "Paste the record here when AWS shows it and this command will watch your DNS until it goes live, or press Enter to skip and add it on your own.",
  ];
}

/**
 * The validation record itself, printed once both halves are in hand.
 *
 * The one-line `name -> value` this replaced was the shape most likely to be
 * mistyped: consoles disagree about whether the Name field wants the whole
 * hostname, and the ACM name is long enough that nobody notices the zone got
 * appended twice. `renderDnsRecordBlock` already says both spellings, and the
 * user has seen that exact layout twice by now.
 */
/**
 * Three pieces, because the middle one is boxed: where the record goes, the
 * record, and what happens once it is live.
 */
export function renderAcmValidationRecord(
  input: {
    name: string;
    provider: DnsProvider | null;
    value: string;
    zone: string | null;
  },
  palette: Palette = PLAIN_PALETTE,
): { after: string[]; intro: string[]; record: string[] } {
  return {
    intro: [
      input.provider === null
        ? "Add this record where you manage your domain's DNS:"
        : `Add this record at ${input.provider.name}:`,
      ...(input.provider === null ? [] : [`  ${input.provider.consoleUrl}`]),
    ],
    record: renderDnsRecordBlock(
      {
        hostname: input.name,
        purpose: "Proves to AWS that the domain is yours",
        type: "CNAME",
        value: input.value,
      },
      null,
      input.zone,
      palette,
    ),
    // Said out loud because the wait that follows is otherwise unexplained:
    // the record going live is not the end of the step, ACM still has to see
    // it and flip the certificate.
    after: [
      "AWS rechecks every few minutes, and the certificate turns Issued shortly after the record goes live.",
    ],
  };
}

/**
 * The validation name and the provider were printed just above, and ACM's
 * names are long enough on their own to fill a terminal row, so the spinner
 * line names neither (see `renderDnsWaitStep` for why it must stay short).
 */
export function renderAcmWaitStep(): string {
  return "waiting for the CNAME (Ctrl+C to add it later)";
}

export function renderAcmWaitDetail(
  name: string,
  diagnosis: CnameDiagnosis,
): string {
  switch (diagnosis.kind) {
    case "match":
      return `${name} is live`;
    case "missing":
      return "waiting — the CNAME does not resolve yet";
    case "doubled":
      // The single most common way this record goes in wrong, and invisible
      // from both consoles: AWS shows "Pending validation" and the DNS
      // console shows a record that looks right. The explanation leads so
      // a cut-off line still makes the point; the doubled name is the part
      // that can go.
      return `the CNAME name ended up doubled — found it at ${diagnosis.at}`;
    case "different":
      return `waiting — the CNAME points at ${diagnosis.found.join(", ")}`;
  }
}

/**
 * What to say when the wait ends without the record. Never fatal: the
 * certificate is only needed at the cutover, which is the end of the install.
 */
export function renderAcmWaitGaveUp(
  input: { expected: string; name: string; zone: string | null },
  diagnosis: CnameDiagnosis,
): string[] {
  switch (diagnosis.kind) {
    case "match":
      return [];
    case "doubled":
      return [
        `The record is at ${diagnosis.at}, not at ${input.name}.`,
        // Most consoles append the zone to whatever is typed, so the fix is
        // to type less, not to type something different.
        `Most DNS consoles add your domain to whatever you type, so the name ended up doubled — enter just "${relativeName(input.name, input.zone)}" as the Name.`,
      ];
    case "different":
      return [
        `${input.name} points at ${diagnosis.found.join(", ")}, not at ${input.expected}.`,
        "Check for an older record with the same name — replacing the value is not the same as adding a second record.",
      ];
    case "missing":
      return [
        `${input.name} does not resolve yet.`,
        // Not "needed at the very end": the next screen's certificate picker
        // only lists Issued certificates, so this blocks step ②, not the
        // cutover.
        `Add the CNAME ${input.name} -> ${input.expected} and AWS will pick it up on its own — but finish this before creating the distribution: the next screen cannot attach a certificate that is not Issued.`,
      ];
  }
}

function relativeName(hostname: string, zone: string | null): string {
  return zone !== null && hostname.endsWith(`.${zone}`)
    ? hostname.slice(0, -(zone.length + 1))
    : hostname;
}

export function renderDistributionStep(
  input: {
    consoleUrl: string;
    headerName: string;
    originDomain: string;
    storageDomain: string;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "② The distribution.",
    "",
    `  ${input.consoleUrl}`,
    "",
    `  Origin domain              ${palette.value(input.originDomain)}`,
    `  Protocol                   ${palette.value("HTTPS only")}`,
    `  Add custom header          ${palette.value(input.headerName)}: the value shown earlier`,
    `  Alternate domain name      ${palette.value(input.storageDomain)}`,
    "  Custom SSL certificate     the certificate from ①",
    `  Viewer protocol policy     ${palette.value("Redirect HTTP to HTTPS")}`,
    `  Allowed HTTP methods       ${palette.value("GET, HEAD")}`,
    `  Cache policy               ${palette.value("CachingOptimized")}`,
    `  Origin request policy      ${palette.value("None")}`,
    "",
    // Forwarding the viewer Host makes CloudFront's requests land on the
    // wrong Caddy site, which defeats the header check entirely.
    "Leave the origin request policy empty. Forwarding the viewer's Host header sends CloudFront's requests to the wrong site on your server, and the protection above stops working.",
    "",
    // The trap this walkthrough exists to prevent: the console labels both
    // fields optional and creates the distribution without them, and a
    // Pending certificate is absent from the picker rather than greyed out —
    // so arriving here too early reads as "add it later" and never comes back.
    "The console calls the alternate domain name and certificate optional — for this install they are not. A distribution created without them accepts the DNS change at the end and then serves nothing. If the certificate picker is empty, ① has not reached Issued yet: wait for it rather than creating the distribution without it.",
    "",
    // The other direction of the same 403: a distribution that already exists
    // and was not named as such at the start of the run is still sending the
    // header value of the run that made it. Nothing later in the walkthrough
    // compares the two, and the probes before the cutover report only that
    // the origin refused — never that the value is the reason.
    `Already have a distribution from an earlier attempt? Do not create a second one: open its origin instead, and make sure ${input.headerName} carries exactly the value shown earlier. A distribution still sending an older value gets a 403 for every download.`,
  ];
}

export function renderIamStep(
  input: {
    consoleUrl: string;
    policy: string;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "③ A key that can do exactly one thing: clear this distribution's cache when you publish.",
    "",
    `  ${input.consoleUrl}`,
    "",
    "Create a policy from this JSON, replacing the ARN with the one on the distribution's page:",
    "",
    // The whole document is the paste, so every line of it is marked.
    ...input.policy.split("\n").map((line) => `  ${palette.value(line)}`),
    "",
    "Attach it to a new IAM user, then create an access key for that user.",
    "Nothing broader belongs on this server — not an administrator key, not a general-purpose one.",
    "",
    // The one value in this walkthrough that genuinely cannot be recovered:
    // AWS shows the secret half once, at creation, and offers no way back to
    // it. A rerun that stopped after this screen therefore cannot be answered
    // by reading anything — a second key is the only way forward, which is
    // why saying so belongs here rather than in a troubleshooting page.
    "Did an earlier run get this far? The access key's secret half is shown once by AWS and cannot be looked up again. If it was not saved, open that same IAM user, choose Security credentials, and create a second access key — paste the new pair below, and delete the old key once the install has finished.",
  ];
}

/**
 * A closed union rather than `kind: string`: which host a probe failure names
 * decides which fix the user is sent to, and an unnamed kind would silently
 * fall into the wrong copy. The compiler now forces new copy alongside every
 * new probe outcome.
 */
/**
 * Said when "Certificate issued?" is answered with no.
 *
 * The honest answer used to be discarded — the wizard continued exactly as if
 * the user had said yes, which is how a distribution gets created with an
 * empty certificate picker, no alternate domain name, and nothing to catch it
 * until downloads break at the cutover.
 */
export function renderCertificateNotIssued(): string[] {
  return [
    "Then this is the place to wait: the next screen needs it.",
    "The distribution's certificate picker only lists certificates that are already Issued — a Pending one is absent, not greyed out. A distribution created without it (and without the alternate domain name next to it) looks finished, and then serves nothing when the download domain moves onto it at the end.",
    "ACM rechecks your DNS every few minutes, so the certificate usually flips to Issued shortly after the CNAME goes live. Confirm here once it does.",
  ];
}

/** Said when "Distribution created?" is answered with no. */
export function renderDistributionNotCreated(): string[] {
  return [
    "Then stay on that screen — the next two questions are the distribution's ID and its domain name, and neither exists yet.",
    "Creating it is immediate; the deploy that follows is not, but the wizard waits for that itself. Confirm here once the distribution is listed.",
  ];
}

/** Said when "Access key created?" is answered with no. */
export function renderAccessKeyNotCreated(): string[] {
  return [
    "Then finish that first: the next two questions are the key's two halves, and the secret is shown once and never again.",
    "The install proves the key by asking CloudFront to clear this distribution's cache, so a run without one stops at that check rather than here.",
  ];
}

export type CloudFrontProbeProblem =
  | { kind: "not-cloudfront" }
  /**
   * The distribution answers, but greeted with the viewer hostname it offers
   * a certificate for some other name — the alternate domain name and its
   * certificate are not attached, or the change is still deploying. The one
   * misconfiguration a cutover turns into an outage, caught while the record
   * still points at the server.
   */
  | { kind: "name-not-claimed"; certificateFor: string | null }
  /**
   * The distribution relays a 403 for the readiness path — the answer this
   * server gives every request whose origin-verify header is wrong or
   * missing. The header is the one value typed by hand into the AWS Console,
   * so this is the misconfiguration that check exists to catch; a mistyped
   * distribution domain produces the same relayed 403, so it is named as the
   * second suspect.
   */
  | { kind: "origin-header-rejected" }
  /**
   * The distribution answers, but the readiness check behind it fails with
   * something other than 403 — CloudFront cannot reach the origin, or the
   * origin is not healthy.
   */
  | { kind: "unhealthy"; status: number }
  /** The origin hostname on this server did not answer at all. */
  | { kind: "origin-unreachable" }
  | { kind: "unprotected"; status: number }
  /** The distribution hostname did not answer at all. */
  | { kind: "unreachable" };

export function renderCloudFrontProbeProblem(
  probe: CloudFrontProbeProblem,
  input: {
    distributionDomain: string;
    originDomain: string;
    storageDomain: string;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  switch (probe.kind) {
    case "not-cloudfront":
      return [
        `${input.distributionDomain} answered, but not as a CloudFront distribution.`,
        "Check the distribution domain name was copied correctly, and that the distribution's status is Deployed.",
      ];
    case "origin-unreachable":
      return [
        `Could not reach ${input.originDomain}.`,
        // Named apart from the distribution case: this hostname lives on the
        // user's own server, so "wait for the deploy" is exactly the wrong
        // advice for it.
        `That is the address on this server that CloudFront fetches from, so a still-deploying distribution is not the cause. Check that ${input.originDomain} still points at this server and that the server is answering.`,
      ];
    case "origin-header-rejected":
      return [
        `${input.distributionDomain} is answering, but it refused this check (403).`,
        "",
        // CloudFront itself answers 403 with `x-cache` while a distribution
        // (or an edit to its custom header) is still deploying, so the cause
        // cannot be asserted from here — the possibilities are listed in the
        // order they should be checked, still-deploying first, exactly as the
        // name-not-claimed copy does.
        "Three things cause that, in the order they should be checked:",
        `  1. The distribution is still deploying. If you created it — or edited its custom header — in the last few minutes, wait until it shows Deployed in the Console and check again.`,
        `  2. The secret header does not match, so your server refuses CloudFront's requests the way it refuses anyone else's. On the distribution's page, open Origins, select ${input.originDomain}, and choose Edit. Under "Add custom header", the name must be exactly ${ORIGIN_VERIFY_HEADER} and the value must be exactly the one shown earlier — retype them rather than trusting what is there.`,
        // The same 403 also comes from a mistyped distribution domain: every
        // *.cloudfront.net name resolves, and CloudFront answers 403 for one
        // no distribution owns.
        `  3. The distribution domain was mistyped. Every .cloudfront.net name answers, so compare ${input.distributionDomain} against the "Distribution domain name" on the distribution's page.`,
        "",
        `Not moving ${input.storageDomain} yet — pointed at the distribution now, every download would get the same 403.`,
      ];
    case "unhealthy":
      return [
        `${input.distributionDomain} answered, but with an error (HTTP ${String(probe.status)}) instead of a healthy response.`,
        `CloudFront is running, but the health check behind it did not pass. Check that ${input.originDomain} is answering from this server, give a just-created distribution a few minutes to settle, and check again.`,
      ];
    case "unprotected":
      return [
        `${input.originDomain} answered a request that had no secret header (it returned ${String(probe.status)}, and should have returned 403).`,
        // Stopping here is the whole point: the cutover would otherwise leave
        // storage reachable by anyone who guesses the origin hostname.
        `Check the distribution's custom header is exactly the header name and value shown earlier. Not moving ${input.distributionDomain} into place yet.`,
      ];
    case "name-not-claimed":
      return [
        probe.certificateFor === null
          ? `${input.distributionDomain} is answering, but not for ${input.storageDomain}: asked for that name, it refuses the connection outright.`
          : `${input.distributionDomain} is answering, but not for ${input.storageDomain}: asked for that name, it offers a certificate for ${probe.certificateFor} instead.`,
        "",
        "Two things cause that, and they look identical from here:",
        "  1. The alternate domain name change is still deploying. If you set it recently, wait until the distribution shows Deployed and check again.",
        "  2. The distribution does not have the name. Under General > Settings > Edit, both of these have to be set:",
        `       Alternate domain name      ${palette.value(input.storageDomain)}`,
        "       Custom SSL certificate     the certificate from ①",
        "",
        // The whole reason this probe exists: caught here, it costs a recheck;
        // caught after the record moves, it is an outage.
        `Not moving ${input.storageDomain} yet — pointed at the distribution now, every download would fail its HTTPS check.`,
      ];
    case "unreachable":
      return [
        `Could not reach ${input.distributionDomain} yet.`,
        "A new distribution takes a few minutes to deploy. This will keep trying.",
      ];
  }
}

/**
 * The step label while waiting for the origin hostname's certificate.
 *
 * `install.sh` returns before Caddy has obtained it — the origin site issues
 * its certificate in the background — so a failed handshake in the first
 * minutes after the install is the expected state, not a broken origin. The
 * label says whose work is pending (the server's, not the user's) so nobody
 * goes looking for a record to fix.
 */
export function renderOriginTlsWaitStep(originDomain: string): string {
  return `waiting for ${originDomain} to finish HTTPS setup (Ctrl+C to stop waiting)`;
}

/**
 * What each handshake attempt saw, repainted onto the same animating line.
 * The issuance wording is the point of the wait: rendered as a diagnosis,
 * this expected state reads as a misconfiguration and sends the user off to
 * re-check a DNS record that is fine.
 */
export function renderOriginTlsWaitDetail(
  originDomain: string,
  seen: "issuing" | "no-answer",
): string {
  return seen === "issuing"
    ? `waiting for ${originDomain} — the certificate is still being issued, retrying`
    : `waiting for ${originDomain} — not answering over HTTPS yet, retrying`;
}

/**
 * The wait's own ending, settled before the probes speak: the last repaint
 * said "still being issued, retrying", and a diagnosis landing straight after
 * that would read as a contradiction. When the window closed on a certificate
 * for another name, the line carries that name — evidence, not a verdict: it
 * is the one clue the fetch-based probes cannot surface, and after a whole
 * window of it the likeliest story is the hostname reaching a different
 * server.
 */
export function renderOriginTlsWaitGaveUp(
  originDomain: string,
  lastSeen:
    | { kind: "refused" }
    | { kind: "unreachable" }
    | { certificateFor: string; kind: "wrong-name" },
): string {
  return lastSeen.kind === "wrong-name"
    ? `gave up waiting — ${originDomain} answers with a certificate for ${lastSeen.certificateFor}, not its own name; checking what is actually there`
    : `gave up waiting for ${originDomain}'s certificate — checking what is actually there`;
}

export function renderCutoverStep(
  input: {
    distributionDomain: string;
    storageDomain: string;
    zone: string | null;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    "Everything checks out. Now the last change, and downloads start coming from CloudFront.",
    "",
    "Change this one record — the type changes from A to CNAME:",
    `  Type   ${palette.value("CNAME")}`,
    input.zone !== null && input.storageDomain.endsWith(`.${input.zone}`)
      ? `  Name   ${palette.value(input.storageDomain.slice(0, -(input.zone.length + 1)))}   (some consoles want the whole ${input.storageDomain})`
      : `  Name   ${palette.value(input.storageDomain)}`,
    `  Value  ${palette.value(input.distributionDomain)}`,
    "",
    `Leave the other two records alone. ${input.storageDomain} is the only one that moves.`,
  ];
}

/**
 * The answer to the key press itself, repainted over whatever is animating.
 *
 * Nothing stops the instant Ctrl+C is seen: a poll is mid-request, or a whole
 * interval from looking again. Without a word the press reads as ignored — and
 * the terminal offers no second one to press, because the spinner's keyboard
 * handler expected the first to end the process. So the acknowledgement says
 * both halves: it was heard, and the check in flight finishes first.
 */
/**
 * What the wizard is about to ask for, printed before the server address is
 * asked. The audience this wizard exists for has just created a VPS and may
 * never have typed an ssh address by hand, so the two halves are asked one at
 * a time and this names both up front.
 */
export function renderSshTargetIntro(): string[] {
  return [
    "The install runs over SSH, so it needs the same two things you would use to log in to the server yourself: its address, and the account to log in as.",
  ];
}

/**
 * Where the login account comes from, printed between the address and the
 * user question. Providers rarely show this anywhere obvious — it is decided by
 * the image the server was created from — so the usual answers are listed by
 * where the server came from, which turns the question into a lookup. No
 * default is offered: a wrong guess here surfaces minutes later as a refused
 * connection, so a deliberate answer is worth one more keystroke.
 */
export function renderSshUserHint(): string[] {
  return [
    "Now the account to log in as. Which one it is depends on where the server came from:",
    "  root      most VPS providers (Hetzner, DigitalOcean, Vultr, Linode, ...), and any server that came with a root password",
    "  ubuntu    Ubuntu images on AWS, Google Cloud, or Oracle Cloud",
    "  ec2-user  Amazon Linux;  admin for Debian on AWS;  opc for Oracle Linux;  azureuser on Azure",
    "If you have logged in to it before, it is the part before the @ in that ssh command.",
  ];
}

export function renderStopRequested(): string {
  return "stopping — finishing this check first";
}

/**
 * The step label while polling after the cutover: what is pending is the
 * record change becoming visible, whether the user made it or the wizard did.
 */
export function renderCutoverWaitStep(storageDomain: string): string {
  return `waiting for the record change to reach ${storageDomain} (Ctrl+C to stop waiting)`;
}

/**
 * What the cutover poll saw when it saw nothing decisive — the three states a
 * wait simply has to sit through, as opposed to the relayed 403 and the
 * wrong-name certificate, which are reported as findings of their own.
 */
export type CutoverQuietSighting =
  | "no-answer"
  | "still-this-server"
  | "unhealthy";

/**
 * What the last probe saw, repainted onto the same animating line. The step
 * label above is written once for the whole wait — a `write` per attempt
 * settles the previous one into the scrollback, which turned a quiet wait into
 * a column of identical lines.
 */
export function renderCutoverWaitDetail(
  storageDomain: string,
  seen: CutoverQuietSighting | "certificate-name" | "origin-header-rejected",
): string {
  switch (seen) {
    case "no-answer":
      return `waiting for the record change to reach ${storageDomain} — nothing is answering it yet`;
    case "still-this-server":
      return `waiting for the record change to reach ${storageDomain} — still answered by this server`;
    case "certificate-name":
      // Two causes, one symptom, and the wizard cannot tell them apart from
      // outside: a distribution that is mid-deploy serves the old certificate
      // until the change reaches every edge, and one that never had the
      // alternate domain name set serves it forever.
      return `waiting — CloudFront answers ${storageDomain} with its own certificate, so it is either still deploying your change or does not have that name set`;
    case "origin-header-rejected":
      // The record has moved, so CloudFront is answering — the 403 must not
      // repaint as "still answered by this server". Like the certificate
      // line above, the cause cannot be asserted mid-wait: a distribution
      // still deploying a recent change answers the same way.
      return `waiting — CloudFront answers ${storageDomain} but relays a 403, so it is either still deploying a recent change or the distribution's secret header does not match`;
    case "unhealthy":
      return `waiting — CloudFront answers ${storageDomain}, but the health check behind it is failing`;
  }
}

/**
 * The last word of a cutover wait the user stopped.
 *
 * The timeout's line explains a wait that ran its course — "DNS changes can
 * take a few minutes" — and said to someone who has just pressed Ctrl+C it
 * answers a question they did not ask while quietly leaving out the one thing
 * that happened: the checking stopped because they said so. This says that,
 * names what the poll had last seen, and adds the consequence only where it is
 * unambiguously true.
 */
export function renderCutoverStopped(
  storageDomain: string,
  seen: CutoverQuietSighting,
): string {
  switch (seen) {
    case "still-this-server":
      // The one state that is plainly safe: the viewer name still resolves
      // here, so every download still lands on a server that has the files.
      return `Stopped waiting. ${storageDomain} was still answered by this server — downloads keep working from it until your record change spreads.`;
    case "no-answer":
      return `Stopped waiting. Nothing was answering ${storageDomain} yet.`;
    case "unhealthy":
      // No reassurance here on purpose: CloudFront already answers the viewer
      // name, so downloads are going through a distribution whose health check
      // is failing, and saying they keep working would be false.
      return `Stopped waiting. CloudFront was answering ${storageDomain}, but the health check behind it was failing.`;
  }
}

/**
 * The last word of a cutover wait that ran out of time.
 *
 * Only one of the three quiet states is what the old single line assumed —
 * the record has not spread yet and the server is still serving every
 * download. The other two are outages: a name that answers nothing is a
 * record pointing at nothing, and a CloudFront that relays an error from the
 * server is a distribution that cannot reach it. Both used to end the wait
 * with "downloads keep working", said over fifteen minutes of every device's
 * download failing. So each state gets its own reading, and the failing ones
 * say what is failing and where in the Console to look — the wizard has
 * nothing more it can check from here.
 */
export function renderCutoverTimedOut(
  input: {
    distributionDomain: string;
    originDomain: string;
    storageDomain: string;
  },
  seen: CutoverQuietSighting,
  palette: Palette = PLAIN_PALETTE,
): string[] {
  switch (seen) {
    case "still-this-server":
      // The one state that is plainly safe, so the reassurance stays.
      return [
        `${input.storageDomain} is still answering from this server. DNS changes can take a few minutes; downloads keep working from the server until it catches up.`,
      ];
    case "no-answer":
      // Not "still spreading": a change that had not spread would leave the
      // old address answering. Nothing answering means the name now points
      // at nothing — most often a distribution domain with a typo in it, or
      // an A record with the distribution's name typed into it.
      return [
        `Nothing is answering ${input.storageDomain} — the name currently points at nothing, so downloads over it are failing right now.`,
        "",
        "Check the record you changed. All three have to hold:",
        `  Type      ${palette.value("CNAME")} — not A or AAAA; the distribution has no fixed address to point one at`,
        `  Value     ${palette.value(input.distributionDomain)}, exactly — nothing added in front, no https://, no path`,
        "  Status    the distribution shows Deployed in the Console",
        "",
        `If downloads need to work in the meantime, point ${input.storageDomain} back at this server with its old A record and move it again once the record is right.`,
      ];
    case "unhealthy":
      // The record is right — CloudFront is the one answering — so the
      // problem is between the distribution and the server. The relayed 403
      // has its own report; anything else through the distribution means
      // CloudFront cannot get a healthy answer from the origin it was given.
      return [
        `CloudFront answers ${input.storageDomain}, but the health check behind it is failing: CloudFront is relaying an error from your server, so downloads over it are failing right now.`,
        "",
        `On the distribution's page, open Origins, select the origin, and choose Edit. All three have to match:`,
        `  Origin domain     ${palette.value(input.originDomain)}`,
        `  Protocol          ${palette.value("HTTPS only")}`,
        `  Custom header     ${palette.value(ORIGIN_VERIFY_HEADER)}, with the value shown earlier`,
        "",
        // No DNS advice on purpose, as with the relayed 403: the record is
        // already right, and moving it back would trade one outage for
        // certificate churn.
        "Nothing needs to change in DNS — downloads recover on their own once the origin settings are right and the distribution shows Deployed.",
      ];
  }
}

/**
 * What to say when the wait ends on a certificate that does not cover the
 * name.
 *
 * Two causes produce this exact symptom and nothing observable from here tells
 * them apart, so both are named in the order they should be checked: a
 * distribution deploying an alternate-domain-name change serves its old
 * certificate for as long as the change takes to reach every edge, which is
 * routinely longer than this wait.
 */
export function renderCutoverCertificateMismatch(
  input: {
    distributionDomain: string;
    storageDomain: string;
  },
  palette: Palette = PLAIN_PALETTE,
): string[] {
  return [
    `${input.storageDomain} reaches CloudFront, but CloudFront is answering it with its own certificate for *.cloudfront.net rather than one for your name — so downloads over that name are failing their HTTPS check right now.`,
    "",
    "Two things cause that, and they look identical from here:",
    `  1. The distribution is still deploying. If you set the alternate domain name recently, wait until it shows Deployed and check again — this is the usual answer.`,
    `  2. The distribution does not have the name. Under General > Settings > Edit, both of these have to be set:`,
    `       Alternate domain name      ${palette.value(input.storageDomain)}`,
    "       Custom SSL certificate     the certificate you created in step ①",
    "",
    // Worth saying because the certificate picker is where this goes wrong:
    // ACM only offers certificates that have already reached Issued.
    "The certificate has to be Issued in us-east-1 before the distribution will offer it — a certificate still validating does not appear in that picker at all.",
    "",
    `If downloads need to work in the meantime, point ${input.storageDomain} back at this server with its old A record and move it again once the distribution is Deployed.`,
    "",
    `Nothing else is wrong: ${input.distributionDomain} is answering, and your server is refusing unverified requests as it should.`,
  ];
}

/**
 * What to say when the wait ends on CloudFront relaying a 403.
 *
 * The pre-cutover probe refuses the record move on this, so seeing it here
 * usually means a recent Console change is still deploying — CloudFront
 * answers 403 with `x-cache` until an edit reaches every edge — but a header
 * changed between the probe and the cutover produces the same answer and
 * never clears on its own. Both are named, still-deploying first, matching
 * the certificate-mismatch copy beside this one.
 */
export function renderCutoverOriginRejection(input: {
  distributionDomain: string;
  originDomain: string;
  storageDomain: string;
}): string[] {
  return [
    `${input.storageDomain} now reaches CloudFront — but downloads over it are being refused (403).`,
    "",
    "Two things cause that, and they look identical from here:",
    `  1. The distribution is still deploying. If you created it — or edited its custom header — in the last few minutes, CloudFront answers 403 until the change reaches every edge; this clears on its own. Wait until the Console shows Deployed.`,
    `  2. The secret header does not match, so your server refuses CloudFront's requests the way it refuses anyone else's. On the distribution's page, open Origins, select ${input.originDomain}, and choose Edit. Under "Add custom header", the name must be exactly ${ORIGIN_VERIFY_HEADER} and the value must be exactly the one shown earlier — retype them rather than trusting what is there.`,
    "",
    // No DNS advice on purpose: the record is already right, and moving it
    // back would trade one outage for certificate churn.
    `Nothing needs to change in DNS — downloads recover on their own once the distribution is Deployed and the header matches.`,
  ];
}

export function renderCloudFrontNextSteps(input: {
  storageDomain: string;
}): string[] {
  return [
    "To confirm the cache is working, publish a release and request the same file twice:",
    `  curl -sI https://${input.storageDomain}/codemagic-patch/<app>/meta.json | grep -i x-cache`,
    "",
    "Expect Miss from cloudfront, then Hit from cloudfront.",
    "",
    // Expected, and alarming if unexplained: the viewer name now resolves to
    // CloudFront, so HTTP-01 renewal for that name can no longer complete.
    `Your server's logs will warn that it cannot renew a certificate for ${input.storageDomain}. That is expected now that the name points at CloudFront, and it is harmless.`,
  ];
}

export function renderGuidedStorage(input: {
  kind: "r2" | "s3" | "gcs"; publicBucket: string; internalBucket: string;
  region: string; project?: string; accountId?: string; downloadDomain?: string;
}): { buckets: string[]; credentials: string[]; verification: string } {
  const pair = `public: ${input.publicBucket}; internal: ${input.internalBucket}`;
  if (input.kind === "r2") return {
    buckets: [
      `1. Open https://dash.cloudflare.com/${input.accountId}/r2/overview. Enable R2 if needed, then create or select these buckets: ${pair}.`,
      `2. Under ${input.publicBucket} → Settings → Custom Domains, connect ${input.downloadDomain} in this account's active Cloudflare zone. Wait for Active. Disable r2.dev on both buckets; leave the internal bucket without any custom domain.`,
      `3. In the download zone → Rules → Cache Rules, create a hostname rule for http.host eq "${input.downloadDomain}". Choose Eligible for cache and respect origin Cache-Control and Browser TTL; do not override Edge TTL.`,
    ],
    credentials: [
      `4. Create or reuse one account-owned runtime API token at https://dash.cloudflare.com/${input.accountId}/api-tokens. Include Account → Workers R2 Storage → Read, Account → Workers R2 Storage Bucket Item → Write for both buckets, Zone → Zone → Read and Zone → Cache Purge for the download zone. The link pre-fills R2 Read, Zone Read and Cache Purge; add Bucket Item Write manually. R2 Read also allows reading objects across this account. Paste the token once; the wizard derives its S3 credentials and reuses it for zone/privacy verification and cache purge. Keep this runtime token; it is saved for the server and is not revoked after installation. Existing explicit S3 keys are still accepted.`,
    ],
    verification: "5. After you finish these steps, the wizard writes and reads test objects, verifies download/cache purge, and checks private access. Correct console settings and retry here if a check fails. Existing bucket policies are never changed automatically.",
  };
  if (input.kind === "s3") return {
    buckets: [
      `1. Open https://s3.console.aws.amazon.com/s3/buckets?region=${input.region}. Create or select ${pair}, in ${input.region}. Public object reads must be allowed by your account/organization. Do not disable account-wide Block Public Access.`,
      `2. For ${input.publicBucket}, keep BlockPublicAcls and IgnorePublicAcls enabled; disable only bucket-level BlockPublicPolicy and RestrictPublicBuckets. In Permissions → Bucket policy, allow anonymous s3:GetObject on arn:aws:s3:::${input.publicBucket}/* and deny it on arn:aws:s3:::${input.publicBucket}/_internal/*. Do not grant anonymous ListBucket. The exact policy is printed below.`,
      `3. For ${input.internalBucket}, keep all four Block Public Access settings enabled. No public-read policy, website or public CDN should expose it.`,
    ],
    credentials: [
      "4. At https://console.aws.amazon.com/iam/home#/users, create/select a dedicated runtime user. Attach the printed bucket-scoped policy. Under Security credentials → Create access key, copy the access key ID and secret when prompted. Use a permanent key, not an expiring SSO/STS credential.",
    ],
    verification: "5. The wizard verifies both runtime read/write paths, public downloads and anonymous access restrictions. Console corrections can be reverified without starting again.",
  };
  return {
    buckets: [
      `1. Open https://console.cloud.google.com/storage/browser?project=${input.project}. Create or select ${pair}, location ${input.region}, Uniform bucket-level access enabled. Project/organization Public Access Prevention must allow the public bucket; existing keys do not bypass it.`,
      `2. For ${input.publicBucket}, keep Public Access Prevention inherited (not enforced). Under Permissions → Grant access, grant allUsers the role Storage Legacy Object Reader (roles/storage.legacyObjectReader). This permits storage.objects.get without listing. Do not use Storage Object Viewer, which includes listing.`,
      `3. For ${input.internalBucket}, enforce Public Access Prevention and remove any allUsers/allAuthenticatedUsers grant.`,
    ],
    credentials: [
      `4. At https://console.cloud.google.com/iam-admin/serviceaccounts?project=${input.project}, create/select a runtime service account. On each of the two buckets, grant it Storage Object Admin. Do not grant project-wide object access.`,
      "5. Under the service account → Keys → Add key → JSON, download its runtime key and give the wizard the local file path. If key creation is prohibited, obtain an administrator-approved exception or an existing usable runtime key; the console cannot bypass the policy.",
    ],
    verification: "6. The wizard verifies runtime read/write, public downloads and private/listing restrictions. Correct console settings and retry here if needed.",
  };
}

export function renderCloudConnectorStorageSetup(input: { zone: string; domain: string; origin: string; provider: string }): string {
  return `Cloud Connector (Beta), console setup:\n1. At https://dash.cloudflare.com → ${input.zone} → Rules → Cloud Connector, create a rule named Patch ${input.domain}. Provider: ${input.provider}. Bucket endpoint: ${input.origin}. Match expression: http.host eq "${input.domain}". Deploy the rule; keep object paths unchanged.\n2. Accept Cloud Connector's offer to create a proxied DNS record for ${input.domain}. If it is not offered, use DNS → Records → CNAME: name ${input.domain}, target ${input.origin}, Proxied. Wait for Universal SSL to cover ${input.domain}.\n3. Under Rules → Cache Rules, create a separate rule for http.host eq "${input.domain}". Set Eligible for cache, respect origin Cache-Control and Browser TTL, and do not override Edge TTL.\n4. The following runtime token needs only Zone Read and Cache Purge. The object verification checks delivery, cache hit, purge freshness, internal privacy and listing denial after these settings are deployed. Cloud Connector itself does not add a bucket prefix or URL rewrite.`;
}

export function renderR2SetupCredential(accountId: string): string {
  return `Create a disposable account-owned API token in account ${accountId}. The link pre-fills Account API Tokens / Edit, Workers R2 Storage / Edit, Zone / Cache Rules / Edit, Zone / Read and Cache Purge. Before creating it, also add Account → Workers R2 Storage Bucket Item → Write. Review all permissions and restrict zone resources to the download zone. Enable R2 billing before continuing. Do not use a user token or the runtime purge token. This setup token will be revoked after setup and verification finish.`;
}

export function renderGcpSetupCredential(project: string): string {
  return `At https://console.cloud.google.com/iam-admin/serviceaccounts?project=${project}, select a dedicated setup service account → Keys → Add key → JSON. It needs Storage Admin, Service Account Admin and Service Account Key Admin for setup, plus permission to read relevant organization policy. Supply an explicitly disposable key; it will be revoked. A key-creation policy block requires administrator action, not a console workaround.`;
}
