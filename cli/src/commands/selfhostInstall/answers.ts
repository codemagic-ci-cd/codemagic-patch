/**
 * Answers, from flags and the environment.
 *
 * The non-interactive half of the wizard: what a flags-only run reads, what it
 * refuses to run without, and the mirror of each of those the interactive path
 * consults before it decides to ask.
 */

import { SELFHOST_DOCS_URL } from "../../branding";
import { checkAccessKeyId } from "../../providers/cloudfront";
import { findZoneApex } from "../../selfhostDns";
import {
  buildRepairEnv,
  deriveStorageDomain,
  type DeliverySelection,
  type RepairValues,
} from "../../selfhostInstall";
import {
  readBooleanFlag,
  readStringFlag,
  type ParsedArgs,
} from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";

/**
 * One answer a run was handed without being asked, and which of the two ways it
 * arrived.
 *
 * The flag wins over the variable, as it does everywhere in this command. The
 * value is returned exactly as it was given — an empty one included — because
 * what an empty answer means is the call site's to decide: a missing secret is
 * "not supplied", while an empty `--cloudflare-api-token` is still a token this
 * run must not re-ask for.
 *
 * `origin` exists so the sites that used to re-derive it — to name the flag or
 * the variable in an error, or to decide whether a value can be asked for again
 * — read it off the same lookup instead.
 */
export function supplied(
  deps: CommandDeps,
  parsed: ParsedArgs,
  source: { env?: string; flag: string },
): { origin: "env" | "flag"; value: string } | undefined {
  const flagged = readStringFlag(parsed, source.flag);
  if (flagged !== undefined) {
    return { origin: "flag", value: flagged };
  }

  const fromEnvironment =
    source.env === undefined ? undefined : deps.env[source.env];
  return fromEnvironment === undefined
    ? undefined
    : { origin: "env", value: fromEnvironment };
}

/**
 * Whether the flags alone can answer the delivery question — the mirror of
 * what `readDelivery` would otherwise throw a UsageError demanding.
 */
export function deliveryFlagsComplete(
  deps: CommandDeps,
  parsed: ParsedArgs,
  flagged: "cloudflare" | "cloudfront",
): boolean {
  if (flagged === "cloudflare") {
    const apiToken = supplied(deps, parsed, {
      env: "CLOUDFLARE_API_TOKEN",
      flag: "--cloudflare-api-token",
    })?.value;
    return (
      apiToken !== undefined &&
      apiToken.length > 0 &&
      readStringFlag(parsed, "--cloudflare-zone-id") !== undefined
    );
  }

  return readStringFlag(parsed, "--cloudfront-distribution-id") !== undefined;
}

// ---------------------------------------------------------------------------
// Answers, from flags and the environment
// ---------------------------------------------------------------------------

export async function readInstallAnswers(deps: CommandDeps, parsed: ParsedArgs) {
  // Asked in the order the wizard will ask them, so a flags-only run is told
  // about the first thing it is missing rather than an arbitrary one.
  const apiDomain = required(parsed, "--api-domain", "the server's domain");
  const adminEmail = required(parsed, "--email", "the admin's email address");
  const githubClientId = required(
    parsed,
    "--github-oauth-client-id",
    "the GitHub OAuth app's client ID",
  );
  const githubClientSecret = supplied(deps, parsed, {
    env: "GITHUB_OAUTH_CLIENT_SECRET",
    flag: "--github-oauth-client-secret",
  })?.value;

  if (githubClientSecret === undefined || githubClientSecret.length === 0) {
    throw missingAnswer(
      "--github-oauth-client-secret",
      "the GitHub OAuth app's client secret",
      "GITHUB_OAUTH_CLIENT_SECRET",
    );
  }

  return {
    adminEmail,
    apiDomain,
    delivery: readDelivery(deps, parsed),
    githubClientId,
    githubClientSecret,
    storageDomain:
      readStringFlag(parsed, "--storage-domain") ??
      (await suggestStorageDomain(deps, apiDomain)),
  };
}

