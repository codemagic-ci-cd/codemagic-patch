import { PRODUCT_NAME } from "../../branding";
import { buildDnsTokenTemplateUrl } from "../../providers/cloudflare";
import { ProviderHttpError } from "../../providers/providerError";
import { domainConnectApplyUrl } from "../../providers/domainConnect";
import {
  DnsPreparationError,
  planCloudflareDns,
  writeCloudflareDns,
  type DnsRecordWriter,
  type SetupDnsRecord,
} from "../../providers/dns";
import { detectDnsProvider, findZoneApex } from "../../selfhostDns";
import {
  type ParsedArgs,
  readStringFlag,
  type SelfhostSession,
} from "../selfhostSession";
import { type CommandDeps, UsageError, DeclinedError } from "../shared";
import type { Progress } from "../../progress";
import { askSelect, askValue, notice, offerBrowserOpen, onSignal } from "./ask";

export const DNS_FLAGS = { "--dns-setup": "value" } as const;
type DnsMode = "auto" | "manual" | "cloudflare" | "domain-connect";

export function dnsMode(parsed: ParsedArgs): DnsMode {
  const mode = readStringFlag(parsed, "--dns-setup") ?? "auto";
  if (!["auto", "manual", "cloudflare", "domain-connect"].includes(mode))
    throw new UsageError(
      "--dns-setup must be auto, manual, cloudflare, or domain-connect.",
    );
  return mode as DnsMode;
}

