/**
 * `cmpatch selfhost install --fly` (wiki/discussions/fly-setup-wizard.md).
 * Secrets ride on `fly secrets import` stdin, never on an argv, in fly.toml or
 * in a notice.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCliConfig, type SelfhostFlyMapping } from "../configStore";
import {
  checkDatabaseUrl,
  checkFlyRegion,
  companyStem,
  databaseFlyToml,
  isFlyAppName,
  tigrisLoginKind,
  tigrisProviderLabel,
  TIGRIS_ENDPOINT,
  flycastDatabaseUrl,
  flyNames,
  type FlyNames,
  formatSecrets,
  parseAccessKeyExport,
  flyStorageListHas,
  isStorageNameTaken,
  parseFlyAppConfig,
  patchFlyToml,
  publicBaseUrl,
} from "../flySetup";
import { onInterruptCleanup } from "../progress";
import { awsRequest, s3ObjectUrl } from "../providers/aws";
import { buildOAuthEnv, type OAuthCredentials } from "../selfhostInstall";
import { selfhostMappingKey, withSelfhostMapping } from "../selfhostTarget";
import {
  capture,
  cloneServerTag,
  createFlyContext,
  ensureTool,
  errorMessage,
  flyLoginFirst,
  flyProgress,
  flyServerUrl,
  latestServerTag,
  listRemoteTags,
  readFlyOrg,
  redactSecrets,
  resolveFlyOrgSlug,
  run,
  runInteractive,
  signedIn,
  waitUntilReady,
  type Billing,
  type FlyContext,
} from "./flyProcess";
import {
  canAsk,
  parseArgs,
  readBooleanFlag,
  readStringFlag,
  type FlagShape,
  type ParsedArgs,
} from "./selfhostSession";
import {
  OAUTH_FLAGS,
  readOAuthCredentials,
  suppliedOAuthProvider,
} from "./selfhostInstall/answers";
import {
  askChecked,
  askSelect,
  holdUntilConfirmed,
  notice,
  offerBrowserOpen,
  paletteFor,
} from "./selfhostInstall/ask";
import {
  describeConfiguredProvider,
  renderSignInSteps,
  saveConfig,
  shouldAdoptServerUrl,
} from "./selfhostInstall";
import { askAdminEmail, checkAdminEmail, collectOAuth } from "./selfhostInstall/wizard";
import { UsageError, type CommandDeps } from "./shared";

const REGIONS = [
  { code: "iad", title: "Ashburn, Virginia" },
  { code: "lhr", title: "London, United Kingdom" },
  { code: "ams", title: "Amsterdam, Netherlands" },
  { code: "fra", title: "Frankfurt, Germany" },
  { code: "sjc", title: "San Jose, California" },
  { code: "syd", title: "Sydney, Australia" },
  { code: "nrt", title: "Tokyo, Japan" },
] as const;

/**
 * What this run has left on Fly and on disk so far, kept current as each one
 * is made: on Ctrl-C the catch that names them is never reached, so the
 * interrupt hook reads them from here. Each directory carries the line that
 * says what is in it.
 */
type Leftovers = { directories: Array<{ path: string; text: string }>; resources: string[] };

class RenameCompany extends Error {
  constructor(readonly stem: string, readonly leftover?: string) {
    super("Choose another company");
  }
}

const FLAGS = {
  "--company": "value",
  "--create-database": "boolean",
  "--database-app": "value",
  "--database-url": "value",
  "--email": "value",
  "--external-database": "boolean",
  "--fly": "boolean",
  "--fly-org": "value",
  "--fly-region": "value",
  "--install-flyctl": "boolean",
  "--install-tigris": "boolean",
  "--non-interactive": "boolean",
  "--register": "boolean",
  ...OAUTH_FLAGS,
} as const satisfies FlagShape;

const RERUN = "cmpatch selfhost install --fly";

const TIGRIS_LOGOUT_URL = "https://auth.storage.tigrisdata.io/v2/logout";
const UNUSABLE_COMPANY = "That name does not make a usable hostname. Use letters and numbers, and keep it short enough that the name plus -patch-internal fits in 63 characters.";

