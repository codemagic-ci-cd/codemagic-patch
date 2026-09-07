/**
 * The DNS half of the install wizard.
 *
 * Two things make this more than a lookup. The wait is against the zone's
 * **authoritative** nameservers rather than the system resolver, because a
 * resolver that has just answered NXDOMAIN caches that answer for the zone's
 * negative TTL — often an hour — and a user who adds the record while the
 * wizard waits would otherwise sit through it. And a lookup that does not
 * return the expected address is never reported as "verification failed":
 * there are three distinct causes, each with a different fix, and naming the
 * wrong one sends the user to change something that was already right.
 */

import { Resolver } from "node:dns/promises";

export type DnsClient = {
  /**
   * A records for `hostname`, resolved through `servers` when given.
   *
   * Two kinds of nothing, told apart on purpose: a name that answers nothing
   * (no record, NXDOMAIN) resolves to `[]`, while a resolver that could not be
   * asked at all — a timeout, a refused connection, SERVFAIL — rejects. The
   * waits fall back to the system resolver on the second and must not on the
   * first; an empty array for both would read every network that blocks port
   * 53 as "the record is not there yet", for the whole wait.
   */
  resolveA: (
    hostname: string,
    servers?: readonly string[],
  ) => Promise<string[]>;
  /**
   * CNAME targets for `hostname`, resolved through `servers` when given, with
   * the same empty-versus-rejected contract as `resolveA`. The query ACM
   * validation records answer: they are CNAMEs to names with no A records
   * behind them, so an address lookup can never see them.
   */
  resolveCname: (
    hostname: string,
    servers?: readonly string[],
  ) => Promise<string[]>;
  /** Authoritative nameserver hostnames for a zone. */
  resolveNs: (zone: string) => Promise<string[]>;
  /** True when `name` is a zone apex — i.e. it has an SOA of its own. */
  hasSoa: (name: string) => Promise<boolean>;
  /** Addresses for a nameserver's own hostname, so it can be queried directly. */
  resolveNameserverAddresses: (hostname: string) => Promise<string[]>;
};

/**
 * Walks up from a hostname to the zone that actually holds it.
 *
 * Bottom-up, stopping at the first name with an SOA. That is what makes
 * multi-label public suffixes work without a suffix list: `example.co.uk` has
 * an SOA and `www.example.co.uk` does not, so the walk stops on the right
 * name — and it stops there before ever reaching `co.uk`, which is a zone too.
 */