/**
 * The download-domain default, with the zone apex resolved first.
 *
 * `deriveStorageDomain` needs to know whether the server domain IS the apex
 * (suggest `storage.` under it) or sits below one (suggest the hyphenated
 * sibling — see its comment for why nesting breaks Cloudflare's Universal SSL
 * wildcard). The SOA walk is the same one the DNS step runs later, just moved
 * before the download-domain prompt; when it cannot answer (port 53 blocked),
 * `findZoneApex` returns null and the derivation falls back to the dot form,
 * the direction that can never fabricate a domain the user does not own.
 */
export async function suggestStorageDomain(
  deps: CommandDeps,
  apiDomain: string,
): Promise<string> {
  return deriveStorageDomain(
    apiDomain,
    await findZoneApex(apiDomain, deps.dnsClient),
  );
}

export function readDelivery(
  deps: CommandDeps,
  parsed: ParsedArgs,
): DeliverySelection {
  if (readBooleanFlag(parsed, "--cloudflare")) {
    const apiToken = supplied(deps, parsed, {
      env: "CLOUDFLARE_API_TOKEN",
      flag: "--cloudflare-api-token",
    })?.value;
    if (apiToken === undefined || apiToken.length === 0) {
      throw missingAnswer(
        "--cloudflare-api-token",
        "the Cloudflare API token",
        "CLOUDFLARE_API_TOKEN",
      );
    }

    return {
      apiToken,
      kind: "cloudflare",
      zoneId: required(parsed, "--cloudflare-zone-id", "the Cloudflare zone id"),
    };
  }

  if (readBooleanFlag(parsed, "--cloudfront")) {
    const secretAccessKey = supplied(deps, parsed, {
      env: "CLOUDFRONT_SECRET_ACCESS_KEY",
      flag: "--cloudfront-secret-access-key",
    })?.value;
    const accessKeyId = suppliedAccessKeyId(deps, parsed);

    return {
      distributionId: required(
        parsed,
        "--cloudfront-distribution-id",
        "the CloudFront distribution id",
      ),
      kind: "cloudfront",
      // Both or neither: half a pair is a hard failure in install.sh, and
      // omitting both is the documented way to use an instance role.
      ...(accessKeyId !== undefined && secretAccessKey !== undefined
        ? { accessKeyId, secretAccessKey }
        : {}),
      ...(readStringFlag(parsed, "--cloudfront-origin-verify-secret") !==
      undefined
        ? {
            originVerifySecret: readStringFlag(
              parsed,
              "--cloudfront-origin-verify-secret",
            ),
          }
        : {}),
      ...(readStringFlag(parsed, "--storage-origin-domain") !== undefined
        ? {
            storageOriginDomain: readStringFlag(
              parsed,
              "--storage-origin-domain",
            ),
          }
        : {}),
    } as DeliverySelection;
  }

  return { kind: "none" };
}