export async function runFlyInstall(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, FLAGS);
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      "cmpatch selfhost install --fly does not take a host. It talks to Fly from this machine.",
    );
  }

  if (readBooleanFlag(parsed, "--register")) {
    return registerFlyInstall(deps, parsed);
  }
  if (
    readStringFlag(parsed, "--database-app") !== undefined ||
    readBooleanFlag(parsed, "--external-database")
  ) {
    throw new UsageError(
      "--database-app and --external-database go with --register. An install records the database it creates by itself.",
    );
  }

  const interactive = canAsk(deps, parsed);
  const fly = createFlyContext(deps, RERUN);
  await ensureTool(fly, { installAllowed: readBooleanFlag(parsed, "--install-flyctl"), interactive }, "fly");
  await ensureTool(fly, { installAllowed: readBooleanFlag(parsed, "--install-tigris"), interactive }, "tigris");
  await ensureFlyAccount(fly, interactive);
  const org = await resolveFlyOrgSlug(fly, interactive, readStringFlag(parsed, "--fly-org"));
  await ensureFlyCard(fly, interactive, org);

  let stem = await askCompany(deps, parsed, interactive);
  const region = await askRegion(deps, parsed, interactive);
  const database = await askDatabase(deps, parsed, interactive);
  const preset = interactive ? undefined : await readSignIn(deps, parsed, false, stem);

  const left: Leftovers = { directories: [], resources: [] };
  fly.progress = flyProgress(deps, RERUN);
  // Deletes nothing, like the failure path: it only says what is still there.
  const removeInterruptHook = onInterruptCleanup(async () => {
    notice(deps, interruptedText(left));
  });

  try {
    let storage: Storage | undefined;
    for (;;) {
      const names = flyNames(stem);
      notice(deps, [
        `Fly app and public bucket: ${names.app}`,
        `Private bucket: ${names.privateBucket}`,
        ...(database.kind === "create" ? [`Database app: ${names.databaseApp}`] : []),
      ]);
      try {
        storage = await createBuckets(fly, stem, org, interactive, left);
        break;
      } catch (error) {
        if (!(error instanceof RenameCompany)) {
          throw error;
        }
        stem = error.stem;
        fly.progress.settle();
        if (error.leftover !== undefined) {
          notice(deps, `${error.leftover} was created. This command will not delete it.`);
        }
      }
    }
    fly.progress.settle();
    const { email, oauth } = preset ?? await readSignIn(deps, parsed, true, stem);
    const databaseUrl = database.kind === "url"
      ? database.url
      : await createDatabase(fly, stem, region, org, left);

    await deployPatch(fly, {
      accessKeyId: storage.accessKeyId,
      databaseUrl,
      email,
      endpoint: storage.endpoint,
      oauth,
      org,
      publicBaseUrl: storage.publicBaseUrl,
      region,
      s3Region: storage.s3Region,
      secretAccessKey: storage.secretAccessKey,
      stem,
    }, left);
    await waitUntilReady(fly, stem);
    for (const { path } of left.directories) {
      await rm(path, { force: true, recursive: true });
    }
    left.directories.length = 0;

    // Only now, with the server answering: a mapping for an app that never
    // came up would point every later command at nothing.
    const names = flyNames(stem);
    const serverUrl = flyServerUrl(stem);
    fly.progress.settle();
    const keptDefault = await recordFlyServer(deps, parsed, {
      mapping: {
        app: names.app,
        ...(database.kind === "create" ? { databaseApp: names.databaseApp } : {}),
        kind: "fly",
        org,
        privateBucket: names.privateBucket,
        publicBucket: names.publicBucket,
        region,
      },
      serverUrl,
    });

    fly.progress.stop();
    return summary({
      billing: (await readFlyOrg(fly, org))?.status ?? null,
      createdDatabase: database.kind === "create",
      keptDefault,
      publicBaseUrl: storage.publicBaseUrl,
      serverUrl,
      signInProvider: describeConfiguredProvider(buildOAuthEnv(oauth)),
    });
  } catch (error) {
    fly.progress.fail();
    throw new UsageError(failureText(error, left));
  } finally {
    removeInterruptHook();
  }
}

/**
 * `--register`: record an existing install, creating nothing (D1). Whether
 * cmpatch created the database is asked, never inferred from an app called
 * `<stem>-db`: a later backup or restore would act on it.
 */
async function registerFlyInstall(
  deps: CommandDeps,
  parsed: ParsedArgs,
): Promise<string> {
  for (const flag of ["--create-database", "--database-url"] as const) {
    if (parsed.flags[flag] !== undefined) {
      throw new UsageError(
        `--register records an existing install and creates nothing, so it does not take ${flag}. Pass --database-app <name> or --external-database to say which database it uses.`,
      );
    }
  }
  const databaseFlag = readStringFlag(parsed, "--database-app")?.trim();
  // An empty name would be written, then dropped on the next load, which is
  // the same as --external-database without anyone having said so.
  if (databaseFlag !== undefined && !isFlyAppName(databaseFlag)) {
    throw new UsageError(
      "--database-app needs the name of the Fly Postgres app, such as acme-corp-patch-db: lowercase letters, digits and dashes. Pass --external-database instead when cmpatch did not create the database.",
    );
  }
  const external = readBooleanFlag(parsed, "--external-database");
  if (databaseFlag !== undefined && external) {
    throw new UsageError("Pass either --database-app or --external-database, not both.");
  }

  const interactive = canAsk(deps, parsed);
  if (!interactive && databaseFlag === undefined && !external) {
    throw new UsageError(
      "Pass --database-app <name> when cmpatch created the Postgres app for this install, or --external-database when Patch uses a database you run yourself.",
    );
  }

  const fly = createFlyContext(deps, RERUN);
  await ensureTool(fly, { installAllowed: readBooleanFlag(parsed, "--install-flyctl"), interactive }, "fly");
  if (!(await signedIn(fly))) {
    throw new UsageError(flyLoginFirst(`${RERUN} --register`));
  }
  const org = await resolveFlyOrgSlug(fly, interactive, readStringFlag(parsed, "--fly-org"));
  const stem = await askCompany(deps, parsed, interactive);

  let shown: string;
  try {
    shown = await run(fly, "fly", ["config", "show", "--app", stem]);
  } catch (error) {
    throw new UsageError([
      `Fly has no app ${stem} that this login can read, so there is nothing to register. Check --company and --fly-org; fly apps list shows the apps.`,
      errorMessage(error),
    ].join("\n"));
  }
  const appConfig = parseFlyAppConfig(shown);
  const region = appConfig?.region ?? null;
  const publicBucket = appConfig?.env.S3_BUCKET ?? "";
  const privateBucket = appConfig?.env.S3_INTERNAL_BUCKET ?? "";
  if (region === null || publicBucket.length === 0 || privateBucket.length === 0) {
    throw new UsageError(
      `${stem} does not look like a Patch app: fly config show --app ${stem} has no primary region or no S3_BUCKET and S3_INTERNAL_BUCKET.`,
    );
  }

  const databaseApp = databaseFlag !== undefined || external
    ? databaseFlag
    : await askDatabaseProvenance(deps, stem);

  const serverUrl = flyServerUrl(stem);
  const mapping: SelfhostFlyMapping = {
    app: stem,
    ...(databaseApp !== undefined ? { databaseApp } : {}),
    kind: "fly",
    org,
    privateBucket,
    publicBucket,
    region,
  };
  const keptDefault = await recordFlyServer(deps, parsed, { mapping, serverUrl });

  return [
    `Recorded the Fly install at ${serverUrl} on this machine.`,
    "",
    `App: ${mapping.app}`,
    `Organization: ${mapping.org}`,
    `Region: ${mapping.region}`,
    `Public bucket: ${mapping.publicBucket}`,
    `Private bucket: ${mapping.privateBucket}`,
    databaseApp === undefined
      ? "Database: external, not managed by cmpatch"
      : `Database app: ${databaseApp}`,
    ...(keptDefault === null ? [] : keptDefaultText(keptDefault, serverUrl)),
  ].join("\n");
}