export async function findZoneApex(
  hostname: string,
  client: Pick<DnsClient, "hasSoa">,
): Promise<string | null> {
  const labels = hostname.split(".").filter((label) => label.length > 0);

  // A single label is never a zone worth asking about, and the TLD itself is
  // never the user's zone, so the walk stops one short of it.
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (await client.hasSoa(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export type DnsProvider = {
  /** Where the user goes to add the record. */
  consoleUrl: string;
  name: string;
};

/**
 * Nameserver pattern → the console the records are added in.
 *
 * Detection exists to replace "add these records at your DNS provider" with
 * "add these records in Cloudflare, under DNS > Records". Patterns rather than
 * suffixes because the identifying token is not always at the end: Route 53
 * hands out `ns-1234.awsdns-56.org`, `.co.uk`, `.net`, and `.com` — four
 * different suffixes around one label. An unrecognised nameserver is not a
 * failure; the copy falls back to naming what was found.
 */
const PROVIDER_BY_NAMESERVER: ReadonlyArray<[RegExp, DnsProvider]> = [
  [
    /\.ns\.cloudflare\.com$/u,
    { consoleUrl: "https://dash.cloudflare.com/", name: "Cloudflare" },
  ],
  [
    /(^|\.)awsdns(-\d+)?\./u,
    {
      consoleUrl: "https://console.aws.amazon.com/route53/v2/hostedzones",
      name: "Amazon Route 53",
    },
  ],
  [
    /\.domaincontrol\.com$/u,
    { consoleUrl: "https://dcc.godaddy.com/manage/dns", name: "GoDaddy" },
  ],
  [
    /\.registrar-servers\.com$/u,
    {
      consoleUrl: "https://ap.www.namecheap.com/domains/list/",
      name: "Namecheap",
    },
  ],
  [
    /\.digitalocean\.com$/u,
    {
      consoleUrl: "https://cloud.digitalocean.com/networking/domains",
      name: "DigitalOcean",
    },
  ],
  // Order matters here: Cloud DNS hands out ns-cloud-* under the same domain
  // the old Google Domains registrar used, and only the prefix tells them apart.
  [
    /(^|\.)ns-cloud-[a-z]\d\.googledomains\.com$/u,
    {
      consoleUrl: "https://console.cloud.google.com/net-services/dns/zones",
      name: "Google Cloud DNS",
    },
  ],
  [
    /\.googledomains\.com$/u,
    { consoleUrl: "https://domains.squarespace.com/", name: "Squarespace" },
  ],
  [
    /(^|\.)ns\d-\d+\.azure-dns\.(com|net|org|info)$/u,
    {
      consoleUrl: "https://portal.azure.com/#browse/Microsoft.Network%2FdnsZones",
      name: "Azure DNS",
    },
  ],
  [
    /\.vercel-dns\.com$/u,
    { consoleUrl: "https://vercel.com/dashboard/domains", name: "Vercel" },
  ],
  [
    /\.dnsimple\.com$/u,
    { consoleUrl: "https://dnsimple.com/dashboard", name: "DNSimple" },
  ],
  [
    /\.nsone\.net$/u,
    { consoleUrl: "https://my.nsone.net/#/zones", name: "NS1" },
  ],
  [
    /\.gandi\.net$/u,
    { consoleUrl: "https://admin.gandi.net/domain", name: "Gandi" },
  ],
  [
    /\.(hetzner\.com|hetzner\.de|your-server\.de)$/u,
    { consoleUrl: "https://dns.hetzner.com/", name: "Hetzner DNS" },
  ],
  [
    /\.name\.com$/u,
    { consoleUrl: "https://www.name.com/account/domain", name: "Name.com" },
  ],
  [
    /\.linode\.com$/u,
    { consoleUrl: "https://cloud.linode.com/domains", name: "Linode" },
  ],
];

export function detectDnsProvider(
  nameservers: readonly string[],
): DnsProvider | null {
  for (const nameserver of nameservers) {
    const normalized = nameserver.toLowerCase().replace(/\.$/u, "");
    for (const [pattern, provider] of PROVIDER_BY_NAMESERVER) {
      if (pattern.test(normalized)) {
        return provider;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cloudflare's published edge ranges
// ---------------------------------------------------------------------------

/**
 * https://www.cloudflare.com/ips-v4, as of this writing.
 *
 * Used for one judgement only: an A record that resolves into these ranges is
 * a *proxied* Cloudflare record, not a wrong one. Without this the wizard
 * would tell a user whose record is correct that it points somewhere
 * unexpected. The list changes rarely and a stale entry degrades to the
 * generic "different value" message, never to a false pass.
 */
const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "108.162.192.0/18",
  "131.0.72.0/22",
  "141.101.64.0/18",
  "162.158.0.0/15",
  "172.64.0.0/13",
  "173.245.48.0/20",
  "188.114.96.0/20",
  "190.93.240.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
];

export function isCloudflareEdgeAddress(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) {
    return false;
  }

  return CLOUDFLARE_IPV4_RANGES.some((range) => {
    const [network, bits] = range.split("/");
    const base = ipv4ToNumber(network ?? "");
    const prefix = Number.parseInt(bits ?? "", 10);
    if (base === null || Number.isNaN(prefix)) {
      return false;
    }

    // `>>> 0` keeps the mask unsigned; a /0 would shift by 32, which in JS is
    // a no-op rather than zero, so it is spelled out.
    const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

function ipv4ToNumber(address: string): number | null {
  const octets = address.split(".");
  if (octets.length !== 4) {
    return null;
  }

  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/u.test(octet)) {
      return null;
    }

    const part = Number.parseInt(octet, 10);
    if (part > 255) {
      return null;
    }

    value = (value * 256 + part) >>> 0;
  }

  return value;
}

// ---------------------------------------------------------------------------
// What a lookup means
// ---------------------------------------------------------------------------

export type RecordDiagnosis =
  /** The address is there. */
  | { kind: "match" }
  /** Nothing answered — the record has not been added, or has not spread yet. */
  | { kind: "missing" }
  /** An answer, but not this server's — most often a record left from before. */
  | { kind: "different"; found: string[] }
  /**
   * The record is on Cloudflare with the orange cloud on. Correct in itself,
   * but Caddy cannot get a certificate through it, so the record has to be
   * grey-clouded until the install finishes.
   */
  | { kind: "cloudflare-proxied"; found: string[] };

export function diagnoseRecord(input: {
  expected: string;
  found: readonly string[];
}): RecordDiagnosis {
  if (input.found.includes(input.expected)) {
    return { kind: "match" };
  }

  if (input.found.length === 0) {
    return { kind: "missing" };
  }

  return input.found.every((address) => isCloudflareEdgeAddress(address))
    ? { found: [...input.found], kind: "cloudflare-proxied" }
    : { found: [...input.found], kind: "different" };
}

// ---------------------------------------------------------------------------
// The wait
// ---------------------------------------------------------------------------

export type DnsWaitOutcome =
  | { kind: "abandoned" }
  | { kind: "ready" }
  | { kind: "timed-out"; last: RecordDiagnosis };

export type DnsWaitInput = {
  client: DnsClient;
  expected: string;
  hostname: string;
  intervalMilliseconds?: number;
  /**
   * What counts as done. The default is a value match — the A-record wait.
   * The proxy-switch wait passes the opposite: it is over when the answer
   * *leaves* the direct address and enters Cloudflare's edge ranges.
   */
  isReady?: (diagnosis: RecordDiagnosis) => boolean;
  /** Called after every attempt, so the caller can narrate what it found. */
  onAttempt?: (diagnosis: RecordDiagnosis) => void;
  /**
   * Called once, when the zone's own nameservers could not be asked and the
   * rest of the wait goes through the system resolver — the caller says so,
   * because a record added now then shows up minutes later than the step
   * promises, not seconds.
   */
  onFallback?: () => void;
  /** Returns true to stop waiting — the "set this up later" escape. */
  shouldAbandon?: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMilliseconds?: number;
  now: () => number;
};

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 10_000;
const DEFAULT_POLL_TIMEOUT_MILLISECONDS = 30 * 60 * 1_000;

/**
 * Polls until the hostname resolves to the server's address — or, when the
 * caller passes its own `isReady`, until the diagnosis it is waiting for.
 *
 * Queried against the zone's own nameservers wherever they can be found, so a
 * record added thirty seconds ago is seen thirty seconds later instead of
 * after the resolver's negative-cache TTL expires. When the authoritative
 * servers cannot be reached (a split-horizon network, egress rules on port
 * 53), it falls back to the system resolver and the caller says so — an honest
 * slower answer beats a wait that never completes.
 */
export async function waitForDnsRecord(
  input: DnsWaitInput,
): Promise<DnsWaitOutcome> {
  const interval =
    input.intervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const timeout = input.timeoutMilliseconds ?? DEFAULT_POLL_TIMEOUT_MILLISECONDS;
  const isReady =
    input.isReady ?? ((diagnosis: RecordDiagnosis) => diagnosis.kind === "match");
  const deadline = input.now() + timeout;

  // Resolved once and reused: the zone apex and its nameserver addresses
  // cannot change mid-wait, and re-walking them on every poll multiplied each
  // attempt's DNS traffic several-fold on slow resolvers. A wait that starts
  // before the zone itself resolves still recovers — the authority is
  // re-derived until one is found, and only a found one is cached.
  let authority: readonly string[] | null = null;
  // Sticky for the rest of the wait: nameservers that did not answer once
  // will not answer on the next poll either, and asking them first every time
  // would cost each attempt a full timeout before the system resolver is
  // tried. Reported to the caller the one time it happens.
  let fellBack = false;
  const onFallback = () => {
    fellBack = true;
    input.onFallback?.();
  };

  let last: RecordDiagnosis = { kind: "missing" };
  for (;;) {
    if (input.shouldAbandon?.() === true) {
      return { kind: "abandoned" };
    }

    authority ??= await resolveAuthority(input.client, input.hostname);
    last = diagnoseRecord({
      expected: input.expected,
      found: await lookupAuthoritative(
        input.client,
        input.hostname,
        fellBack ? null : authority,
        onFallback,
      ),
    });
    input.onAttempt?.(last);

    if (isReady(last)) {
      return { kind: "ready" };
    }

    if (input.now() >= deadline) {
      return { kind: "timed-out", last };
    }

    await input.sleep(interval);
  }
}

/**
 * The zone's own nameserver addresses for a hostname, or null when they cannot
 * be determined — the caller then falls back to the system resolver.
 */
export async function resolveAuthority(
  client: DnsClient,
  hostname: string,
): Promise<readonly string[] | null> {
  try {
    const zone = await findZoneApex(hostname, client);
    if (zone === null) {
      return null;
    }

    const nameservers = await client.resolveNs(zone);
    const addresses = (
      await Promise.all(
        nameservers
          .slice(0, 2)
          .map((nameserver) =>
            client
              .resolveNameserverAddresses(nameserver)
              .catch(() => [] as string[]),
          ),
      )
    ).flat();

    // Deduplicated: two nameserver hostnames often resolve to the same
    // address, and asking one resolver twice buys nothing.
    const unique = [...new Set(addresses)];
    return unique.length > 0 ? unique : null;
  } catch {
    // Every failure here is "could not ask authoritatively".
    return null;
  }
}

/**
 * A records from the zone's own nameservers, falling back to the system
 * resolver. The fallback is the honest one: no answer at all is worse than a
 * cached answer the caller is told may be stale. An already-resolved authority
 * can be passed in so a poll loop does not re-derive it on every attempt, and
 * `onFallback` fires when that authority could not be asked, so the loop can
 * stop asking it and say so.
 */
export async function lookupAuthoritative(
  client: DnsClient,
  hostname: string,
  authority?: readonly string[] | null,
  onFallback?: () => void,
): Promise<string[]> {
  const servers =
    authority === undefined ? await resolveAuthority(client, hostname) : authority;

  if (servers !== null) {
    try {
      return await client.resolveA(hostname, servers);
    } catch {
      // The nameservers exist but could not be asked — most often a network
      // that only lets its own resolvers speak on port 53. Those still can.
      onFallback?.();
    }
  }

  try {
    return await client.resolveA(hostname);
  } catch {
    return [];
  }
}

/**
 * CNAME targets from the zone's own nameservers, falling back to the system
 * resolver — `lookupAuthoritative` for the query the ACM validation record
 * answers. Authoritative routing matters even more here than for the A wait:
 * the poll starts before the record exists, so the system resolver's first
 * answer is an NXDOMAIN it then caches for the zone's negative TTL, and every
 * later attempt would re-read that cache instead of seeing the live record.
 */
export async function lookupAuthoritativeCname(
  client: DnsClient,
  hostname: string,
  authority?: readonly string[] | null,
  onFallback?: () => void,
): Promise<string[]> {
  const servers =
    authority === undefined ? await resolveAuthority(client, hostname) : authority;

  if (servers !== null) {
    try {
      return await client.resolveCname(hostname, servers);
    } catch {
      // Same fallback as `lookupAuthoritative`, reported the same way.
      onFallback?.();
    }
  }

  try {
    return await client.resolveCname(hostname);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The ACM validation record
// ---------------------------------------------------------------------------

export type CnameDiagnosis =
  /** The record is there and points where AWS asked. */
  | { kind: "match" }
  /** Nothing answered — not added, or not spread yet. */
  | { kind: "missing" }
  /** An answer, but not the value AWS gave. */
  | { kind: "different"; found: string[] }
  /**
   * The record went in under `<name>.<zone>` because the console appended the
   * zone to a name that already carried it. Correct-looking in both consoles,
   * and it stalls the certificate in "Pending validation" with no explanation
   * anywhere — so it is a diagnosis of its own, not a "different".
   */
  | { kind: "doubled"; at: string };

/** Trailing dot and case are presentation, not identity, in a CNAME target. */
function normalizeName(name: string): string {
  return name.replace(/\.$/u, "").toLowerCase();
}

export function diagnoseCname(input: {
  doubledAt: string | null;
  expected: string;
  found: readonly string[];
  foundDoubled: readonly string[];
}): CnameDiagnosis {
  const expected = normalizeName(input.expected);
  if (input.found.some((target) => normalizeName(target) === expected)) {
    return { kind: "match" };
  }

  if (input.found.length > 0) {
    return { found: [...input.found], kind: "different" };
  }

  // Only meaningful while the name itself answers nothing: a record at both
  // names is still a working record.
  return input.doubledAt !== null && input.foundDoubled.length > 0
    ? { at: input.doubledAt, kind: "doubled" }
    : { kind: "missing" };
}

export type CnameWaitOutcome =
  | { kind: "abandoned" }
  | { kind: "ready" }
  | { kind: "timed-out"; last: CnameDiagnosis };

/**
 * Polls until the ACM validation record is live.
 *
 * A CNAME lookup, necessarily: the record is a CNAME to a name with no A
 * records behind it, so an address lookup answers empty for a correctly-added
 * record and could never tell a missing record from a present one. The doubled
 * name is checked on every attempt rather than once, because the mistake is
 * usually made *during* the wait — the user is adding the record while this
 * runs.
 *
 * Queried against the zone's own nameservers, exactly like the A-record wait
 * and for a sharper version of its reason: this poll *always* starts before
 * the record exists, so the system resolver's first answer is a negative-cache
 * entry that would keep reporting "missing" for a live record until the
 * negative TTL expires. The validation name lives in the user's domain zone,
 * so its doubled sibling is asked through the same authority.
 */
export async function waitForCnameRecord(input: {
  client: DnsClient;
  /** The name a zone-appending console would have produced, if any. */
  doubledAt: string | null;
  expected: string;
  intervalMilliseconds?: number;
  name: string;
  now: () => number;
  onAttempt?: (diagnosis: CnameDiagnosis) => void;
  /** As on `DnsWaitInput`: once, when the wait moves to the system resolver. */
  onFallback?: () => void;
  shouldAbandon?: () => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMilliseconds?: number;
}): Promise<CnameWaitOutcome> {
  const interval =
    input.intervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const timeout =
    input.timeoutMilliseconds ?? DEFAULT_POLL_TIMEOUT_MILLISECONDS;
  const deadline = input.now() + timeout;

  // Resolved once and reused, recovering like the A-record wait: re-derived
  // until one is found, and only a found one is cached.
  let authority: readonly string[] | null = null;
  // Sticky across both names and every later poll, for the A-record wait's
  // reason: a timeout paid once is a timeout the next lookup can skip.
  let fellBack = false;
  const onFallback = () => {
    fellBack = true;
    input.onFallback?.();
  };

  let last: CnameDiagnosis = { kind: "missing" };
  for (;;) {
    if (input.shouldAbandon?.() === true) {
      return { kind: "abandoned" };
    }

    authority ??= await resolveAuthority(input.client, input.name);
    const found = await lookupAuthoritativeCname(
      input.client,
      input.name,
      fellBack ? null : authority,
      onFallback,
    );
    last = diagnoseCname({
      doubledAt: input.doubledAt,
      expected: input.expected,
      found,
      foundDoubled:
        input.doubledAt === null || found.length > 0
          ? []
          : await lookupAuthoritativeCname(
              input.client,
              input.doubledAt,
              fellBack ? null : authority,
              onFallback,
            ),
    });
    input.onAttempt?.(last);

    if (last.kind === "match") {
      return { kind: "ready" };
    }

    if (input.now() >= deadline) {
      return { kind: "timed-out", last };
    }

    await input.sleep(interval);
  }
}

/**
 * The codes for "the resolver could not be asked", as opposed to "it answered
 * that there is nothing there" (`ENODATA`, `ENOTFOUND`). Node reports both
 * through the same rejection, and only the code tells them apart.
 */
const DNS_TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  "EBADRESP",
  "ECANCELLED",
  "ECONNREFUSED",
  "EREFUSED",
  "ESERVFAIL",
  "ETIMEOUT",
]);

function isDnsTransportError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    DNS_TRANSPORT_ERROR_CODES.has(error.code)
  );
}

/**
 * The default `DnsClient`, wired at the call site and kept out of every test
 * path. A missing record surfaces as an empty array rather than as a thrown
 * error, because "not there yet" is the normal state during this wait — but a
 * resolver that could not be asked at all still rejects, because the waits'
 * fallback to the system resolver is keyed on exactly that.
 */
export function createDnsClient(): DnsClient {
  const system = new Resolver({ timeout: 5_000, tries: 2 });

  // A direct resolver is built per query: `setServers` is per instance, and
  // the one pointed at the zone's nameservers must not be the one the system
  // lookups share.
  const resolverFor = (servers?: readonly string[]): Resolver => {
    if (servers === undefined) {
      return system;
    }

    const direct = new Resolver({ timeout: 5_000, tries: 2 });
    direct.setServers([...servers]);
    return direct;
  };

  // The contract on `DnsClient`: `[]` for a name that answers nothing, the
  // rejection kept for a resolver that could not be asked.
  const emptyUnlessUnreachable = async (
    query: () => Promise<string[]>,
  ): Promise<string[]> => {
    try {
      return await query();
    } catch (error) {
      if (isDnsTransportError(error)) {
        throw error;
      }

      return [];
    }
  };

  return {
    async hasSoa(name) {
      try {
        await system.resolveSoa(name);
        return true;
      } catch {
        return false;
      }
    },
    resolveA(hostname, servers) {
      return emptyUnlessUnreachable(() =>
        resolverFor(servers).resolve4(hostname),
      );
    },
    resolveCname(hostname, servers) {
      return emptyUnlessUnreachable(() =>
        resolverFor(servers).resolveCname(hostname),
      );
    },
    async resolveNameserverAddresses(hostname) {
      try {
        return await system.resolve4(hostname);
      } catch {
        return [];
      }
    },
    async resolveNs(zone) {
      try {
        return await system.resolveNs(zone);
      } catch {
        return [];
      }
    },
  };
}
