/**
 * The decisions `cmpatch selfhost install` makes, as pure functions.
 *
 * Nothing here prompts, connects, or renders a spinner: it takes the probe's
 * facts plus the CLI's own config and answers what the command must do next.
 * The command layer is the only thing that talks to the user, so every branch
 * below is testable without a terminal and without an ssh.
 */

import { connect } from "node:net";

import type { SelfhostPendingInstall } from "./configStore";
import type { CloudProvider, RemoteHostFacts } from "./selfhostRemote";

// ---------------------------------------------------------------------------
// Memory preflight
// ---------------------------------------------------------------------------

/**
 * The floor, in bytes of `MemTotal` **as the kernel reports it** — deliberately
 * not "2 GB of advertised instance memory". A 2 GiB t3.small reports around
 * 1.9 GiB once firmware and the kernel's own reservations are subtracted, so a
 * 2 GiB threshold would reject exactly the smallest instance the installer is
 * known to complete on (measured peak: ~1.62 GiB for a cold-cache parallel
 * build). 1.75 GiB sits between that measured peak and the 1 GiB instances the
 * build reliably OOMs on.
 */
export const MINIMUM_MEMORY_BYTES = Math.round(1.75 * 1024 * 1024 * 1024);

export type MemoryVerdict =
  | { kind: "ok"; reportedBytes: number }
  /** The probe could not read /proc/meminfo — proceed, do not invent a number. */
  | { kind: "unknown" }
  | { kind: "too-small"; reportedBytes: number };

export function checkHostMemory(
  memoryTotalBytes: number | null,
): MemoryVerdict {
  if (memoryTotalBytes === null) {
    return { kind: "unknown" };
  }

  return memoryTotalBytes >= MINIMUM_MEMORY_BYTES
    ? { kind: "ok", reportedBytes: memoryTotalBytes }
    : { kind: "too-small", reportedBytes: memoryTotalBytes };
}

export function formatMemory(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Instance-size guidance, in the words each provider's console uses. */
export function renderMemoryRejection(
  reportedBytes: number,
  cloudProvider: CloudProvider | null,
): string[] {
  const upgrade: Record<CloudProvider, string> = {
    aws: "On AWS, a t3.small (2 GB) or larger works; a t3.micro does not.",
    azure: "On Azure, a B1ms (2 GB) or larger works; a B1s does not.",
    digitalocean:
      "On DigitalOcean, a 2 GB Droplet or larger works; the 1 GB size does not.",
    gcp: "On Google Cloud, an e2-small (2 GB) or larger works; an e2-micro does not.",
    hetzner: "On Hetzner, a CX22 (4 GB) or larger works comfortably.",
    other: "A server with 2 GB of memory or more works.",
  };

  return [
    `This server reports ${formatMemory(reportedBytes)} of memory, and the install needs at least ${formatMemory(
      MINIMUM_MEMORY_BYTES,
    )}.`,
    "",
    // Named, because the failure it prevents lands twenty minutes in and looks
    // like a compiler crash rather than a too-small machine.
    "Building the server images is the memory-hungry step; on a smaller machine it is killed part-way through with no useful message.",
    upgrade[cloudProvider ?? "other"],
    "",
    "Resize the server and run this again, or pass --skip-memory-check to try anyway.",
  ];
}

// ---------------------------------------------------------------------------
// Inbound ports
// ---------------------------------------------------------------------------

/**
 * Whether 80 and 443 accept a connection from *here*.
 *
 * Advisory on purpose, and labelled as such wherever it is rendered: a failure
 * can mean a closed firewall (the common case, and the one worth a hint) or a
 * network between the user and the server that blocks outbound 80/443, which
 * says nothing about the server. It runs early because the alternative is
 * learning the same thing from a Let's Encrypt timeout twenty minutes later.
 */
export type PortProbeResult = {
  closedPorts: number[];
  openPorts: number[];
};

export type TcpConnect = (input: {
  host: string;
  port: number;
  timeoutMilliseconds: number;
}) => Promise<boolean>;

export const PUBLIC_PORTS = [80, 443] as const;

export async function probePublicPorts(input: {
  connect: TcpConnect;
  host: string;
  ports?: readonly number[];
  timeoutMilliseconds?: number;
}): Promise<PortProbeResult> {
  const ports = input.ports ?? PUBLIC_PORTS;
  const timeoutMilliseconds = input.timeoutMilliseconds ?? 5_000;
  const open: number[] = [];
  const closed: number[] = [];

  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      reachable: await input.connect({
        host: input.host,
        port,
        timeoutMilliseconds,
      }),
    })),
  );

  for (const { port, reachable } of results) {
    (reachable ? open : closed).push(port);
  }

  return { closedPorts: closed, openPorts: open };
}