async function askDatabaseProvenance(
  deps: CommandDeps,
  stem: string,
): Promise<string | undefined> {
  const databaseApp = flyNames(stem).databaseApp;
  const answer = await askSelect(deps, {
    choices: [
      { title: `Yes, cmpatch created ${databaseApp}`, value: "created" },
      { title: "No, Patch uses a database I run myself", value: "external" },
    ],
    fallback: "",
    message: `Did cmpatch create the Postgres machine ${databaseApp} for this app?`,
  });
  if (answer === "created") {
    return databaseApp;
  }
  if (answer === "external") {
    return undefined;
  }

  throw new UsageError("Answer whether cmpatch created the database, or pass --database-app or --external-database.");
}

async function ensureFlyAccount(fly: FlyContext, interactive: boolean): Promise<void> {
  const { deps } = fly;
  if (!interactive) {
    if (!(await signedIn(fly))) {
      throw new UsageError(flyLoginFirst(RERUN));
    }
    return;
  }

  const answer = await askSelect(deps, {
    choices: [
      { title: "Yes", value: "yes" },
      { title: "No", value: "no" },
    ],
    fallback: "",
    message: "Do you already have a Fly account?",
  });

  if (answer === "yes") {
    if (!(await signedIn(fly))) {
      notice(deps, "This machine is not signed in to Fly yet.");
      await runInteractive(fly, "fly", ["auth", "login"]);
    }
  } else {
    notice(deps, "This install needs a card on the Fly account. Adding a card ends the Fly trial and billing starts.");
    await runInteractive(fly, "fly", ["auth", "signup"]);
  }

  if (!(await signedIn(fly))) {
    throw new UsageError(`Fly sign-in did not finish. ${flyLoginFirst(RERUN)}`);
  }
}

async function ensureFlyCard(
  fly: FlyContext,
  interactive: boolean,
  org: string,
): Promise<void> {
  const { deps } = fly;
  const current = await readFlyOrg(fly, org);
  if (current === null || current.cardSaved) {
    return;
  }

  const url = flyBillingUrl(current.slug);
  if (!interactive) {
    throw new UsageError(missingCardText(url));
  }

  notice(deps, [
    "Card details are needed for Patch to work with Fly.io.",
    "Add a card in the billing details, it will cost a few dollars a month.",
  ]);
  await offerBrowserOpen(deps, {
    message: "Open the Fly billing page?",
    url,
  });
  await holdUntilConfirmed(deps, {
    message: "Have you added a card to this Fly organization?",
    nudge: () => [`The billing page is ${url}`],
  });

  const again = await readFlyOrg(fly, org);
  if (again === null || again.cardSaved) {
    return;
  }

  throw new UsageError(missingCardText(url));
}

function flyBillingUrl(slug: string): string {
  return `https://fly.io/dashboard/${slug}/billing`;
}

function missingCardText(url: string): string {
  return `This Fly organization has no card. Add one at ${url}, then run cmpatch selfhost install --fly again.`;
}

/** Interactive only: a scripted run checked the session before any bucket existed. */
async function ensureTigrisAccount(fly: FlyContext): Promise<void> {
  const { deps } = fly;
  let session = await readTigrisSession(fly);
  if (session.kind === "native") {
    fly.progress.settle();
    notice(deps, [
      nativeTigrisText(session),
      `The console has no sign out. Open ${TIGRIS_LOGOUT_URL} in this browser, where Fly is already signed in.`,
      "Then continue and choose Sign in with Fly.io.",
    ]);
    await run(fly, "tigris", ["logout"]);
    session = { kind: "signed-out" };
  }

  if (session.kind === "fly") {
    fly.progress.write("Tigris is signed in with Fly.io.");
    return;
  }

  if (session.kind === "unknown") {
    fly.progress.settle();
    notice(deps, [
      "Tigris stores the update files, and the buckets are billed on the Fly organization.",
      "If this session is Google, GitHub, or email, run tigris logout and sign in with Fly.io. A Fly card does not cover that other account.",
    ]);
    return;
  }

  let after = await loginTigris(fly);
  while (after.kind === "native") {
    fly.progress.settle();
    notice(deps, [
      nativeTigrisText(after),
      "That browser reused the Tigris session, so it did not offer Sign in with Fly.io.",
      `Open ${TIGRIS_LOGOUT_URL} in that same browser, then try again.`,
    ]);
    await holdUntilConfirmed(deps, {
      message: "Ready to try the login again?",
      nudge: () => ["Stay in the browser where Fly is signed in. A private window has no Fly session."],
    });
    await run(fly, "tigris", ["logout"]);
    after = await loginTigris(fly);
  }
  if (after.kind === "signed-out") {
    throw new UsageError(`Tigris sign-in did not finish. Open ${TIGRIS_LOGOUT_URL} in the browser where Fly is signed in, run tigris login, and choose Sign in with Fly.io, then run ${RERUN} again.`);
  }
}

