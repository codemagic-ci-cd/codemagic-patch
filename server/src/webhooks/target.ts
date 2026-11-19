import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Checks on where a webhook may be sent
 * (`server/specs/webhooks-tech-spec.md`, Target addresses).
 *
 * The URL is checked when an endpoint is saved, and the resolved address is
 * checked again at every attempt: a public name can be pointed at a private
 * address after it was registered.
 */

export const WEBHOOK_URL_MAX_LENGTH = 2048;

export type WebhookUrlRejection = "invalid_format" | "unsupported_scheme" | "blocked_address";

export type WebhookUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: WebhookUrlRejection };

export interface WebhookTargetOptions {
  /** `WEBHOOK_ALLOW_PRIVATE_TARGETS`: skip the address checks and accept http. */
  allowPrivateTargets: boolean;
}

const BLOCKED_HOSTNAMES = new Set(["localhost"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
for (const [network, prefix] of [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

/** Prefixes whose last 32 bits are an IPv4 address that decides the verdict. */
const EMBEDDED_IPV4_PREFIXES = new BlockList();
EMBEDDED_IPV4_PREFIXES.addSubnet("::ffff:0:0", 96, "ipv6");
EMBEDDED_IPV4_PREFIXES.addSubnet("64:ff9b::", 96, "ipv6");

/** Whether an IP address (v4 or v6 text) is in a range webhooks may not reach. */
export function isBlockedWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return blockedAddresses.check(address, "ipv4");
  }
  if (family !== 6) {
    // Not an address at all: refuse rather than guess.
    return true;
  }

  if (EMBEDDED_IPV4_PREFIXES.check(address, "ipv6")) {
    const embedded = embeddedIpv4(address);
    return embedded === null || blockedAddresses.check(embedded, "ipv4");
  }

  return blockedAddresses.check(address, "ipv6");
}

/** Validates a URL at registration and returns its normalized form. */
export function checkWebhookUrl(input: string, options: WebhookTargetOptions): WebhookUrlCheck {
  if (input.length === 0 || input.length > WEBHOOK_URL_MAX_LENGTH) {
    return { ok: false, reason: "invalid_format" };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid_format" };
  }

  if (url.protocol !== "https:" && !(options.allowPrivateTargets && url.protocol === "http:")) {
    return { ok: false, reason: "unsupported_scheme" };
  }
  // A user name or password in the URL would be stored and shown in clear.
  if (url.username !== "" || url.password !== "" || url.hostname === "") {
    return { ok: false, reason: "invalid_format" };
  }

  // What is stored, and checked again at every attempt, is the normalized
  // form. Percent-encoding can make it longer than what was typed.
  if (url.href.length > WEBHOOK_URL_MAX_LENGTH) {
    return { ok: false, reason: "invalid_format" };
  }

  if (!options.allowPrivateTargets) {
    const host = hostnameOf(url);
    if (isIP(host) !== 0) {
      if (isBlockedWebhookAddress(host)) {
        return { ok: false, reason: "blocked_address" };
      }
    } else if (isBlockedHostname(host)) {
      return { ok: false, reason: "blocked_address" };
    }
  }

  return { ok: true, url: url.href };
}

export interface ResolvedWebhookTarget {
  address: string;
  family: 4 | 6;
}

export type WebhookTargetResolution =
  /** Every address of the host, in the order it resolved. Never empty. */
  | { ok: true; targets: ResolvedWebhookTarget[] }
  | { ok: false; reason: "blocked_address" | "unresolvable" };

export type WebhookLookup = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const systemLookup: WebhookLookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Resolves the host of a webhook URL at send time and returns the addresses
 * to connect to. If any address the host resolves to is blocked the target is
 * refused, so a name with one public and one private record cannot be used to
 * reach the private one.
 */
export async function resolveWebhookTarget(
  url: URL,
  options: WebhookTargetOptions & { lookup?: WebhookLookup },
): Promise<WebhookTargetResolution> {
  const host = hostnameOf(url);
  const literalFamily = isIP(host);

  let addresses: ReadonlyArray<{ address: string; family: number }>;
  if (literalFamily !== 0) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    if (!options.allowPrivateTargets && isBlockedHostname(host)) {
      return { ok: false, reason: "blocked_address" };
    }
    try {
      addresses = await (options.lookup ?? systemLookup)(host);
    } catch {
      return { ok: false, reason: "unresolvable" };
    }
  }

  if (addresses.length === 0) {
    return { ok: false, reason: "unresolvable" };
  }
  if (
    !options.allowPrivateTargets &&
    addresses.some((candidate) => isBlockedWebhookAddress(candidate.address))
  ) {
    return { ok: false, reason: "blocked_address" };
  }

  return {
    ok: true,
    targets: addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 })),
  };
}

/** `URL.hostname` without the brackets of an IPv6 literal or a trailing dot. */
function hostnameOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }

  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function isBlockedHostname(host: string): boolean {
  return (
    BLOCKED_HOSTNAMES.has(host) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

/** The IPv4 address in the last 32 bits of an IPv6 address, in dotted form. */
function embeddedIpv4(address: string): string | null {
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted?.[1]) {
    return isIP(dotted[1]) === 4 ? dotted[1] : null;
  }

  const groups = /([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!groups?.[1] || !groups[2]) {
    return null;
  }
  const high = Number.parseInt(groups[1], 16);
  const low = Number.parseInt(groups[2], 16);

  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}
