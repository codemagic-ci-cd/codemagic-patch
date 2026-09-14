import { quoteShellValue } from "../../remoteExec";
import { randomBytes } from "node:crypto";
import { R2CacheRuleConflict } from "../../providers/cloudflare";
import { ProviderHttpError } from "../../providers/providerError";
import { PromptAbortError } from "../../prompt";
import { type StorageConfig } from "../../storageConfig";
import { type ParsedArgs, type SelfhostSession } from "../selfhostSession";
import { UsageError, type CommandDeps } from "../shared";
import { askChecked, askValue, notice, offerBrowserOpen, onSignal } from "./ask";
import { supplied } from "./answers";

export type ExternalStorage = Exclude<StorageConfig, { kind: "bundled" }>;
export type StoragePlan = {
  kind: "r2" | "s3" | "gcs";
  setup: "automatic" | "guided" | "configured";
  publicBucket: string;
  internalBucket: string;
  region: string;
  project?: string;
  accountId?: string;
  downloadDomain?: string;
  delivery: "none" | "cloudflare" | "cloudfront";
};
export type SetupContext = {
  interactive?: boolean;
  deps: CommandDeps;
  parsed: ParsedArgs;
  session: SelfhostSession;
  plan: StoragePlan;
  fetch: typeof fetch;
  signal: AbortSignal;
  cleanupWarnings?: string[];
  // Shared by retry contexts so re-entering a credential does not revoke it twice.
  revokedSetupCredentials?: Set<string>;
};

export const suffix = () => randomBytes(4).toString("hex");

/**
 * A setup step that failed. `approved` says whether the user had already
 * approved provisioning when it did: before that point nothing exists in the
 * account and the step can simply be tried again with other credentials;
 * after it, whatever was created is named and kept. `cleanup` revokes the
 * attempt's disposable setup credential; a pre-approval failure hands it to
 * the caller instead of running it, so a credential that was not the cause
 * of the failure survives into the retry, and the caller revokes it when the
 * storage step ends.
 */
export class StorageSetupError extends UsageError {
  constructor(
    message: string,
    readonly approved: boolean,
    readonly cleanup?: () => Promise<void>,
  ) {
    super(message);
    this.name = "StorageSetupError";
  }
}

/** A readiness wait the user stopped with Ctrl+C. Nothing else has changed. */
export class WaitStoppedError extends UsageError {
  constructor(label: string) {
    super(`${label} stopped at your request. Everything created so far is kept.`);
    this.name = "WaitStoppedError";
  }
}

/**
 * The rerun that verifies these resources instead of creating them again.
 * Complete on purpose: a rerun that defaulted the region put guided
 * verification against the wrong regional endpoint. Flags whose value the
 * plan does not carry are left out rather than printed blank.
 */
export function recoveryCommand(
  plan: StoragePlan,
  storage?: ExternalStorage,
): string {
  if (storage)
    plan = {
      ...plan,
      publicBucket: storage.publicBucket,
      internalBucket: storage.internalBucket,
      region: storage.kind === "gcs" ? plan.region : storage.region,
      downloadDomain: new URL(storage.publicBaseUrl).hostname,
    };
  const endpoint =
    storage && storage.kind !== "gcs" ? storage.endpoint : undefined;
  const flag = (name: string, value: string | undefined) =>
    value
      ? [
          `${name} ${/^[\w./:-]+$/u.test(value) ? value : quoteShellValue(name, value)}`,
        ]
      : [];
  const parts = [
    `--storage-mode ${plan.kind}`,
    "--storage-setup guided",
    ...(plan.kind === "gcs"
      ? [
          `--gcs-public-bucket ${plan.publicBucket}`,
          `--gcs-internal-bucket ${plan.internalBucket}`,
          ...flag("--gcs-location", plan.region),
          ...flag("--gcp-project", plan.project),
        ]
      : [
          `--s3-bucket ${plan.publicBucket}`,
          `--s3-internal-bucket ${plan.internalBucket}`,
          ...(plan.kind === "r2"
            ? [
                ...flag("--cloudflare-account-id", plan.accountId),
                ...flag(
                  "--s3-endpoint",
                  endpoint ??
                    (plan.accountId &&
                      `https://${plan.accountId}.r2.cloudflarestorage.com`),
                ),
              ]
            : [
                ...flag("--s3-region", plan.region),
                ...flag("--s3-endpoint", endpoint),
              ]),
          ...(storage && storage.kind !== "gcs"
            ? flag("--s3-force-path-style", String(storage.forcePathStyle))
            : []),
        ]),
    ...flag("--public-base-url", storage?.publicBaseUrl),
    ...(plan.delivery === "none"
      ? []
      : [
          ...flag("--download-domain", plan.downloadDomain),
          ...(plan.kind === "r2" ? [] : [`--${plan.delivery}`]),
        ]),
  ];
  return `cmpatch selfhost install ${parts.join(" ")}`;
}