async function loginTigris(fly: FlyContext): Promise<TigrisSession> {
  fly.progress.settle();
  notice(fly.deps, [
    "The buckets are on the Fly organization. Tigris needs a browser login to mint one key for both.",
    `On the login page, choose ${paletteFor(fly.deps).bold("Sign in with Fly.io")}.`,
    `Stay in the browser where Fly is signed in. If that page is already signed into Tigris, open ${TIGRIS_LOGOUT_URL} there first.`,
  ]);
  await runInteractive(fly, "tigris", ["login"]);
  return readTigrisSession(fly);
}

function nativeTigrisText(session: { organization?: string; userId: string }): string {
  const org = session.organization === undefined ? "" : ` (${session.organization})`;
  return `This Tigris session is signed in with ${tigrisProviderLabel(session.userId)}${org}, not Fly. The console has no sign out. Open ${TIGRIS_LOGOUT_URL} in the browser where Fly is signed in, then run tigris login and choose Sign in with Fly.io.`;
}

type TigrisSession =
  | { kind: "signed-out" }
  | { kind: "native"; organization?: string; userId: string }
  | { kind: "fly" | "unknown" };

async function readTigrisSession(fly: FlyContext): Promise<TigrisSession> {
  const { exitCode, output } = await capture(fly, "tigris", ["whoami", "--json"]);
  if (exitCode !== 0 || output.trim().length === 0) {
    return { kind: "signed-out" };
  }

  let userId = "";
  let organization: string | undefined;
  try {
    const body = JSON.parse(output) as { activeOrganization?: unknown; userId?: unknown };
    if (typeof body.userId === "string") {
      userId = body.userId;
    }
    if (typeof body.activeOrganization === "string" && body.activeOrganization.length > 0) {
      organization = body.activeOrganization;
    }
  } catch {
    return { kind: "unknown" };
  }

  if (userId.length === 0) {
    return { kind: "unknown" };
  }
  const kind = tigrisLoginKind(userId);
  if (kind === "native") {
    return { kind, userId, ...(organization === undefined ? {} : { organization }) };
  }
  return { kind };
}

async function askCompany(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
): Promise<string> {
  const supplied = readStringFlag(parsed, "--company");
  if (interactive && supplied === undefined) {
    notice(deps, "The Fly app and the public bucket are named from the company, as <company>-patch.");
  }
  const company = supplied ?? (interactive
    ? await askChecked(deps, {
        check: (value) => companyStem(value) === null
          ? UNUSABLE_COMPANY
          : null,
        message: "What's the company called?",
        type: "text",
      })
    : undefined);

  if (company === undefined) {
    throw new UsageError("Pass --company.");
  }

  const stem = companyStem(company);
  if (stem === null) {
    throw new UsageError("Pass --company with a name that becomes a short hostname, such as Acme Corp.");
  }

  return stem;
}

async function askRegion(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
): Promise<string> {
  const supplied = readStringFlag(parsed, "--fly-region")?.trim().toLowerCase();
  if (supplied !== undefined) {
    const problem = checkFlyRegion(supplied);
    if (problem) {
      throw new UsageError(problem);
    }
    return supplied;
  }

  if (!interactive) {
    throw new UsageError("Pass --fly-region.");
  }

  const selected = await askSelect(deps, {
    choices: [
      ...REGIONS.map((region) => ({ title: region.title, value: region.code })),
      { title: "Other", value: "other" },
    ],
    fallback: "",
    message: "Which Fly region should this run in?",
  });
  const region = selected === "other"
    ? (await askChecked(deps, {
        check: (value) => checkFlyRegion(value.trim().toLowerCase()),
        message: "Fly region code",
        type: "text",
      })).trim().toLowerCase()
    : selected;
  const problem = checkFlyRegion(region);
  if (problem) {
    throw new UsageError(problem);
  }

  return region;
}

async function askDatabase(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
): Promise<{ kind: "create" } | { kind: "url"; url: string }> {
  const flagged = readStringFlag(parsed, "--database-url");
  const create = readBooleanFlag(parsed, "--create-database");
  if (flagged !== undefined && create) {
    throw new UsageError("Pass either --database-url or --create-database.");
  }

  if (flagged !== undefined) {
    return { kind: "url", url: requireDatabaseUrl(flagged) };
  }
  if (create) {
    return { kind: "create" };
  }

  const fromEnv = deps.env.DATABASE_URL?.trim();
  if (fromEnv) {
    // Said, because a DATABASE_URL left in the shell is invisible in the command line.
    notice(deps, "Using the database in DATABASE_URL (environment).");
    return { kind: "url", url: requireDatabaseUrl(fromEnv) };
  }
  if (!interactive) {
    throw new UsageError("Pass --database-url or --create-database.");
  }

  notice(deps, "A new machine is a 1 GB volume that suspends with the app. Paste a URL to use a database you already run.");
  const choice = await askSelect(deps, {
    choices: [
      { title: "Create a Postgres machine on Fly", value: "create" },
      { title: "I already have a Postgres URL", value: "url" },
    ],
    fallback: "create",
    initial: 0,
    message: "Do you already have a Postgres database?",
  });

  if (choice === "url") {
    return {
      kind: "url",
      url: await askChecked(deps, { check: checkDatabaseUrl, message: "Database URL", type: "password" }),
    };
  }

  return { kind: "create" };
}