export function createDnsSetup(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
  progress: Pick<Progress, "settle" | "write">,
): DnsRecordWriter {
  const requested = dnsMode(parsed);
  if (!interactive && requested === "domain-connect")
    throw new UsageError(
      "Domain Connect needs browser approval. Run the interactive wizard or use --dns-setup manual.",
    );
  const modes = new Map<string, DnsMode>();
  let token = "";
  let disposed = false;
  return {
    dispose() {
      if (token)
        notice(
          deps,
          "DNS setup is finished for this run. Revoke the Cloudflare DNS setup token at https://dash.cloudflare.com/profile/api-tokens. It was not saved to the server or CLI configuration.",
        );
      token = "";
      disposed = true;
    },
    async cloudflareSetupToken(hostname) {
      if (disposed || !token) return null;
      const zone = await findZoneApex(hostname, deps.dnsClient);
      return zone !== null && (modes.get(zone) ?? requested) === "cloudflare"
        ? token
        : null;
    },
    async apply(record, shouldStop = () => false) {
      if (
        shouldStop() ||
        disposed ||
        requested === "manual" ||
        (!interactive && requested === "auto")
      )
        return false;
      const zone = await findZoneApex(record.hostname, deps.dnsClient);
      if (zone === null) return false;
      let mode = modes.get(zone) ?? requested;
      // Discovered before the question, and only asked about when it can be
      // answered yes: a select whose one usable row is "manually" is not a
      // choice, and no provider advertises the Patch template yet.
      let consentUrl: string | null = null;
      if (mode === "auto") {
        const provider = detectDnsProvider(
          await deps.dnsClient.resolveNs(zone),
        );
        const cloudflare = provider?.name === "Cloudflare";
        if (!cloudflare) {
          consentUrl = await discoverDomainConnect(zone, record);
          if (consentUrl === null) {
            modes.set(zone, "manual");
            return false;
          }
        }
        mode = (await askSelect(deps, {
          message: `How should DNS records for ${zone} be set up?`,
          choices: [
            cloudflare
              ? { title: "Let this wizard add them (Cloudflare API token)", value: "cloudflare" }
              : { title: "Approve them at your DNS provider (Domain Connect)", value: "domain-connect" },
            { title: "Create records manually", value: "manual" },
          ],
          fallback: "manual",
        })) as DnsMode;
        if (!["cloudflare", "domain-connect"].includes(mode)) mode = "manual";
        modes.set(zone, mode);
      }
      if (mode === "manual") return false;
      if (mode === "domain-connect") {
        const url = consentUrl ?? (await discoverDomainConnect(zone, record));
        if (url === null) {
          // Remembered for the zone: the provider will not advertise the
          // template for the next record either.
          modes.set(zone, "manual");
          notice(
            deps,
            `Your DNS provider does not offer Domain Connect for the Patch record templates, so add the records for ${zone} yourself — they are printed above.`,
          );
          return false;
        }
        notice(deps, [
          `Review ${record.type} ${record.hostname} → ${record.value} at your DNS provider, then return here.`,
          url,
        ]);
        await offerBrowserOpen(deps, {
          message: "Open Domain Connect for DNS approval?",
          url,
        });
        // This means the task was handed to the provider, not that DNS is ready.
        return true;
      }
      if (!token) {
        token = deps.env.CMPATCH_DNS_CLOUDFLARE_API_TOKEN?.trim() ?? "";
        if (!token && interactive) {
          const url = buildDnsTokenTemplateUrl({
            name: `${PRODUCT_NAME} DNS setup`,
          });
          notice(deps, [
            `Create a setup-only Cloudflare token. The link pre-fills Zone / Zone / Read and Zone / DNS / Edit, plus Zone / Cache Rules / Edit and Zone / Zone Settings / Read so that, with Cloudflare as the CDN, this wizard also adds the cache rule and turns the proxy on. Under Zone Resources, replace All zones with Specific zone and select ${zone}; also include any other zones being installed. Keep the token until the final DNS change, then revoke it. Do not use the runtime cache-purge token.`,
            url,
          ]);
          await offerBrowserOpen(deps, {
            message: "Open Cloudflare to create a DNS setup token?",
            url,
          });
          token = await askValue(deps, {
            type: "password",
            message: "Cloudflare DNS setup token",
          });
        }
        if (!token)
          throw new UsageError(
            "Set CMPATCH_DNS_CLOUDFLARE_API_TOKEN for Cloudflare DNS setup.",
          );
      }
      let input = { fetch: deps.fetch, apiToken: token, zone, record };
      let plan;
      for (;;) {
        try {
          plan = await planCloudflareDns(input);
          break;
        } catch (error) {
          const detail = error instanceof DnsPreparationError || error instanceof ProviderHttpError
            ? `${error.message} ` : "";
          notice(deps, `${detail}Cloudflare could not safely prepare ${record.hostname}. Check token permissions and existing records, or create the record manually. No write was attempted.`);
          if (!interactive || shouldStop()) return false;
          const action = await askSelect(deps, {
            message: "Correct DNS setup",
            choices: [
              { title: "Retry with the same token", value: "retry" },
              { title: "Replace the DNS setup token", value: "credentials" },
              { title: "Create records manually", value: "manual" },
            ],
            fallback: "manual",
            initial: 0,
          });
          if (action === "credentials") {
            token = await askValue(deps, { type: "password", message: "Cloudflare DNS setup token" });
            input = { ...input, apiToken: token };
          } else if (action !== "retry") {
            modes.set(zone, "manual");
            return false;
          }
        }
      }
      if (shouldStop()) return false;
      if (plan.unchanged) return true;
      const before =
        plan.existing === null
          ? "absent"
          : `${plan.existing.type} ${plan.existing.content}${plan.existing.proxied ? " (proxied)" : ""}`;
      notice(
        deps,
        `DNS change: ${record.hostname}: ${before} → ${record.type} ${record.value} (DNS only).`,
      );
      // Unattended creation is explicitly requested by --dns-setup cloudflare;
      // replacing a record always needs a human to review the concrete change.
      if (plan.existing !== null && !interactive)
        throw new UsageError(
          "An existing DNS record needs replacement. Run the interactive wizard to review it, or change it manually.",
        );
      if (
        interactive &&
        !(await deps.confirm?.({
          initial: plan.existing === null,
          message: `Apply this DNS change for ${record.hostname}?`,
        }))
      )
        return false;
      try {
        if (shouldStop()) return false;
        await writeCloudflareDns({ ...input, plan, shouldStop });
        if (shouldStop()) return false;
        notice(
          deps,
          `Cloudflare accepted ${record.hostname}. DNS propagation is still checked separately.`,
        );
        return true;
      } catch (error) {
        if (
          error instanceof DnsPreparationError ||
          (error instanceof ProviderHttpError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408)
        ) {
          notice(
            deps,
            `${error.message} No DNS write was applied by this attempt. Check the record or continue with manual setup.`,
          );
          return false;
        }
        notice(
          deps,
          `Cloudflare did not confirm the write for ${record.hostname}. It may have succeeded; check the record in Cloudflare before changing it manually. Continuing with DNS verification.`,
        );
        return false;
      }
    },
  };

  /**
   * The consent URL for one record, or null when the provider does not offer
   * it. Under a spinner: discovery is a TXT lookup and up to two HTTPS
   * requests. A record the template cannot express is "not offered" too.
   */
  async function discoverDomainConnect(
    zone: string,
    record: SetupDnsRecord,
  ): Promise<string | null> {
    progress.write(`checking whether ${zone} supports Domain Connect`);
    try {
      return await domainConnectApplyUrl({
        fetch: deps.fetch,
        dns: deps.dnsClient,
        zone,
        record,
      });
    } catch (error) {
      if (error instanceof DnsPreparationError) return null;
      throw error;
    } finally {
      progress.settle();
    }
  }
}

export async function applyDnsRecord(
  session: SelfhostSession,
  record: SetupDnsRecord,
  phase?: { stopped: () => boolean },
): Promise<boolean> {
  session.progress.settle();
  let interrupted = false;
  const removeHook = onSignal(session, () => {
    interrupted = true;
  });
  const stopped = () => interrupted || phase?.stopped() === true;
  try {
    const handled = (await session.dnsSetup?.apply(record, stopped)) ?? false;
    if (stopped() && phase === undefined)
      throw new DeclinedError(
        "DNS setup stopped. Review any record submitted before the interruption before retrying.",
      );
    return !stopped() && handled;
  } finally {
    removeHook();
  }
}