/**
 * The same wording is reused during the Let's Encrypt wait, which is the other
 * place this exact problem surfaces — there as the explanation for a wait that
 * is not finishing, here as a warning before the build starts.
 */
export function renderFirewallHint(
  closedPorts: readonly number[],
  cloudProvider: CloudProvider | null,
): string[] {
  const where: Record<CloudProvider, string> = {
    aws: "In the AWS console, open the instance's Security Group and add inbound rules for HTTP (80) and HTTPS (443) from 0.0.0.0/0.",
    azure:
      "In the Azure portal, open the VM's Network security group and add inbound port rules for 80 and 443.",
    digitalocean:
      "In the DigitalOcean console, check Networking > Firewalls for a rule attached to this Droplet, and allow HTTP and HTTPS.",
    gcp: "In the Google Cloud console, add the http-server and https-server network tags to the VM, or add a VPC firewall rule allowing tcp:80 and tcp:443.",
    hetzner:
      "In the Hetzner Cloud console, open Firewalls and allow inbound TCP 80 and 443 for this server.",
    other: "Open inbound TCP 80 and 443 in your provider's firewall.",
  };

  return [
    `Could not reach port ${closedPorts.join(" and ")} on this server from here.`,
    where[cloudProvider ?? "other"],
    // Ordered second because a provider firewall is the far more common cause,
    // and running ufw commands against an untouched host wastes the user's time.
    "If the provider firewall is already open, check the server's own firewall: `sudo ufw allow 80,443/tcp` (Ubuntu/Debian) or `sudo firewall-cmd --add-service={http,https} --permanent && sudo firewall-cmd --reload` (Fedora/RHEL).",
    "",
    "This is a warning, not a failure — a network between you and the server can block these ports too. The install needs them open for Let's Encrypt to issue a certificate.",
  ];
}

// ---------------------------------------------------------------------------
// Install-state detection
// ---------------------------------------------------------------------------

export type InstallState =
  /** No `.env.selfhost`: nothing has been installed here. */
  | { kind: "fresh" }
  /**
   * An env file and a server whose readiness check answers — liveness alone
   * is not enough, since the API process outliving its database is exactly
   * what an interrupted install looks like (`HEALTH_PROBE_SCRIPT`).
   */
  | { kind: "installed"; serverUrl: string | null }
  /**
   * An env file, an unhealthy server, and this machine's own record that it
   * started the install — so resume / repair / start over are all meaningful.
   */
  | {
      failure: InstallFailure;
      kind: "incomplete";
      serverUrl: string | null;
      startedAt: string | null;
    }
  /**
   * An env file, an unhealthy server, and no record. Indistinguishable from
   * the above by looking at the server, so the CLI refuses to guess: this is
   * far more likely a working deployment that is down right now, and every
   * mutating edge is wrong for it.
   */
  | { kind: "unknown-unhealthy"; serverUrl: string | null };

