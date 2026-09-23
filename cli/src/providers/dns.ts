import { ProviderHttpError } from "./providerError";
import { isIP } from "node:net";
import { cloudflareRequest } from "./cloudflare";

// Only locally authored, credential-free diagnostics may be shown to the user.
export class DnsPreparationError extends Error {}

export type SetupDnsRecord = {
  type: "A" | "CNAME";
  hostname: string;
  value: string;
};
export type DnsRecordWriter = {
  /** True means an API write or browser handoff was handled, not that DNS is ready. */
  apply(record: SetupDnsRecord, shouldStop?: () => boolean): Promise<boolean>;
  /**
   * The setup token for a hostname whose zone this run writes through the
   * Cloudflare API, or null when its records are someone else's to add.
   */
  cloudflareSetupToken(hostname: string): Promise<string | null>;
  dispose(): void;
};
export type CloudflareDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  settings?: { flatten_cname?: boolean };
};
const normalize = (value: string) => value.toLowerCase().replace(/\.$/u, "");

export function validateDnsRecord(record: SetupDnsRecord, zone: string): void {
  const name = normalize(record.hostname);
  const validName = (value: string) =>
    value.length <= 253 &&
    value
      .split(".")
      .every((label) =>
        /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u.test(label),
      );
  if (!validName(name) || !(name === zone || name.endsWith(`.${zone}`)))
    throw new DnsPreparationError(
      "DNS record is outside the selected zone or has an invalid name.",
    );
  if (
    record.type === "A"
      ? isIP(record.value) !== 4
      : !validName(normalize(record.value)) || normalize(record.value) === name
  )
    throw new DnsPreparationError("DNS record has an invalid target.");
}

/** The id of exactly the named zone, as the setup token sees it. */
export async function lookupCloudflareZoneId(input: {
  fetch: typeof fetch;
  apiToken: string;
  zone: string;
}): Promise<string> {
  const zones = await cloudflareRequest<{ id: string; name: string }[]>({
    ...input,
    path: `/zones?name=${encodeURIComponent(input.zone)}`,
  });
  if (zones.length !== 1 || normalize(zones[0]!.name) !== input.zone)
    throw new DnsPreparationError(
      "Cloudflare zone is unavailable. Check Zone Read permission and the token's zone scope.",
    );
  return zones[0]!.id;
}

/** Reads the whole exact-name set before deciding whether a write is safe. */
export async function planCloudflareDns(input: {
  fetch: typeof fetch;
  apiToken: string;
  zone: string;
  record: SetupDnsRecord;
}): Promise<{
  path: string;
  existing: CloudflareDnsRecord | null;
  unchanged: boolean;
}> {
  validateDnsRecord(input.record, input.zone);
  const zoneId = await lookupCloudflareZoneId(input);
  const path = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
  const records = await cloudflareRequest<CloudflareDnsRecord[]>({
    ...input,
    path: `${path}?name=${encodeURIComponent(normalize(input.record.hostname))}&per_page=100`,
  });
  // CNAME conflicts with every record; A also cannot coexist with an NS delegation.
  // Refuse ambiguous sets, including a potentially truncated response.
  const conflicts = records.filter(
    (record) =>
      input.record.type === "CNAME" ||
      ["A", "AAAA", "CNAME", "NS"].includes(record.type),
  );
  if (
    records.some(
      (record) => normalize(record.name) !== normalize(input.record.hostname),
    ) ||
    records.length >= 100 ||
    conflicts.length > 1 ||
    conflicts.some((record) => !["A", "CNAME"].includes(record.type))
  )
    throw new DnsPreparationError(
      "Multiple or incompatible DNS records exist at this name. Review them in Cloudflare before continuing; nothing was changed.",
    );
  const existing = conflicts[0] ?? null;
  return {
    path,
    existing,
    unchanged:
      existing !== null &&
      existing.type === input.record.type &&
      normalize(existing.content) === normalize(input.record.value) &&
      existing.proxied !== true &&
      !(
        input.record.type === "CNAME" &&
        existing.settings?.flatten_cname === true
      ),
  };
}

/**
 * Turns the Cloudflare proxy on for the record this run pointed at the
 * server, and for nothing else: a record that has since changed, or that
 * never was this server's, is left exactly as it is.
 */
export async function enableCloudflareProxy(input: {
  fetch: typeof fetch;
  apiToken: string;
  zone: string;
  record: SetupDnsRecord;
  /** Checked right before the write, so a cancelled run submits nothing. */
  shouldStop?: () => boolean;
}): Promise<"enabled" | "already-proxied" | "stopped"> {
  const plan = await planCloudflareDns(input);
  const existing = plan.existing;
  if (
    existing === null ||
    existing.type !== input.record.type ||
    normalize(existing.content) !== normalize(input.record.value)
  )
    throw new DnsPreparationError(
      `${input.record.hostname} does not point at this server in Cloudflare, so the proxy was left as it is.`,
    );
  if (existing.proxied === true) return "already-proxied";
  if (input.shouldStop?.() === true) return "stopped";
  await cloudflareRequest({
    ...input,
    path: `${plan.path}/${encodeURIComponent(existing.id)}`,
    method: "PATCH",
    body: { proxied: true },
  });
  return "enabled";
}

export async function writeCloudflareDns(input: {
  fetch: typeof fetch;
  apiToken: string;
  record: SetupDnsRecord;
  zone: string;
  shouldStop?: () => boolean;
  plan: Awaited<ReturnType<typeof planCloudflareDns>>;
}): Promise<void> {
  if (input.plan.unchanged || input.shouldStop?.()) return;
  let fresh;
  try {
    fresh = await planCloudflareDns(input);
  } catch (error) {
    if (error instanceof DnsPreparationError) throw error;
    throw new DnsPreparationError(
      error instanceof ProviderHttpError
        ? error.message
        : "Could not recheck DNS before writing. Check connectivity and retry.",
    );
  }
  if (fresh.unchanged) return;
  if (JSON.stringify(fresh) !== JSON.stringify(input.plan))
    throw new DnsPreparationError(
      "DNS changed while awaiting approval. Review the current record before retrying.",
    );
  if (input.shouldStop?.()) return;
  await cloudflareRequest({
    ...input,
    path:
      input.plan.existing === null
        ? input.plan.path
        : `${input.plan.path}/${encodeURIComponent(input.plan.existing.id)}`,
    method: input.plan.existing === null ? "POST" : "PATCH",
    body: {
      type: input.record.type,
      name: normalize(input.record.hostname),
      content: normalize(input.record.value),
      ttl: 1,
      proxied: false,
      ...(input.record.type === "CNAME"
        ? { settings: { flatten_cname: false } }
        : {}),
    },
  });
}
