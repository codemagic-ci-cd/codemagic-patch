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
  checkOAuthCredential,
  deriveStorageDomain,
  describeDomainProblem,
  listOAuthProviders,
  OAUTH_PROVIDERS,
  type InstallAnswers,
  type OAuthCredentials,
  type OAuthExtraRepair,
  type OAuthProvider,
  type DeliverySelection,
  type RepairScope,
  type RepairValues,
} from "../../selfhostInstall";
import {
  readBooleanFlag,
  readStringFlag,
  type FlagShape,
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
      supplied(deps, parsed, { flag: "--cloudflare-zone-id", env: "CLOUDFLARE_ZONE_ID" })?.value !== undefined
    );
  }

  return supplied(deps, parsed, { flag: "--cloudfront-distribution-id", env: "CLOUDFRONT_DISTRIBUTION_ID" })?.value !== undefined;
}

// ---------------------------------------------------------------------------
// Answers, from flags and the environment
// ---------------------------------------------------------------------------

export async function readInstallAnswers(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<InstallAnswers> {
  // Asked in the order the wizard will ask them, so a flags-only run is told
  // about the first thing it is missing rather than an arbitrary one.
  const apiDomain = required(parsed, "--api-domain", "the server's domain");
  const apiProblem = describeDomainProblem(apiDomain);
  if (apiProblem) throw new UsageError(apiProblem);
  const adminEmail = required(parsed, "--email", "the admin's email address");
  const oauth = readOAuthCredentials(deps, parsed, suppliedOAuthProvider(deps, parsed) ?? "github");

  const external = Boolean(
    readStringFlag(parsed, "--storage-mode") &&
    readStringFlag(parsed, "--storage-mode") !== "bundled",
  );
  const storageDomain = external
    ? ""
    : (readStringFlag(parsed, "--storage-domain") ??
      (await suggestStorageDomain(deps, apiDomain)));
  if (!external) {
    const problem = describeDomainProblem(storageDomain);
    if (problem) throw new UsageError(problem);
    if (storageDomain.toLowerCase() === apiDomain.toLowerCase())
      throw new UsageError("The API and download hostnames must differ.");
  }
  return {
    adminEmail,
    apiDomain,
    delivery: external ? { kind: "none" } : readDelivery(deps, parsed),
    oauth,
    storageDomain,
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
      zoneId: requiredSource(deps, parsed, "--cloudflare-zone-id", "CLOUDFLARE_ZONE_ID", "the Cloudflare zone id"),
    };
  }

  if (readBooleanFlag(parsed, "--cloudfront")) {
    const secretAccessKey = supplied(deps, parsed, {
      env: "CLOUDFRONT_SECRET_ACCESS_KEY",
      flag: "--cloudfront-secret-access-key",
    })?.value;
    const accessKeyId = suppliedAccessKeyId(deps, parsed);
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
      throw new UsageError("Supply both CloudFront runtime access key ID and secret access key, or omit both to use an instance role.");

    return {
      distributionId: requiredSource(
        deps, parsed, "--cloudfront-distribution-id", "CLOUDFRONT_DISTRIBUTION_ID", "the CloudFront distribution id",
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

export function readNonOAuthRepairValues(
  deps: CommandDeps,
  parsed: ParsedArgs,
  scope: RepairScope = "all",
): RepairValues {
  const values: RepairValues = {
    ...optional(parsed, "--api-domain", "apiDomain"),
    ...optional(parsed, "--email", "adminEmail"),
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

  // A healthy server takes only the OAuth values, so a stray domain or CDN
  // value here would rewrite a working deployment under the name of a
  // credential fix.
  if (scope === "oauth-only" && Object.keys(buildRepairEnv(values)).length > 0) {
    throw new UsageError(
      "This --repair corrects only the OAuth app credentials: pass the provider's client ID and secret (for example --gitlab-oauth-client-id and --gitlab-oauth-client-secret) and drop the other values.",
    );
  }
  return values;
}

export function readRepairValues(
  deps: CommandDeps,
  parsed: ParsedArgs,
  scope: RepairScope = "all",
): Record<string, string> {
  const values = readNonOAuthRepairValues(deps, parsed, scope);
  const provider = suppliedOAuthProvider(deps, parsed);
  if (provider) values.oauth = readOAuthRepair(deps, parsed, provider);
  const env = buildRepairEnv(values);
  if (Object.keys(env).length === 0) {
    throw new UsageError(
      [
        "--repair needs the values to correct.",
        "",
        "Pass the ones that were wrong, for example:",
        scope === "oauth-only"
          ? "  cmpatch selfhost install --repair --oauth-provider gitlab --gitlab-oauth-client-id <id> --gitlab-oauth-client-secret <secret>"
          : "  cmpatch selfhost install --repair --api-domain updates.example.com",
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

function requiredSource(deps: CommandDeps, parsed: ParsedArgs, flag: string, env: string, what: string): string {
  const value = supplied(deps, parsed, { flag, env })?.value;
  if (!value) throw missingAnswer(flag, what, env);
  return value;
}

const OAUTH_PROVIDER_NAMES = Object.keys(OAUTH_PROVIDERS) as OAuthProvider[];

export function suppliedOAuthProvider(deps: CommandDeps, parsed: ParsedArgs): OAuthProvider | undefined {
  const explicit = readStringFlag(parsed, "--oauth-provider");
  if (explicit !== undefined && !Object.hasOwn(OAUTH_PROVIDERS, explicit)) {
    throw new UsageError(`--oauth-provider must be ${listOAuthProviders((provider) => provider)}.`);
  }
  // Named by source, because a stale variable in the shell is the usual way
  // two providers turn up at once, and it is invisible in the command line.
  const found = OAUTH_PROVIDER_NAMES
    .map((provider) => ({ provider, sources: oauthSources(deps, parsed, provider) }))
    .filter(({ sources }) => sources.length > 0);
  const stray = found.filter(({ provider }) => explicit !== undefined && provider !== explicit);
  if (found.length > 1 || stray.length > 0) {
    const named = (explicit === undefined ? found : stray).flatMap(({ sources }) => sources).join(", ");
    throw new UsageError(
      explicit === undefined
        ? `OAuth credentials were supplied for more than one provider: ${named}. Choose one provider per installation or repair; unset the stray variable or drop the flag.`
        : `--oauth-provider ${explicit} does not match ${named}. Pass only that provider's credentials, or unset the stray variable.`,
    );
  }
  return (explicit as OAuthProvider | undefined) ?? found[0]?.provider;
}

const CLIENT_ID_FIELD = { flag: "client-id", env: "CLIENT_ID" };
const CLIENT_SECRET_FIELD = { flag: "client-secret", env: "CLIENT_SECRET" };

/** The flag and the variable that carry one of a provider's values. */
function oauthSource(provider: OAuthProvider, field: { flag: string; env: string }): { flag: string; env: string } {
  const { flagPrefix, envPrefix } = OAUTH_PROVIDERS[provider];
  return { flag: `--${flagPrefix}-oauth-${field.flag}`, env: `${envPrefix}_OAUTH_${field.env}` };
}

/** The provider choice plus every provider's own flags. */
export const OAUTH_FLAGS: FlagShape = {
  "--oauth-provider": "value",
  ...Object.fromEntries(OAUTH_PROVIDER_NAMES.flatMap((provider) =>
    [CLIENT_ID_FIELD, CLIENT_SECRET_FIELD, ...OAUTH_PROVIDERS[provider].extraFields]
      .map((field) => [oauthSource(provider, field).flag, "value"]))),
};

/** Where each of a provider's values came from, as the user would name it. */
function oauthSources(deps: CommandDeps, parsed: ParsedArgs, provider: OAuthProvider): string[] {
  const fields = [CLIENT_ID_FIELD, CLIENT_SECRET_FIELD, ...OAUTH_PROVIDERS[provider].extraFields];
  return fields.flatMap((field) => {
    const { flag, env } = oauthSource(provider, field);
    const source = supplied(deps, parsed, { flag, env });
    if (source === undefined || source.value.length === 0) return [];
    return [source.origin === "flag" ? flag : `${env} (environment)`];
  });
}

export function suppliedOAuthCredentials(deps: CommandDeps, parsed: ParsedArgs, provider: OAuthProvider) {
  const extra: Record<string, string> = {};
  for (const field of OAUTH_PROVIDERS[provider].extraFields) {
    const value = supplied(deps, parsed, oauthSource(provider, field))?.value;
    if (value !== undefined && value.length > 0) extra[field.flag] = value;
  }
  return {
    clientId: supplied(deps, parsed, oauthSource(provider, CLIENT_ID_FIELD))?.value,
    clientSecret: supplied(deps, parsed, oauthSource(provider, CLIENT_SECRET_FIELD))?.value,
    extra,
  };
}

/** The shape check both paths run on whatever part of the credentials was supplied. */
export function checkSuppliedOAuthCredentials(
  provider: OAuthProvider,
  pair: { clientId?: string; clientSecret?: string; extra?: Record<string, string> },
): void {
  for (const [field, value] of [[CLIENT_ID_FIELD, pair.clientId], [CLIENT_SECRET_FIELD, pair.clientSecret]] as const) {
    const problem = value ? checkOAuthCredential(value) : null;
    if (problem) throw new UsageError(`${oauthSource(provider, field).flag}: ${problem}`);
  }
  for (const field of OAUTH_PROVIDERS[provider].extraFields) {
    const value = pair.extra?.[field.flag];
    const problem = value === undefined ? null : field.check(value);
    if (problem) throw new UsageError(`${oauthSource(provider, field).flag}: ${problem}`);
  }
}

/**
 * The repair's OAuth values: the pair, or the provider's extra fields on
 * their own (the GitLab origin) when that is all that was supplied. Half a
 * pair is still refused.
 */
export function readOAuthRepair(deps: CommandDeps, parsed: ParsedArgs, provider: OAuthProvider): OAuthCredentials | OAuthExtraRepair {
  const pair = suppliedOAuthCredentials(deps, parsed, provider);
  if (Object.keys(pair.extra).length > 0 && !pair.clientId && !pair.clientSecret) {
    checkSuppliedOAuthCredentials(provider, pair);
    return { provider, extra: pair.extra };
  }
  return readOAuthCredentials(deps, parsed, provider);
}

export function readOAuthCredentials(deps: CommandDeps, parsed: ParsedArgs, provider: OAuthProvider): OAuthCredentials {
  const { displayName } = OAUTH_PROVIDERS[provider];
  const clientId = oauthSource(provider, CLIENT_ID_FIELD);
  const clientSecret = oauthSource(provider, CLIENT_SECRET_FIELD);
  const { extra } = suppliedOAuthCredentials(deps, parsed, provider);
  const credentials = {
    provider,
    clientId: requiredSource(deps, parsed, clientId.flag, clientId.env, `the ${displayName} OAuth client ID`),
    clientSecret: requiredSource(deps, parsed, clientSecret.flag, clientSecret.env, `the ${displayName} OAuth client secret`),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  checkSuppliedOAuthCredentials(provider, credentials);
  return credentials;
}