function requireDatabaseUrl(value: string): string {
  const problem = checkDatabaseUrl(value);
  if (problem) {
    throw new UsageError(problem);
  }

  return value;
}

async function readSignIn(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
  stem: string,
): Promise<{ email: string; oauth: OAuthCredentials }> {
  const oauth = await askOAuth(deps, parsed, interactive, stem);
  return { email: await askEmail(deps, parsed, interactive, oauth), oauth };
}

async function askOAuth(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
  stem: string,
): Promise<OAuthCredentials> {
  if (interactive) {
    // An install always collects the pair; the origin-only outcome is a repair's.
    return (await collectOAuth(deps, parsed, `${stem}.fly.dev`)) as OAuthCredentials;
  }

  const provider = suppliedOAuthProvider(deps, parsed);
  if (provider === undefined) {
    throw new UsageError("Pass --oauth-provider and that provider's client id and secret.");
  }

  return readOAuthCredentials(deps, parsed, provider);
}

async function askEmail(
  deps: CommandDeps,
  parsed: ParsedArgs,
  interactive: boolean,
  oauth: OAuthCredentials,
): Promise<string> {
  const supplied = readStringFlag(parsed, "--email");
  if (supplied === undefined) {
    if (!interactive) {
      throw new UsageError("Pass --email.");
    }
    return askAdminEmail(deps, oauth.provider, checkEmail);
  }

  const problem = checkEmail(supplied);
  if (problem) {
    throw new UsageError(problem);
  }
  return supplied;
}