export function readRepairValues(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Record<string, string> {
  const values: RepairValues = {
    ...optional(parsed, "--api-domain", "apiDomain"),
    ...optional(parsed, "--email", "adminEmail"),
    ...optional(parsed, "--github-oauth-client-id", "githubClientId"),
    ...optional(parsed, "--cloudflare-zone-id", "cloudflareZoneId"),
    ...optional(
      parsed,
      "--cloudfront-distribution-id",
      "cloudfrontDistributionId",
    ),
    ...optional(parsed, "--storage-domain", "storageDomain"),
    ...optional(parsed, "--storage-origin-domain", "storageOriginDomain"),
    ...secret(
      deps,
      parsed,
      "--github-oauth-client-secret",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "githubClientSecret",
    ),
    ...secret(
      deps,
      parsed,
      "--cloudflare-api-token",
      "CLOUDFLARE_API_TOKEN",
      "cloudflareApiToken",
    ),
    ...repairAccessKeyId(deps, parsed),
    ...secret(
      deps,
      parsed,
      "--cloudfront-secret-access-key",
      "CLOUDFRONT_SECRET_ACCESS_KEY",
      "cloudfrontSecretAccessKey",
    ),
  };

  const env = buildRepairEnv(values);
  if (Object.keys(env).length === 0) {
    throw new UsageError(
      [
        "--repair needs the values to correct.",
        "",
        "Pass the ones that were wrong, for example:",
        "  cmpatch selfhost install --repair --api-domain updates.example.com",
      ].join("\n"),
    );
  }

  return env;
}

function optional(
  parsed: ParsedArgs,
  flag: string,
  key: keyof RepairValues,
): Partial<RepairValues> {
  const value = readStringFlag(parsed, flag);
  return value === undefined ? {} : { [key]: value };
}

function secret(
  deps: CommandDeps,
  parsed: ParsedArgs,
  flag: string,
  variable: string,
  key: keyof RepairValues,
): Partial<RepairValues> {
  const value = supplied(deps, parsed, { env: variable, flag })?.value;
  return value === undefined || value.length === 0 ? {} : { [key]: value };
}

const ACCESS_KEY_ID_FLAG = "--cloudfront-access-key-id";
const ACCESS_KEY_ID_VARIABLE = "CLOUDFRONT_ACCESS_KEY_ID";

/**
 * The access key ID supplied without a prompt, held to the same check the
 * typed answer gets.
 *
 * The shape checks exist to catch a wrong CloudFront value before the
 * ~20-minute build, and every one of them used to be skipped by exactly the
 * runs that cannot recover interactively: a scripted or CI install passing
 * `--cloudfront-access-key-id`, and a shell exporting
 * `CLOUDFRONT_ACCESS_KEY_ID` from an SSO session — which hands out precisely
 * the temporary `ASIA` key nothing in this deployment can use. Those runs got
 * no diagnosis at all, only `verify_cloudfront` failing at the end.
 *
 * It stays a rejection rather than a warning, and rather than a fallback to
 * the prompt: a non-interactive run has no prompt to fall back to, and the
 * escape for a legitimate-but-unusual key is to correct the value that was
 * passed — which is why the error names the flag or the variable it came from.
 */
export function suppliedAccessKeyId(
  deps: CommandDeps,
  parsed: ParsedArgs,
): string | undefined {
  const source = supplied(deps, parsed, {
    env: ACCESS_KEY_ID_VARIABLE,
    flag: ACCESS_KEY_ID_FLAG,
  });
  if (source === undefined || source.value.length === 0) {
    return undefined;
  }

  const problem = checkAccessKeyId(source.value);
  if (problem !== null) {
    throw new UsageError(
      [
        problem,
        "",
        source.origin === "env"
          ? `Correct ${ACCESS_KEY_ID_VARIABLE} in the environment and run the command again.`
          : `Correct the value passed as ${ACCESS_KEY_ID_FLAG} and run the command again.`,
      ].join("\n"),
    );
  }

  return source.value;
}

function repairAccessKeyId(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Partial<RepairValues> {
  const value = suppliedAccessKeyId(deps, parsed);
  return value === undefined ? {} : { cloudfrontAccessKeyId: value };
}

function required(parsed: ParsedArgs, flag: string, what: string): string {
  const value = readStringFlag(parsed, flag);
  if (value === undefined || value.length === 0) {
    throw missingAnswer(flag, what);
  }

  return value;
}

function missingAnswer(
  flag: string,
  what: string,
  variable?: string,
): UsageError {
  return new UsageError(
    [
      `${what} is required: pass ${flag}${variable === undefined ? "" : ` (or set ${variable})`}.`,
      "",
      `See ${SELFHOST_DOCS_URL} for what each value is.`,
    ].join("\n"),
  );
}