export function classifyInstallState(input: {
  facts: RemoteHostFacts;
  pendingInstall: SelfhostPendingInstall | undefined;
}): InstallState {
  if (!input.facts.envFilePresent) {
    return { kind: "fresh" };
  }

  const serverUrl = input.facts.serverUrl;

  // A probe that could not ask (no install scope, or no server URL to curl)
  // must not read as "unhealthy": that would turn a missing answer into a
  // start-over offer.
  if (input.facts.install?.healthy !== false) {
    return { kind: "installed", serverUrl };
  }

  if (input.pendingInstall === undefined) {
    return { kind: "unknown-unhealthy", serverUrl };
  }

  return {
    failure: normalizeFailure(input.pendingInstall.failure),
    kind: "incomplete",
    serverUrl,
    startedAt: input.pendingInstall.startedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * What the previous run died on. Its only job is to choose the default
 * recovery edge, so the classes are grouped by *what the user must do*, not by
 * which line of the script printed the message.
 */
export type InstallFailure =
  | "cloudflare"
  | "cloudfront"
  | "docker"
  | "domains"
  | "oauth"
  | "public-https"
  | "unknown";

export type RecoveryEdge = "repair" | "resume" | "start-over";

const FAILURE_SIGNATURES: ReadonlyArray<[InstallFailure, RegExp]> = [
  ["cloudflare", /cloudflare cache-purge check failed/iu],
  ["cloudfront", /cloudfront invalidation check failed/iu],
  // Both the API and the storage host land here; the script's own wait names
  // which one in the same message.
  ["public-https", /did not become reachable at|timed out waiting for/iu],
  ["domains", /must differ|must be a bare domain|must be a fully-qualified/iu],
  ["oauth", /oauth sign-in provider|client secret must be repaired together/iu],
  [
    "docker",
    /docker compose v2 is required|missing required command: docker/iu,
  ],
];

export function classifyInstallFailure(
  failureMessage: string | null,
): InstallFailure {
  if (failureMessage === null) {
    return "unknown";
  }

  for (const [failure, pattern] of FAILURE_SIGNATURES) {
    if (pattern.test(failureMessage)) {
      return failure;
    }
  }

  return "unknown";
}

/**
 * The edge the recovery select lands on.
 *
 * `resume` is the default for everything unclassified, because it is the only
 * edge that cannot make things worse: repair re-asks values that may have been
 * right, and start over discards volumes.
 */
export function defaultRecoveryEdge(failure: InstallFailure): RecoveryEdge {
  switch (failure) {
    case "cloudflare":
    case "cloudfront":
    case "domains":
    case "oauth":
      // A value the user typed was wrong; replaying it cannot help.
      return "repair";
    case "docker":
    case "public-https":
    case "unknown":
      return "resume";
  }
}

export type RepairScope =
  | "all"
  | "cloudflare"
  | "cloudfront"
  | "domains"
  | "oauth";

/** Which answers the repair edge should re-ask, given what failed. */
export function repairScopeFor(failure: InstallFailure): RepairScope {
  switch (failure) {
    case "cloudflare":
      return "cloudflare";
    case "cloudfront":
      return "cloudfront";
    case "domains":
    case "public-https":
      return "domains";
    case "oauth":
      return "oauth";
    case "docker":
    case "unknown":
      return "all";
  }
}

function normalizeFailure(value: string | undefined): InstallFailure {
  const known: readonly string[] = [
    "cloudflare",
    "cloudfront",
    "docker",
    "domains",
    "oauth",
    "public-https",
    "unknown",
  ];

  return value !== undefined && known.includes(value)
    ? (value as InstallFailure)
    : "unknown";
}

// ---------------------------------------------------------------------------
// Answers -> install.sh environment
// ---------------------------------------------------------------------------

export type DeliverySelection =
  | { apiToken: string; kind: "cloudflare"; zoneId: string }
  | {
      accessKeyId?: string;
      /**
       * `d….cloudfront.net`. Wizard-only: it is what the viewer record is
       * pointed at during the cutover, and it is deliberately NOT passed to
       * `install.sh`, which has no setting for it.
       */
      distributionDomain?: string;
      distributionId: string;
      kind: "cloudfront";
      originVerifySecret?: string;
      secretAccessKey?: string;
      storageOriginDomain?: string;
    }
  | { kind: "none" };

export type InstallAnswers = {
  adminEmail: string;
  apiDomain: string;
  delivery: DeliverySelection;
  githubClientId: string;
  githubClientSecret: string;
  storageDomain: string;
};

/**
 * The complete answer set for a first install, as `install.sh`'s own
 * environment variables.
 *
 * Env rather than argv is the whole point: the OAuth client secret and the CDN
 * credentials travel inside the script piped to the remote `bash -s`, where no
 * `ps` on the VPS can read them. Only the *stack shape* variables are
 * deliberately absent — this command installs the bundled database and bundled
 * storage, and naming `SELFHOST_DATABASE_MODE`/`SELFHOST_STORAGE_MODE` at all
 * would make a later `--repair-env` rerun fail its "does not change the
 * database or storage mode" guard.
 */
export function buildInstallEnv(
  answers: InstallAnswers,
): Record<string, string> {
  return {
    ACME_EMAIL: answers.adminEmail,
    CODEMAGIC_PATCH_API_DOMAIN: answers.apiDomain,
    CODEMAGIC_PATCH_STORAGE_DOMAIN: answers.storageDomain,
    GITHUB_OAUTH_CLIENT_ID: answers.githubClientId,
    GITHUB_OAUTH_CLIENT_SECRET: answers.githubClientSecret,
    ...buildDeliveryEnv(answers.delivery),
  };
}

function buildDeliveryEnv(delivery: DeliverySelection): Record<string, string> {
  switch (delivery.kind) {
    case "cloudflare":
      return {
        CLOUDFLARE_API_TOKEN: delivery.apiToken,
        CLOUDFLARE_ENABLED: "1",
        CLOUDFLARE_ZONE_ID: delivery.zoneId,
      };
    case "cloudfront":
      return {
        CLOUDFRONT_DISTRIBUTION_ID: delivery.distributionId,
        CLOUDFRONT_ENABLED: "1",
        ...(delivery.accessKeyId !== undefined
          ? { CLOUDFRONT_ACCESS_KEY_ID: delivery.accessKeyId }
          : {}),
        ...(delivery.secretAccessKey !== undefined
          ? { CLOUDFRONT_SECRET_ACCESS_KEY: delivery.secretAccessKey }
          : {}),
        ...(delivery.originVerifySecret !== undefined
          ? { CLOUDFRONT_ORIGIN_VERIFY_SECRET: delivery.originVerifySecret }
          : {}),
        ...(delivery.storageOriginDomain !== undefined
          ? {
              CODEMAGIC_PATCH_STORAGE_ORIGIN_DOMAIN:
                delivery.storageOriginDomain,
            }
          : {}),
      };
    case "none":
      return {};
  }
}

export type RepairValues = {
  adminEmail?: string;
  apiDomain?: string;
  cloudflareApiToken?: string;
  cloudflareZoneId?: string;
  cloudfrontAccessKeyId?: string;
  cloudfrontDistributionId?: string;
  cloudfrontSecretAccessKey?: string;
  githubClientId?: string;
  githubClientSecret?: string;
  storageDomain?: string;
  storageOriginDomain?: string;
};

/**
 * Exactly the keys the user supplied, and nothing else.
 *
 * `install.sh --repair-env` decides what to rewrite from which variables are
 * non-empty, so an unsupplied key must be *absent*, never an empty string:
 * both the generated secrets and an already-deployed origin-verify secret
 * survive precisely because they are never named. The delivery-adapter
 * switches (`CLOUDFLARE_ENABLED`/`CLOUDFRONT_ENABLED`) are never emitted here
 * either — repair refuses outright when it sees one, since changing the
 * adapter on an existing deployment is not a repair.
 */
export function buildRepairEnv(values: RepairValues): Record<string, string> {
  const mapping: ReadonlyArray<[keyof RepairValues, string]> = [
    ["adminEmail", "ACME_EMAIL"],
    ["apiDomain", "CODEMAGIC_PATCH_API_DOMAIN"],
    ["cloudflareApiToken", "CLOUDFLARE_API_TOKEN"],
    ["cloudflareZoneId", "CLOUDFLARE_ZONE_ID"],
    ["cloudfrontAccessKeyId", "CLOUDFRONT_ACCESS_KEY_ID"],
    ["cloudfrontDistributionId", "CLOUDFRONT_DISTRIBUTION_ID"],
    ["cloudfrontSecretAccessKey", "CLOUDFRONT_SECRET_ACCESS_KEY"],
    ["githubClientId", "GITHUB_OAUTH_CLIENT_ID"],
    ["githubClientSecret", "GITHUB_OAUTH_CLIENT_SECRET"],
    ["storageDomain", "CODEMAGIC_PATCH_STORAGE_DOMAIN"],
    ["storageOriginDomain", "CODEMAGIC_PATCH_STORAGE_ORIGIN_DOMAIN"],
  ];

  const env: Record<string, string> = {};
  for (const [key, name] of mapping) {
    const value = values[key];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
    }
  }

  return env;
}

/**
 * Mirrors `install.sh`'s own `validate_domain`, so a typo is caught while the
 * user is still looking at the field rather than after a pairing and a probe.
 * Returns the problem in the user's terms, or null when the value is fine.
 */
export function describeDomainProblem(value: string): string | null {
  const domain = value.trim();

  if (domain.length === 0) {
    return "A domain is required.";
  }

  if (domain.includes("://")) {
    return "Leave off the https:// — just the domain, like updates.example.com.";
  }

  if (domain.includes("/")) {
    return "Leave off the path — just the domain, like updates.example.com.";
  }

  if (/\s/u.test(domain)) {
    return "A domain cannot contain spaces.";
  }

  if (domain.startsWith(".") || domain.endsWith(".")) {
    return "A domain cannot start or end with a dot.";
  }

  if (!domain.includes(".")) {
    return "That needs to be a full domain, like updates.example.com.";
  }

  if (/[^A-Za-z0-9.-]/u.test(domain)) {
    return "A domain can only contain letters, digits, dots, and hyphens.";
  }

  return null;
}

/**
 * The default download domain, derived from the server domain.
 *
 * The zone apex decides the shape. On the apex itself the only option is a
 * subdomain: `example.com` → `storage.example.com`. But when the server domain
 * is already a subdomain, nesting another label under it
 * (`storage.updates.example.com`) sits two levels below the apex, which
 * Cloudflare's free Universal SSL wildcard (`*.example.com`) does not cover —
 * so the suggestion is the sibling with the leftmost label hyphen-prefixed:
 * `updates.example.com` → `storage-updates.example.com`, and
 * `a.b.example.com` → `storage-a.b.example.com`. The download domain stays
 * one level deep whenever the server domain does.
 *
 * The apex is an argument, never guessed from label counting — `minsik.kim`
 * is an apex with two labels and `example.co.uk` is one with three, and the
 * SOA walk in `findZoneApex` is what tells them apart. Getting it wrong in
 * the hyphen direction would fabricate a registrable domain the user does not
 * own (`example.com` → `storage-example.com`), so an unknown apex (`null` —
 * port 53 blocked, nothing answered) falls back to the dot form, which is
 * always a name under the user's own.
 */
export function deriveStorageDomain(
  apiDomain: string,
  zoneApex: string | null,
): string {
  const domain = apiDomain.toLowerCase();
  const apex = zoneApex?.toLowerCase() ?? null;
  const isSubdomainOfApex =
    apex !== null && domain !== apex && domain.endsWith(`.${apex}`);

  return isSubdomainOfApex ? `storage-${apiDomain}` : `storage.${apiDomain}`;
}

/** `install.sh`'s own default for the CloudFront-protected origin hostname. */
export function deriveStorageOriginDomain(storageDomain: string): string {
  return `origin-${storageDomain}`;
}

/**
 * Whether a failed probe connection still proves the port is reachable.
 *
 * Before anything is installed nothing listens on 80/443, so on a correctly
 * configured host the SYN comes back as an RST — `ECONNREFUSED` — which proves
 * the packet reached the host and nothing filtered it. Only a silent drop (the
 * timeout path) or a routing failure suggests a firewall.
 */
export function tcpProbeErrorMeansReachable(code: string | undefined): boolean {
  return code === "ECONNREFUSED";
}

/**
 * The default `TcpConnect`, wired at the call site, exactly like
 * `runProcessWithSpawn`: the probe is advisory, so a socket failure settles
 * the answer rather than throwing.
 */
export function connectTcp(input: {
  host: string;
  port: number;
  timeoutMilliseconds: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: input.host, port: input.port });
    const settle = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(input.timeoutMilliseconds);
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("timeout", () => {
      settle(false);
    });
    socket.once("error", (error) => {
      const code = (error as { code?: unknown } | null)?.code;
      settle(
        tcpProbeErrorMeansReachable(
          typeof code === "string" ? code : undefined,
        ),
      );
    });
  });
}