/** The address also goes into fly.toml as a quoted string. */
function checkEmail(value: string): string | null {
  return checkAdminEmail(value) ?? (/["\n\\]/u.test(value) ? "That email cannot be stored as written." : null);
}

type Storage = {
  accessKeyId: string;
  endpoint: string;
  publicBaseUrl: string;
  s3Region: string;
  secretAccessKey: string;
};

async function createBuckets(
  fly: FlyContext,
  stem: string,
  org: string,
  interactive: boolean,
  left: Leftovers,
): Promise<Storage> {
  const names = flyNames(stem);
  if (!interactive) {
    const session = await readTigrisSession(fly);
    if (session.kind === "native") {
      throw new UsageError(nativeTigrisText(session));
    }
    if (session.kind !== "fly") {
      throw new UsageError(`Run tigris login and choose Sign in with Fly.io, then run ${RERUN} again.`);
    }
  }

  let created = false;
  try {
    fly.progress.write(`Creating ${names.publicBucket} and ${names.privateBucket}`);
    await ensureFlyBucket(fly, { interactive, name: names.publicBucket, org, publicBucket: true, stem });
    created = true;
    left.resources.push(names.publicBucket);
    await ensureFlyBucket(fly, { interactive, name: names.privateBucket, org, publicBucket: false, stem });
    left.resources.push(names.privateBucket);
    if (interactive) {
      await ensureTigrisAccount(fly);
    }
    fly.progress.write("Minting an access key for both buckets");
    const exported = await run(fly, "tigris", [
      "access-keys",
      "create",
      names.accessKey,
      "--admin",
      "--for",
      "aws",
      "--export",
    ]);
    const key = parseAccessKeyExport(exported);
    if (key === null) {
      throw new UsageError(`Tigris created an access key this command could not read. The secret is shown only once.\n${exported}`);
    }

    const endpoint = key.endpoint && key.endpoint.length > 0 ? key.endpoint : TIGRIS_ENDPOINT;
    const storage: Storage = {
      accessKeyId: key.accessKeyId,
      endpoint,
      publicBaseUrl: publicBaseUrl(names.publicBucket),
      s3Region: key.region && key.region.length > 0 ? key.region : "auto",
      secretAccessKey: key.secretAccessKey,
    };
    fly.progress.write("Checking that the key can reach both buckets");
    await proveTigrisKey(fly.deps, storage, names, org);
    return storage;
  } catch (error) {
    if (error instanceof RenameCompany) {
      throw created ? new RenameCompany(error.stem, names.publicBucket) : error;
    }
    if (!created || (error instanceof UsageError && error.message.includes("will not delete"))) {
      throw error;
    }
    throw new UsageError(`${errorMessage(error)}\nThis command will not delete the buckets.`);
  }
}

const KEY_CHECK_BODY = "cmpatch install check\n";

/**
 * A disposable PUT, GET and DELETE on both buckets with the minted key, and an
 * anonymous GET of each object while it exists: the public one must serve it,
 * the private one must refuse it. That is how a reused bucket's visibility is
 * checked, so nothing reads it from flyctl. `--admin` reaches every
 * bucket in the Tigris login's active organization, so a key minted in another
 * organization than the Fly one the buckets were created in fails here instead
 * of on the first upload, which `/health/ready` would never notice.
 */
async function proveTigrisKey(
  deps: CommandDeps,
  storage: Storage,
  names: FlyNames,
  org: string,
): Promise<void> {
  const key = `_cmpatch-install-check/${deps.randomUUID()}`;
  const signed = (method: string, bucket: string, body?: string) => awsRequest({
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    fetch: deps.fetch,
    method,
    region: storage.s3Region,
    service: "s3",
    url: s3ObjectUrl({ bucket, endpoint: storage.endpoint, forcePathStyle: true, key, region: storage.s3Region }),
    ...(body === undefined ? {} : { body, headers: { "content-type": "text/plain" } }),
  });

  for (const bucket of [names.publicBucket, names.privateBucket]) {
    // Set before the PUT is sent and cleared only by a confirmed DELETE, so a
    // PUT whose response is lost or a DELETE that fails still gets a cleanup try.
    let stored = true;
    try {
      await expectStatus(await attempt(() => signed("PUT", bucket, KEY_CHECK_BODY)), bucket, "PUT", org);
      const read = await attempt(() => signed("GET", bucket));
      await expectStatus(read, bucket, "GET", org, KEY_CHECK_BODY);
      if (bucket === names.publicBucket) {
        await expectAnonymousRead(deps, `${storage.publicBaseUrl}/${key}`, bucket, org);
      } else {
        await expectAnonymousRefused(deps, `${publicBaseUrl(bucket)}/${key}`, bucket, org);
      }
      await expectStatus(await attempt(() => signed("DELETE", bucket)), bucket, "DELETE", org);
      stored = false;
    } finally {
      if (stored) {
        // Best effort: the run is already stopping on the failure above.
        await signed("DELETE", bucket).then((response) => response.body?.cancel(), () => undefined);
      }
    }
  }
}

async function attempt(send: () => Promise<Response>): Promise<Response | Error> {
  try {
    return await send();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const KEY_CHECK_KEPT = "This command will not delete the buckets or the key.";

function keyCheckServiceFailure(what: string): UsageError {
  return new UsageError([
    `${what}; check Tigris status and the network, then run cmpatch selfhost install --fly again.`,
    KEY_CHECK_KEPT,
  ].join("\n"));
}

/**
 * 401 and 403, and a bucket the key's organization does not have, are the key
 * not reaching the bucket. Anything else is Tigris or the network, which says
 * nothing about the organization.
 */
async function expectStatus(
  result: Response | Error,
  bucket: string,
  method: "DELETE" | "GET" | "PUT",
  org: string,
  body?: string,
): Promise<void> {
  if (result instanceof Error) {
    throw keyCheckServiceFailure(`Tigris could not be reached for ${method} on ${bucket}: ${redactSecrets(result.message)}`);
  }

  const text = await result.text();
  if (result.ok && (body === undefined || text === body)) {
    return;
  }
  if (result.ok) {
    throw keyCheckServiceFailure(`Tigris returned a different object for ${method} on ${bucket}`);
  }

  const code = /<Code>(\w+)<\/Code>/u.exec(text)?.[1];
  const status = `HTTP ${result.status}${code === undefined ? "" : ` ${code}`}`;
  if (result.status !== 401 && result.status !== 403 && code !== "NoSuchBucket") {
    throw keyCheckServiceFailure(`Tigris returned ${status} for ${method} on ${bucket}`);
  }

  throw new UsageError([
    `The new Tigris access key cannot reach ${bucket}: ${method} returned ${status}.`,
    `The usual cause is that the Tigris login is in a different organization than the Fly organization ${org} the buckets were created in. Run tigris orgs select to switch, or tigris logout and tigris login with Sign in with Fly.io, then run cmpatch selfhost install --fly again.`,
    KEY_CHECK_KEPT,
  ].join("\n"));
}

/** 403 and 404 are the bucket not being public. Anything else is Tigris or the network. */
async function expectAnonymousRead(
  deps: CommandDeps,
  url: string,
  bucket: string,
  org: string,
): Promise<void> {
  const result = await attempt(() => deps.fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }));
  if (result instanceof Error) {
    throw keyCheckServiceFailure(`The public host could not be reached for GET ${url}: ${result.message}`);
  }

  const text = await result.text();
  if (result.ok && text === KEY_CHECK_BODY) {
    return;
  }
  if (result.status !== 403 && result.status !== 404) {
    throw keyCheckServiceFailure(result.ok
      ? `The public host returned a different object for GET ${url}`
      : `The public host returned HTTP ${result.status} for GET ${url}`);
  }

  throw new UsageError([
    `${bucket} is not readable without credentials: GET ${url} returned HTTP ${result.status}. Phones could not download releases from it.`,
    `Run fly storage update ${bucket} --org ${org} --public, then run cmpatch selfhost install --fly again.`,
    KEY_CHECK_KEPT,
  ].join("\n"));
}

/** 403 and 404 are the bucket being private. Anything else readable stops the run; the rest is Tigris or the network. */
async function expectAnonymousRefused(
  deps: CommandDeps,
  url: string,
  bucket: string,
  org: string,
): Promise<void> {
  // Without credentials a private bucket answers 403 on `<bucket>.t3.tigrisfiles.io`.
  const result = await attempt(() => deps.fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }));
  if (result instanceof Error) {
    throw keyCheckServiceFailure(`The public host could not be reached for GET ${url}: ${result.message}`);
  }

  await result.body?.cancel();
  if (result.status === 403 || result.status === 404) {
    return;
  }
  if (!result.ok) {
    throw keyCheckServiceFailure(`The public host returned HTTP ${result.status} for GET ${url}`);
  }

  throw new UsageError([
    `${bucket} is readable by anyone: GET ${url} without credentials returned HTTP ${result.status}. Files in the private bucket would be world-readable.`,
    `Run fly storage update ${bucket} --org ${org} --private, then run cmpatch selfhost install --fly again.`,
    KEY_CHECK_KEPT,
  ].join("\n"));
}