export async function offerStorageCredential(
  ctx: SetupContext,
  input: {
    sources: { flag: string; env: string }[];
    instructions: string | readonly string[];
    url: string;
    message: string;
  },
): Promise<void> {
  if (input.sources.every((source) => supplied(ctx.deps, ctx.parsed, source)?.value))
    return;
  notice(ctx.deps, input.instructions);
  notice(ctx.deps, input.url);
  if (ctx.interactive !== false) await offerBrowserOpen(ctx.deps, input);
}
export function bucketProblem(value: string): string | null {
  return /^(?!xn--)(?!sthree-)(?!amzn-s3-demo-)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(
    value,
  ) && !/(-s3alias|--ol-s3|--x-s3|--table-s3)$/u.test(value)
    ? null
    : "Use 3–63 lowercase letters, digits or hyphens; start and end with a letter or digit. AWS reserved bucket names are not supported.";
}
export async function storageValue(
  deps: CommandDeps,
  parsed: ParsedArgs,
  flag: string,
  env: string,
  message: string,
  initial?: string,
  secret = false,
  check?: (value: string) => string | null,
): Promise<string> {
  const known = supplied(deps, parsed, { flag, env })?.value;
  if (known !== undefined) {
    const problem = check?.(known);
    if (problem) throw new UsageError(problem);
    return known;
  }
  const request = {
    message,
    type: secret ? "password" as const : "text" as const,
    ...(initial === undefined ? {} : { initial }),
  };
  return check ? askChecked(deps, { ...request, check }) : askValue(deps, request);
}
export async function approveSetup(
  ctx: SetupContext,
  identity: string,
): Promise<void> {
  notice(
    ctx.deps,
    `Selected ${identity}. Create public bucket ${ctx.plan.publicBucket}, private bucket ${ctx.plan.internalBucket} and runtime credentials. ${ctx.plan.kind === "r2" ? "The combined runtime token writes to these two buckets, reads R2 configuration and objects across this account, and reads/purges the download zone. " : "Runtime object access is scoped to these two buckets. "}Public artifacts will be readable by anyone; internal objects stay private. Delivery: ${ctx.plan.delivery}${ctx.plan.delivery !== "none" && ctx.plan.kind !== "r2" ? " (console setup follows)" : ""}.`,
  );
  if (
    !(await ctx.deps.confirm?.({
      message: "Create these storage resources in this account?",
      initial: true,
    }))
  )
    throw new PromptAbortError();
  ctx.signal.throwIfAborted();
}
/**
 * Polls `check` until it answers, the cap passes, or — for a stoppable wait —
 * the user presses Ctrl+C.
 *
 * The press is the wait's own: the hook registered here is the innermost
 * one, so it stops this wait and nothing else; the step's shared abort
 * signal, which cancels every request in flight and ends the whole storage
 * step, stays untouched. The press takes effect once the request in flight
 * has answered. A wait that runs inside provisioning, with no correction
 * menu to return to, is not stoppable: the press then reaches the step's own
 * hook and ends the step, as the spinner line says.
 */
