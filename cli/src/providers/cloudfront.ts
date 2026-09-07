/**
 * The CloudFront half of the wizard, as pure functions.
 *
 * There is a hard boundary here, and it is deliberate: **no AWS credential
 * chain, no AWS CLI, no resource creation.** The wizard opens the published
 * guide and Console deep links, prints exact values, and takes back four
 * things the user copies. The only AWS credential that comes back is a key
 * scoped to `cloudfront:CreateInvalidation` on one distribution, and the only
 * real check on it is the synthetic invalidation `install.sh` already submits.
 */

import { randomBytes } from "node:crypto";

/** The header the origin Caddy site checks. Fixed by the deployment contract. */
export const ORIGIN_VERIFY_HEADER = "X-Codemagic-Patch-Origin-Verify";

/**
 * A path that cannot exist, for the bare-origin probe: the only correct
 * answer to it is a refusal, and asking for a real manifest would make the
 * check depend on a release having been published first.
 */
export const SYNTHETIC_PROBE_PATH = "/codemagic-patch/.cmpatch-origin-check";

/**
 * What the probes *through* CloudFront request: MinIO's public readiness
 * endpoint, proxied by the origin site. It is the one path whose status tells
 * a working distribution from a misconfigured one — with the right
 * origin-verify header CloudFront relays MinIO's 200; with a wrong or missing
 * header the origin Caddy answers 403, which CloudFront relays with `x-cache`
 * intact. The synthetic path cannot make that distinction: the bucket policy
 * grants anonymous `s3:GetObject` only, no `ListBucket`, so a GET of a
 * missing key is 403 AccessDenied even through a perfectly configured
 * distribution.
 */
export const DISTRIBUTION_PROBE_PATH = "/minio/health/ready";

export const CONSOLE_URLS = {
  acmRequest:
    "https://us-east-1.console.aws.amazon.com/acm/home?region=us-east-1#/certificates/request",
  distributionCreate:
    "https://console.aws.amazon.com/cloudfront/v4/home#/distributions/create",
  iamPolicyCreate:
    "https://console.aws.amazon.com/iam/home#/policies/create",
} as const;

/** 32 bytes of hex, matching what the guide's `openssl rand -hex 32` produces. */
export function generateOriginVerifySecret(
  random: (size: number) => Buffer = randomBytes,
): string {
  return random(32).toString("hex");
}

