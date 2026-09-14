import { isIP } from "node:net";
import type { DnsClient } from "../selfhostDns";
import { type SetupDnsRecord, validateDnsRecord } from "./dns";

export const DOMAIN_CONNECT_PROVIDER = "codemagicpatch.dev";
export const domainConnectService = (type: SetupDnsRecord["type"]) =>
  `selfhost-${type.toLowerCase()}`;

function httpsPrefix(value: unknown): URL {
  if (typeof value !== "string")
    throw new Error("Missing Domain Connect endpoint");
  const url = new URL(value);
  const hostname = url.hostname.replace(/\.$/u, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(hostname.replace(/^\[|\]$/gu, "")) ||
    !hostname.includes(".") ||
    /\.(localhost|local|internal)$/u.test(hostname)
  )
    throw new Error("Invalid Domain Connect endpoint");
  return url;
}

/** No credentials, callback server, or redirects: provider consent happens in the browser. */
export async function domainConnectApplyUrl(input: {
  fetch: typeof fetch;
  dns: DnsClient;
  zone: string;
  record: SetupDnsRecord;
}): Promise<string | null> {
  validateDnsRecord(input.record, input.zone);
  try {
    const discovery = await input.dns.resolveTxt?.(
      `_domainconnect.${input.zone}`,
    );
    if (discovery?.length !== 1) return null;
    const prefix = httpsPrefix(`https://${discovery[0]}`);
    const get = (url: string) =>
      input.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json" },
      });
    const response = await get(
      `${prefix.href.replace(/\/$/u, "")}/v2/${encodeURIComponent(input.zone)}/settings`,
    );
    if (!response.ok) return null;
    const settings = (await response.json()) as {
      urlAPI?: string;
      urlSyncUX?: string;
    };
    const api = httpsPrefix(settings.urlAPI).href.replace(/\/$/u, "");
    const ux = httpsPrefix(settings.urlSyncUX).href.replace(/\/$/u, "");
    const path = `/v2/domainTemplates/providers/${DOMAIN_CONNECT_PROVIDER}/services/${domainConnectService(input.record.type)}`;
    const support = await get(`${api}${path}`);
    if (!support.ok) return null;
    const text = await support.text();
    if (text.trim()) {
      const template = JSON.parse(text) as {
        syncBlock?: boolean;
        syncPubKeyDomain?: string;
        version?: number;
      };
      if (
        template.syncBlock ||
        template.syncPubKeyDomain ||
        (template.version !== undefined && template.version !== 1)
      )
        return null;
    }
    const url = new URL(`${ux}${path}/apply`);
    url.searchParams.set("domain", input.zone);
    const name = input.record.hostname.toLowerCase().replace(/\.$/u, "");
    if (name !== input.zone)
      url.searchParams.set("host", name.slice(0, -(input.zone.length + 1)));
    url.searchParams.set("target", input.record.value.replace(/\.$/u, ""));
    return url.href;
  } catch {
    return null;
  }
}
