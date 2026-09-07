/**
 * Where the evaluation stack's source lives on this machine.
 *
 * `up.sh` runs from a checkout of the repo, and a user who installed the CLI
 * from npm has none — so the CLI keeps one under its own config home and
 * fast-forwards it on every run. `--checkout` points at a checkout the user
 * already has (a contributor's working tree), which is used as it is and
 * never updated.
 */

import { isAbsolute, join, resolve } from "node:path";

import { SOURCE_REPO_URL } from "../../branding";
import { resolveConfigHome } from "../../configStore";
import type { Progress } from "../../progress";
import { sourceBundlePath } from "../selfhostInstall/hostBootstrap";
import { readStringFlag, type ParsedArgs } from "../selfhostSession";
import { RemoteScriptFailure } from "../scriptRunner";
import { UsageError, type CommandDeps } from "../shared";
import { captureLocal } from "./process";

export type Checkout = {
  /** Kept and updated by the CLI, as opposed to one the user pointed at. */
  managed: boolean;
  path: string;
};

export const UP_SCRIPT = "scripts/local-eval/up.sh";
export const COMPOSE_FILE = "docker-compose.dev.yml";

/**
 * The Compose project the stack lives under — the same name `up.sh` passes
 * and the compose file's `name:` declares, given explicitly on every
 * invocation here because the flag outranks a COMPOSE_PROJECT_NAME in the
 * user's shell. Left to Compose, the name came from the checkout's directory,
 * so a managed checkout and a clone both called `codemagic-patch` silently
 * shared one stack and `down --volumes` could reach another project's data.
 */
export const COMPOSE_PROJECT = "codemagic-patch-local-eval";

/** `docker compose ...` addressed at the stack of `checkoutPath`. */
export function composeArgs(checkoutPath: string): string[] {
  return [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "-f",
    join(checkoutPath, COMPOSE_FILE),
  ];
}

export function managedCheckoutPath(
  env: Record<string, string | undefined>,
): string {
  return join(resolveConfigHome(env), "local-eval", "codemagic-patch");
}

export function resolveCheckout(deps: CommandDeps, parsed: ParsedArgs): Checkout {
  const explicit = readStringFlag(parsed, "--checkout");
  if (explicit !== undefined) {
    return {
      managed: false,
      path: isAbsolute(explicit) ? explicit : resolve(explicit),
    };
  }

  return { managed: true, path: managedCheckoutPath(deps.env) };
}

/** Whether `path` holds a checkout `up.sh` can run from. */
export async function isCheckout(
  deps: CommandDeps,
  path: string,
): Promise<boolean> {
  try {
    return (await deps.stat(join(path, UP_SCRIPT))).isFile();
  } catch {
    return false;
  }
}

async function exists(deps: CommandDeps, path: string): Promise<boolean> {
  try {
    await deps.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure the checkout is there and, for the managed one, current.
 *
 * Updating is best-effort: the stack is for evaluation, so a checkout that
 * cannot be fast-forwarded (offline, edited by hand) is used as it is with a
 * warning rather than blocking the run — nothing here is upgraded in place
 * the way a real server is.
 */
export async function ensureCheckout(
  deps: CommandDeps,
  progress: Progress,
  checkout: Checkout,
): Promise<void> {
  if (!checkout.managed) {
    if (!(await isCheckout(deps, checkout.path))) {
      throw new UsageError(
        `${checkout.path} does not contain ${UP_SCRIPT}; --checkout must point at a checkout of ${SOURCE_REPO_URL}.`,
      );
    }
    return;
  }

  if (await exists(deps, checkout.path)) {
    if (!(await isCheckout(deps, checkout.path))) {
      throw new UsageError(
        [
          `${checkout.path} exists but is not a checkout of the evaluation stack.`,
          "Move it out of the way and run this again, or pass --checkout <path> to use a checkout you already have.",
        ].join("\n"),
      );
    }

    await updateCheckout(deps, progress, checkout.path);
    return;
  }

  await cloneCheckout(deps, progress, checkout.path);
}

async function cloneCheckout(
  deps: CommandDeps,
  progress: Progress,
  path: string,
): Promise<void> {
  const source = sourceBundlePath(deps) ?? SOURCE_REPO_URL;
  progress.write("downloading the evaluation stack's source");

  const chunks: string[] = [];
  let result;
  try {
    result = await deps.runProcess({
      args: ["clone", "--quiet", source, path],
      command: "git",
      onOutput: (chunk) => {
        chunks.push(chunk);
        progress.detail(chunk.trim());
      },
    });
  } catch {
    throw new UsageError(
      "git is required to download the evaluation stack's source, and it is not on PATH. Install git and run this again.",
    );
  }

  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      [
        `Could not download the evaluation stack's source from ${source} to ${path}.`,
        "",
        ...chunks.join("").trim().split("\n"),
      ].join("\n"),
    );
  }
}

async function updateCheckout(
  deps: CommandDeps,
  progress: Progress,
  path: string,
): Promise<void> {
  progress.write("updating the evaluation stack's source");
  const git = (args: readonly string[]) =>
    captureLocal(deps, { args: ["-C", path, ...args], command: "git" });

  const status = await git(["status", "--porcelain"]);
  if (status.spawnError !== null || status.exitCode !== 0) {
    progress.warn(
      `${path} is not a git checkout, so it was not updated; using it as it is.`,
    );
    return;
  }
  if (status.output.trim().length > 0) {
    progress.warn(
      `${path} has local changes, so it was not updated; using it as it is.`,
    );
    return;
  }

  // Told apart from a diverged checkout below: a detached HEAD or a branch
  // with nothing to track (a clone of a bundle that carried only HEAD) has
  // nothing to fast-forward to, which is not the same as having moved away.
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (upstream.exitCode !== 0) {
    progress.warn(
      `${path} has no upstream branch to update from, so it was not updated; using it as it is.`,
    );
    return;
  }

  const before = (await git(["rev-parse", "--short", "HEAD"])).output.trim();
  const fetched = await git(["fetch", "--quiet", "origin"]);
  if (fetched.exitCode !== 0) {
    progress.warn(
      "Could not reach the source repository to check for updates; using the copy already here.",
    );
    return;
  }

  // --ff-only is the guard: a checkout that diverged from its upstream is
  // left alone rather than merged into something nobody reviewed.
  const merged = await git(["merge", "--ff-only", "--quiet", "@{upstream}"]);
  if (merged.exitCode !== 0) {
    progress.warn(
      `${path} has diverged from the source repository, so it was not updated; using it as it is.`,
    );
    return;
  }

  const after = (await git(["rev-parse", "--short", "HEAD"])).output.trim();
  progress.detail(
    before === after ? `already up to date (${after})` : `${before} → ${after}`,
  );
}