export async function waitReady<T>(
  ctx: SetupContext,
  label: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 120_000,
  options: { stoppable?: boolean } = {},
): Promise<T> {
  const attempts = Math.ceil(timeoutMs / 3000);
  const started = ctx.deps.now();
  const { progress } = ctx.session;
  const stoppable = options.stoppable !== false;
  let stopped = false;
  const removeHook = stoppable
    ? onSignal(ctx.session, () => {
        stopped = true;
      })
    : () => {};
  progress.write(label);
  try {
    progress.detail(
      `${label}: waiting up to ${timeoutMs / 1000}s.${stoppable ? " Ctrl+C stops the wait." : ""}`,
    );
    for (let attempt = 0; attempt <= attempts; attempt++) {
      ctx.signal.throwIfAborted();
      if (stopped) throw new WaitStoppedError(label);
      const result = await check();
      if (result !== undefined) return result;
      if (stopped) throw new WaitStoppedError(label);
      if (attempt === attempts || ctx.deps.now() - started >= timeoutMs) break;
      await ctx.deps.sleep(3000);
    }
    throw new UsageError(`${label} timed out. Check the provider console.`);
  } finally {
    removeHook();
    progress.settle();
  }
}
/**
 * The error a provisioning step ends with.
 *
 * The provider's own message is kept whatever kind of error it was — a
 * profile that does not exist, a key file that cannot be read, an expired
 * SSO session — because a generic "the request failed; its outcome may be
 * uncertain" sends the user to the console looking for a request that was
 * never made. Response bodies never reach these messages (`ProviderHttpError`
 * carries a status and a validated code only), so there is no secret to
 * keep out.
 */
export function setupFailure(
  ctx: SetupContext,
  step: string,
  error: unknown,
  resources: string[],
  approved: boolean,
  cleanup?: () => Promise<void>,
): Error {
  if (error instanceof PromptAbortError) return error;
  const reason =
    error instanceof Error && error.name === "AbortError"
      ? "Setup was cancelled."
      : error instanceof Error
        ? error.message
        : "The provider request failed.";
  const permissionsHint =
    error instanceof ProviderHttpError || error instanceof R2CacheRuleConflict
      ? ["Check the selected account's permissions and public-access policy in its console."]
      : [];
  if (!approved) {
    return new StorageSetupError(
      [`${step}: ${reason}`, ...permissionsHint, "Nothing has been created in your account."].join("\n"),
      false,
      cleanup,
    );
  }

  return new StorageSetupError(
    [
      `${step}: ${reason}`,
      ...permissionsHint,
      "Existing resources are not rolled back.",
      `Reuse them with: ${recoveryCommand(ctx.plan)}`,
      `Created resources: ${resources.length ? resources.join(", ") : "none confirmed; inspect the console for a request whose response was lost"}.`,
      "Runtime secrets must be entered by prompt or environment/file; if a generated key was not saved, replace it in the console before guided setup.",
    ].join("\n"),
    true,
  );
}
export function recordResource(
  ctx: SetupContext,
  resources: string[],
  id: string,
): void {
  resources.push(id);
  notice(
    ctx.deps,
    `Created ${id}. Keep this identifier for manual cleanup or guided reuse.`,
  );
}
export async function cleanupSetup(
  ctx: SetupContext,
  id: string,
  url: string,
  revoke: () => Promise<unknown>,
): Promise<void> {
  const { deps } = ctx;
  const credential = JSON.stringify([url, id]);
  if (ctx.revokedSetupCredentials?.has(credential)) return;
  try {
    await revoke();
    ctx.revokedSetupCredentials?.add(credential);
    notice(deps, `Revoked disposable setup credential ${id}.`);
  } catch {
    const warning = `SETUP CREDENTIAL CLEANUP REQUIRED: revoke ${id} manually at ${url}. Runtime configuration is separate; no automatic rollback occurred.`;
    recordCleanupWarning(ctx, warning);
  }
}

export function recordCleanupWarning(ctx: SetupContext, warning: string): void {
  ctx.cleanupWarnings?.push(warning);
  notice(ctx.deps, warning);
}