async function ensureFlyBucket(
  fly: FlyContext,
  input: { interactive: boolean; name: string; org: string; publicBucket: boolean; stem: string },
): Promise<void> {
  const { deps } = fly;
  try {
    await createFlyBucket(fly, input);
    return;
  } catch (error) {
    if (!isStorageNameTaken(errorMessage(error))) {
      throw error;
    }

    if (!(await flyBucketInOrg(fly, input.name, input.org))) {
      if (!input.interactive) {
        throw new UsageError(
          `${input.name} is already taken, and it is not in the Fly organization ${input.org}. Pass a different --company. This command will not delete it.`,
        );
      }
      fly.progress.settle();
      notice(deps, `${input.name} is already taken, and it is not in ${input.org}.`);
      throw new RenameCompany(await askReplacementCompany(deps, input.stem));
    }

    // Its visibility is checked by the key check's anonymous reads.
    if (!input.interactive) {
      fly.progress.write(`${input.name} already exists in ${input.org}. Using that bucket.`);
      return;
    }

    fly.progress.settle();
    const answer = await askSelect(deps, {
      choices: [
        { title: "Use the existing bucket", value: "use" },
        { title: "Enter a different company name", value: "rename" },
      ],
      fallback: "rename",
      message: `${input.name} already exists in ${input.org}. What should this command do?`,
    });
    if (answer === "rename") {
      throw new RenameCompany(await askReplacementCompany(deps, input.stem));
    }
  }
}

async function askReplacementCompany(deps: CommandDeps, current: string): Promise<string> {
  const company = await askChecked(deps, {
    check: (value) => {
      const stem = companyStem(value);
      if (stem === null) {
        return UNUSABLE_COMPANY;
      }
      if (stem === current) {
        return "That is the same name. Choose a different company.";
      }
      return null;
    },
    message: "What should the company be called instead?",
    type: "text",
  });
  return companyStem(company) as string;
}

/**
 * `fly storage status` cannot answer this: it takes no `--org`, finds any
 * bucket the login can see, and its `Public` row is Fly's record, not Tigris's.
 */
async function flyBucketInOrg(fly: FlyContext, name: string, org: string): Promise<boolean> {
  // `--org` limits the list to that organization's buckets.
  return flyStorageListHas(await run(fly, "fly", ["storage", "list", "--org", org]), name);
}