/** The scoped purge policy, ready to paste into the IAM console. */
export function buildPurgePolicy(distributionArn: string): string {
  return JSON.stringify(
    {
      Statement: [
        {
          Action: "cloudfront:CreateInvalidation",
          Effect: "Allow",
          Resource: distributionArn,
        },
      ],
      Version: "2012-10-17",
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Shape checks
//
// Shape only, everywhere. The real check on the distribution id and the key
// pair is install.sh's synthetic CreateInvalidation, which is why a value that
// merely *looks* wrong is worth catching here and a value that looks right is
// never claimed to be verified.
// ---------------------------------------------------------------------------

export function checkDistributionId(value: string): string | null {
  return /^E[A-Z0-9]{9,}$/u.test(value)
    ? null
    : 'That does not look like a distribution ID. It starts with a capital E and is shown as "ID" on the distribution\'s page, for example E1A2B3C4D5E6F7.';
}

export function checkDistributionDomain(value: string): string | null {
  return /^[a-z0-9]+\.cloudfront\.net$/u.test(value)
    ? null
    : 'That does not look like a distribution domain. It ends in .cloudfront.net and is shown as "Distribution domain name", for example d111111abcdef8.cloudfront.net.';
}

/**
 * The one wrong access key ID that looks entirely right.
 *
 * AWS gives out exactly two kinds of access key ID: `AKIA` for a permanent IAM
 * user key, and `ASIA` for a temporary one minted by STS — which is what AWS
 * SSO, an assumed role, and the CloudShell environment all hand you, and so
 * what a user who never made an IAM user copies. A temporary key is only valid
 * alongside the session token issued with it, and nothing in this deployment
 * carries one: not the wizard, not `install.sh`, not the compose environment,
 * not the delivery adapter. Accepting it here bought a `SignatureDoesNotMatch`
 * from the install's own `verify_cloudfront` — after the ~20-minute build,
 * which is precisely the late failure these shape checks exist to preempt.
 *
 * So it is refused by name rather than by shape: a bare "that does not look
 * like an access key ID" over a value that is a real, correctly-shaped,
 * currently-valid AWS key would read as a bug in the wizard, and leave the
 * user re-pasting the same credential.
 *
 * Every other prefix (`AIDA`, `AROA`, `AGPA`, … — unique ids for users, roles
 * and groups, not credentials) falls through to the shape complaint, which is
 * all they are: not an access key ID at all.
 */
export function checkAccessKeyId(value: string): string | null {
  if (/^ASIA[A-Z0-9]{16}$/u.test(value)) {
    return "That is a temporary access key. Keys that start with ASIA come from AWS SSO, an assumed role, or CloudShell, and they work only alongside a session token that expires within hours — nothing here can carry one, so the install's own CloudFront check fails after the build. Use a permanent key from the scoped IAM user with the cache-clearing policy — the CloudFront walkthrough's IAM step walks you through creating it. That key starts with AKIA.";
  }

  return /^AKIA[A-Z0-9]{16}$/u.test(value)
    ? null
    : "That does not look like an access key ID. It starts with AKIA and is 20 characters long, all capitals and digits — for example AKIAIOSFODNN7EXAMPLE.";
}

export function checkSecretAccessKey(value: string): string | null {
  return value.length >= 30 && !/\s/u.test(value)
    ? null
    : "That does not look like a secret access key. It is the long value shown once when the key is created.";
}

/**
 * A header value read back out of a distribution that already exists.
 *
 * The bar is `install.sh`'s, not the generator's. Both generators emit 64 hex
 * characters (here, and `random_selfhost_secret` on the direct-script path),
 * but the docs tell manual operators to use *any* random secret, and the ones
 * people reach for are base64 — `+`, `/`, and `=` included. A check written
 * around the generator's alphabet would refuse a value that is deployed and
 * working, with no way past it: the question would be asked again on every
 * rerun, and the only alternative offered would be the regeneration this
 * exists to prevent. So the rule is exactly what the env file can carry —
 * printable ASCII, no whitespace, and no single quote (the value is stored
 * single-quoted in `.env.selfhost`, which cannot escape one) — with length
 * bounds loose enough for any real secret and tight enough to catch a paste
 * of the wrong thing entirely.
 */
export function checkOriginVerifySecret(value: string): string | null {
  const printable = /^[!-~]+$/u.test(value);
  return printable &&
    !value.includes("'") &&
    value.length >= 12 &&
    value.length <= 512
    ? null
    : "That does not look like the header value. It is the long random-looking value beside the custom header on the distribution's origin: at least 12 characters, no spaces, and no single quotes.";
}

// ---------------------------------------------------------------------------
// The pre-cutover probes
// ---------------------------------------------------------------------------

export type DistributionProbe =
  /**
   * CloudFront answered a healthy 2xx — `x-cache` proves who is answering,
   * and the status proves the origin accepted the request. Both are needed:
   * an origin refusal travels through CloudFront with `x-cache` intact, so
   * the header alone reads a fully broken setup as a working one.
   */
  | { kind: "served"; cacheStatus: string }
  /**
   * CloudFront relayed the origin's 403 — the answer the origin Caddy gives
   * every request whose origin-verify header is wrong or missing, and the
   * answer CloudFront itself gives for a mistyped distribution domain (any
   * `*.cloudfront.net` name resolves). Cut over onto this and every download
   * gets the same 403.
   */
  | { kind: "origin-header-rejected" }
  /**
   * CloudFront answered, but the readiness check behind it failed with
   * something other than 403 — the origin is unreachable from CloudFront or
   * MinIO itself is not ready. Not a working CDN either way.
   */
  | { kind: "unhealthy"; status: number }
  /**
   * An answer with no `x-cache`. Either the hostname is not a distribution or
   * something in between is answering; either way the viewer record must not
   * be moved onto it.
   */
  | { kind: "not-cloudfront" }
  | { kind: "unreachable"; reason: string };

export function classifyDistributionProbe(input: {
  headers: { get: (name: string) => string | null };
  status: number;
}): DistributionProbe {
  const cacheStatus = input.headers.get("x-cache");
  if (cacheStatus === null || cacheStatus.length === 0) {
    return { kind: "not-cloudfront" };
  }

  if (input.status >= 200 && input.status < 300) {
    return { cacheStatus, kind: "served" };
  }

  return input.status === 403
    ? { kind: "origin-header-rejected" }
    : { kind: "unhealthy", status: input.status };
}

/**
 * Why a probe request never produced a response.
 *
 * `certificate-name` is singled out because it is the one failure that never
 * clears on its own: the viewer hostname resolves to CloudFront, CloudFront
 * answers the handshake with its own `*.cloudfront.net` certificate, and the
 * distribution will keep doing that until an alternate domain name and a
 * matching certificate are attached to it. Treated as "not spread yet", it
 * looks identical to a slow DNS change for as long as the caller cares to
 * wait — while downloads over that name are already failing.
 */
export type RequestFailure = "certificate-name" | "unreachable";

export function classifyRequestFailure(error: unknown): RequestFailure {
  // Node reports it on the cause of the TypeError fetch throws, never on the
  // TypeError itself.
  const cause: unknown = error instanceof Error ? error.cause : null;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code: unknown }).code
      : null;

  return code === "ERR_TLS_CERT_ALTNAME_INVALID"
    ? "certificate-name"
    : "unreachable";
}

export type OriginProbe =
  /** Exactly 403: the origin refuses anyone without the verification header. */
  | { kind: "protected" }
  /**
   * The origin answered a request that carried no verification header. The
   * custom header is not configured, or is configured with a different value,
   * and moving the viewer record now would leave storage open to anyone who
   * knows the origin hostname.
   */
  | { kind: "unprotected"; status: number }
  | { kind: "unreachable"; reason: string };

export function classifyOriginProbe(input: { status: number }): OriginProbe {
  return input.status === 403
    ? { kind: "protected" }
    : { kind: "unprotected", status: input.status };
}

// ---------------------------------------------------------------------------
// The ACM validation record
// ---------------------------------------------------------------------------

/**
 * ACM shows the validation record as a fully-qualified name, and most DNS
 * consoles append the zone to whatever is typed — so pasting it verbatim
 * produces `_x.storage.example.com.example.com`. That mistake is invisible in
 * the console and stalls the certificate in "Pending validation" indefinitely,
 * so the wizard queries the doubled name as well and says which one it found.
 */
export function doubledValidationName(
  name: string,
  zone: string | null,
): string | null {
  if (zone === null || !name.endsWith(`.${zone}`)) {
    return null;
  }

  return `${name}.${zone}`;
}