async function createFlyBucket(
  fly: FlyContext,
  input: { name: string; org: string; publicBucket: boolean },
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cmpatch-fly-storage-"));
  try {
    await run(fly, "fly", [
      "storage",
      "create",
      "--name",
      input.name,
      "--org",
      input.org,
      "--yes",
      ...(input.publicBucket ? ["--public"] : []),
    ], { cwd: directory });
  } catch (error) {
    throw new UsageError(redactSecrets(errorMessage(error)));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function createDatabase(
  fly: FlyContext,
  stem: string,
  region: string,
  org: string,
  left: Leftovers,
): Promise<string> {
  const names = flyNames(stem);
  const password = hexSecret(fly.deps);
  fly.progress.write(`Creating ${names.databaseApp}. The first build takes several minutes.`);
  const directory = await mkdtemp(join(tmpdir(), "cmpatch-fly-db-"));
  left.directories.push({ path: directory, text: `The database config is still at ${directory}.` });
  await writeFile(join(directory, "fly.toml"), databaseFlyToml(stem, region), { mode: 0o644 });
  await run(fly, "fly", ["apps", "create", names.databaseApp, "--org", org]);
  left.resources.push(names.databaseApp);
  await run(fly, "fly", [
    "volumes",
    "create",
    "pg_data",
    "--app",
    names.databaseApp,
    "--region",
    region,
    "--size",
    "1",
    "--yes",
  ]);
  await run(fly, "fly", ["secrets", "import", "--app", names.databaseApp], {
    stdin: formatSecrets({ POSTGRES_PASSWORD: password }),
  });
  await run(fly, "fly", ["ips", "allocate-v6", "--private", "--app", names.databaseApp]);
  await run(fly, "fly", ["deploy", "--ha=false", "--app", names.databaseApp], { cwd: directory, show: true });

  return flycastDatabaseUrl(stem, password);
}

async function deployPatch(
  fly: FlyContext,
  input: {
    accessKeyId: string;
    databaseUrl: string;
    email: string;
    endpoint: string;
    oauth: OAuthCredentials;
    org: string;
    publicBaseUrl: string;
    region: string;
    s3Region: string;
    secretAccessKey: string;
    stem: string;
  },
  left: Leftovers,
): Promise<void> {
  const names = flyNames(input.stem);
  const tag = latestServerTag(await listRemoteTags(fly));

  // A failed or interrupted clone leaves this empty: git removes what it cloned.
  const parent = await mkdtemp(join(tmpdir(), "cmpatch-fly-"));
  const checkout = await cloneServerTag(fly, tag, parent);
  left.directories.push({
    path: parent,
    text: `The checkout is still at ${checkout}; fly deploy --ha=false there deploys ${names.app}.`,
  });
  await writeFile(join(checkout, "fly.toml"), patchFlyToml({
    email: input.email,
    endpoint: input.endpoint,
    publicBaseUrl: input.publicBaseUrl,
    region: input.region,
    s3Region: input.s3Region,
    serverTag: tag,
    stem: input.stem,
  }), { mode: 0o644 });
  await run(fly, "fly", ["apps", "create", names.app, "--org", input.org]);
  left.resources.push(names.app);
  await run(fly, "fly", ["secrets", "import", "--app", names.app], {
    stdin: formatSecrets({
      ...buildOAuthEnv(input.oauth),
      DATABASE_URL: input.databaseUrl,
      OAUTH_CLI_AUTH_SECRET: hexSecret(fly.deps),
      S3_ACCESS_KEY_ID: input.accessKeyId,
      S3_SECRET_ACCESS_KEY: input.secretAccessKey,
      WORKER_SHARED_SECRET: hexSecret(fly.deps),
    }),
  });
  fly.progress.write("Building the server image on Fly. The first build takes several minutes.");
  await run(fly, "fly", ["deploy", "--ha=false", "--app", names.app], { cwd: checkout, show: true });
}

function hexSecret(deps: CommandDeps): string {
  return `${deps.randomUUID()}${deps.randomUUID()}`.replaceAll("-", "");
}

/**
 * The Fly mapping under the server URL, and that URL as the default server when
 * the operator agrees, as the ssh installer does. The entry is replaced, not
 * merged: a reinstall that moved to an external database must not keep the
 * old `databaseApp`, and `--register` rebuilds the entry from Fly. Returns the
 * default server this machine keeps instead, or null when the URL is now the
 * default.
 */
async function recordFlyServer(
  deps: CommandDeps,
  parsed: ParsedArgs,
  input: { mapping: SelfhostFlyMapping; serverUrl: string },
): Promise<string | null> {
  let config = withSelfhostMapping(
    await loadCliConfig({ env: deps.env }),
    input.serverUrl,
    input.mapping,
    { replace: true },
  );

  if (
    await shouldAdoptServerUrl(
      deps,
      parsed,
      config.serverUrl,
      input.serverUrl,
      {},
    )
  ) {
    config = { ...config, serverUrl: selfhostMappingKey(input.serverUrl) };
  }

  await saveConfig(deps, config);
  return config.serverUrl === selfhostMappingKey(input.serverUrl) ? null : (config.serverUrl ?? null);
}

/**
 * Said whenever the install is recorded but not adopted as the default (a
 * scripted run, or "no" to the question): `selfhost backup`, `upgrade` and
 * `restore` take no address on Fly, so without this the next one goes to the
 * other server. Live, the first scripted backup after an install did.
 */
function keptDefaultText(kept: string, serverUrl: string): string[] {
  return [
    "",
    `This machine's default server stays ${kept}, so cmpatch selfhost backup, upgrade and restore go there unless told otherwise.`,
    `For this install, run them with CODEMAGIC_PATCH_SERVER_URL=${serverUrl}, or make it the default:`,
    `  cmpatch config set server-url ${serverUrl}`,
  ];
}

function summary(input: {
  billing: Billing;
  createdDatabase: boolean;
  /** The default server this machine keeps instead of the install; null when the install is the default. */
  keptDefault: string | null;
  publicBaseUrl: string;
  serverUrl: string;
  signInProvider: string | undefined;
}): string {
  const lines = [
    "Patch is running.",
    "",
    `Dashboard: ${input.serverUrl}`,
    `Download URL: ${input.publicBaseUrl}`,
    "",
    "Both addresses are built into the app binary. Changing either one later means a new store build.",
    "",
    ...renderSignInSteps(input.serverUrl, input.signInProvider),
    `  cmpatch init --server-url ${input.serverUrl}`,
    ...(input.keptDefault === null ? [] : keptDefaultText(input.keptDefault, input.serverUrl)),
  ];

  if (input.createdDatabase) {
    lines.push(
      "",
      "The database disk is one volume, and Fly's daily snapshot is the only backup this command arranged.",
    );
  }
  if (input.billing === "TRIAL_ACTIVE") {
    lines.push(
      "",
      "This Fly org is on a trial: 2 machine-hours or 7 days, whichever comes first. Trial machines are stopped after they have been running for 5 minutes, even if suspend is set. The next request cold-starts them, about 2 seconds for the app, and longer for Postgres because it recovers from its volume. Suspend, which resumes in a few hundred milliseconds, starts working after a card is added. Both machines draw from the same 2 hours. That is enough to deploy, sign in, and have a phone pick up a release a few times. Adding a card ends the trial and billing starts.",
    );
  }
  if (input.billing === "TRIAL_ENDED") {
    lines.push(
      "",
      "The Fly trial is over. A card is required before machines will start.",
    );
  }

  return lines.join("\n");
}

/** The bucket steps say for themselves what they keep; a directory is only made after them. */
function failureText(error: unknown, left: Leftovers): string {
  return [errorMessage(error), ...(left.directories.length === 0 ? [] : keptText(left))].join("\n");
}

function keptText(left: Leftovers): string[] {
  return [
    "This command will not delete what it created on Fly. Try a different company to start over.",
    ...left.directories.map((directory) => directory.text),
  ];
}

function interruptedText(left: Leftovers): string[] {
  return [
    left.resources.length === 0
      ? "Interrupted before this run created anything on Fly."
      : `Interrupted. Left on Fly so far: ${left.resources.join(", ")}.`,
    "A fly command that was already running may still finish.",
    ...(left.resources.length === 0 ? [] : keptText(left)),
  ];
}
