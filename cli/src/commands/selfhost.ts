/**
 * `cmpatch selfhost upgrade | backup | restore`, and the namespace's dispatch.
 *
 * Every one of these is a thin wrapper: resolve the ssh target, pair if
 * needed, run the existing `scripts/selfhost/*.sh` over ssh, and render its
 * output. No script logic is reimplemented here. (A server recorded as a Fly
 * install has no ssh host; its upgrade runs through flyctl in
 * `flyMaintenance.ts`, its backup and restore in `flyBackup.ts`.) The
 * interactive layers are **selection and confirmation only**; every prompt
 * has a flag equivalent, and a non-interactive run behaves exactly like the
 * flags-only command it was before this namespace existed.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { PRODUCT_NAME, SOURCE_REPO_URL } from "../branding";
import type { SelfhostCommand } from "../commandTypes";
import { onInterruptCleanup } from "../progress";
import {
  assembleScpArgs,
  captureRemoteShell,
  formatScpRemotePath,
  pairedSshInvocation,
} from "../remoteExec";
import {
  BACKUP_MILESTONES,
  RESTORE_MILESTONES,
  UPGRADE_MILESTONES,
} from "../remoteOutput";
import {
  describeRestoredComponents,
  renderBackupIntro,
  renderRestoreConsequence,
  renderRestoreNoOp,
  renderRestoreScope,
} from "../selfhostCopy";
import {
  resolveLatestServerImageRelease,
  resolveLatestServerTagForImage,
  serverSourceRepo,
} from "../serverRelease";
import {
  listRemoteBackups,
  localBackupRoot,
  utcStamp,
  type RemoteBackup,
} from "../selfhostRemote";
import { runFlyBackup, runFlyRestore } from "./flyBackup";
import { runFlyInstall } from "./flyInstall";
import { runFlyUpgrade } from "./flyMaintenance";
import { runLocalEval } from "./localEval";
import { runInstall } from "./selfhostInstall";
import { confirmUpgradePlan, shortImageRef } from "./selfhostInstall/ask";
import { sourceRepoScriptEnv } from "./selfhostInstall/hostBootstrap";
import {
  canAsk,
  COMMON_FLAGS,
  confirmTypedRestore,
  looksLikeSshTarget,
  openSession,
  parseArgs,
  readBooleanFlag,
  readStringFlag,
  RemoteScriptFailure,
  resolveCommandTarget,
  runSelfhostScript,
  takeSingleTarget,
  upgradeAsksFirst,
  writeNotice,
  type FlagShape,
  type ParsedArgs,
  type SelfhostSession,
} from "./selfhostSession";
import { DeclinedError, UsageError, type CommandDeps } from "./shared";

const SUBCOMMANDS = [
  "backup",
  "install",
  "local-eval",
  "restore",
  "upgrade",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export async function executeSelfhostCommand(
  command: SelfhostCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const [subcommand, ...rest] = command.argv;

  if (subcommand === undefined || !isSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: cmpatch selfhost (${SUBCOMMANDS.join("|")}) [flags] [user@vps]`,
    );
  }

  switch (subcommand) {
    case "backup":
      return runBackup(deps, rest);
    case "install":
      if (rest.includes("--fly")) {
        return runFlyInstall(deps, rest);
      }
      // Only the summary: the server URL the outcome also carries is for
      // `cmpatch init`, which continues after the install.
      return (await runInstall(deps, rest)).summary;
    case "local-eval":
      // The one subcommand with no ssh target: the stack runs on this machine.
      return runLocalEval(deps, rest);
    case "restore":
      return runRestore(deps, rest);
    case "upgrade":
      return runUpgrade(deps, rest);
  }
}

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

const UPGRADE_FLAGS = {
  ...COMMON_FLAGS,
  "--build-from-source": "boolean",
  "--i-have-a-backup": "boolean",
  "--image": "value",
  "--local-image": "boolean",
  // Fly only: deploy the live tag again, and pick the release to deploy.
  "--redeploy": "boolean",
  "--skip-schema-check": "boolean",
  "--skip-smoke": "boolean",
  "--tag": "value",
  "--yes": "boolean",
} as const satisfies FlagShape;

/**
 * What the server's checkout is before an upgrade, read without changing it.
 *
 * - `branch`: on the default branch, the shape every install made before
 *   published images (and still the shape `--build-from-source` installs
 *   from before the first image release).
 * - `tag`: detached at a server release tag, the shape an image install
 *   leaves.
 */
type RemoteCheckout = {
  /** The branch HEAD is on, when it is on one. */
  branch: string | null;
  head: string;
  /** The server release tag HEAD is at, when it is at one. */
  headTag: string | null;
  kind: "branch" | "tag";
  /** CODEMAGIC_PATCH_SERVER_IMAGE from the deployment's env file, if any. */
  serverImage: string | null;
};

/** The server image value a source build pins: a local tag no registry has. */
const LOCAL_SERVER_IMAGE = "codemagic-patch-server:selfhost";

/** How the checkout was moved before upgrade.sh ran. */
type SourceMove = {
  newRevision: string;
  oldRevision: string;
  /** What upgrade.sh goes back to on an early failure: a branch name, else the exact commit. */
  previousRef: string;
  /** Where the checkout now is, for the summary: a tag, or the branch. */
  target: string;
};

/**
 * The image upgrade.sh will run, when it is known before the upgrade (the
 * release's or `--image`), and whether it is a local tag (`--local-image`,
 * never pulled). Null when upgrade.sh builds the image on the host.
 */
type UpgradeImage = { local: boolean; ref: string } | null;

/**
 * What the upgrade is going to do, settled by reads alone so the operator can
 * approve it before anything on the server moves.
 *
 * - `tag`: check out a release tag, from a tag or (a migration) from `main`.
 * - `fast-forward`: `main` stays `main` and is fast-forwarded:
 *   `--build-from-source`, or `--image` before any release tag is eligible.
 */
type UpgradePlan =
  | { image: UpgradeImage; kind: "fast-forward" }
  | { image: UpgradeImage; kind: "tag"; tag: string };

/** The server image the plan and the summary name. */
function upgradeImageLabel(checkout: RemoteCheckout, plan: UpgradePlan): string {
  if (plan.image !== null) {
    return plan.image.ref;
  }
  return `built from source on the host (${plan.kind === "tag" ? plan.tag : (checkout.branch ?? "main")})`;
}

async function runUpgrade(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string | null> {
  const parsed = parseArgs(argv, UPGRADE_FLAGS);
  const sshTarget = takeSingleTarget(parsed, "upgrade");

  // An explicit user@vps is always the ssh path (plan D2). Without one, a
  // server recorded as a Fly install is upgraded through flyctl instead.
  const resolved = sshTarget === undefined ? await resolveCommandTarget(deps, undefined) : undefined;
  if (resolved?.recorded.kind === "resolved-fly") {
    return runFlyUpgrade(deps, parsed, resolved.recorded.target);
  }
  for (const flag of ["--redeploy", "--tag"] as const) {
    if (parsed.flags[flag] !== undefined) {
      throw new UsageError(
        `${flag} applies to a Fly install only. An ssh server upgrades to the newest server release.`,
      );
    }
  }
  const image = readStringFlag(parsed, "--image");
  const buildFromSource = readBooleanFlag(parsed, "--build-from-source");
  const localImage = readBooleanFlag(parsed, "--local-image");
  const skipSchemaCheck = readBooleanFlag(parsed, "--skip-schema-check");
  if (image !== undefined && buildFromSource) {
    throw new UsageError(
      "--image and --build-from-source cannot be combined: one runs an image built elsewhere, the other builds it on the server. Pick one.",
    );
  }
  if (localImage && image === undefined) {
    throw new UsageError("--local-image says how to use --image; pass --image <local tag> with it.");
  }
  // Before the session opens: a run that cannot ask and was not given --yes
  // must not pair with the host first.
  const asksFirst = upgradeAsksFirst(deps, parsed);

  const session = await openSession(deps, {
    label: "cmpatch selfhost upgrade",
    parsed,
    ...(resolved !== undefined ? { resolved } : {}),
    ...(sshTarget !== undefined ? { sshTarget } : {}),
  });

  try {
    // Reads only, up to the confirmation: the inspection, the release lookup,
    // the ancestor check and the target image's schema check (which fetch and
    // pull, and move nothing).
    const checkout = await inspectRemoteCheckout(deps, session);
    const plan = await planUpgrade(deps, checkout, { buildFromSource, image, localImage });
    if (plan.kind === "tag") {
      await checkRemoteTagIsAhead(deps, session, checkout, plan.tag);
    }
    const pulled = !skipSchemaCheck && (await checkRemoteSchema(deps, session, plan, image === undefined));
    session.progress.settle();
    const approved = await confirmUpgradePlan(deps, {
      ask: asksFirst,
      ...renderUpgradePlan(session, checkout, plan, pulled),
    });
    if (!approved) {
      session.progress.stop("Nothing was changed.");
      return null;
    }

    const move =
      plan.kind === "tag"
        ? await checkOutRemoteTag(deps, session, checkout, plan.tag)
        : await fastForwardRemoteSource(deps, session, checkout);
    const args = [
      "--previous-ref",
      move.previousRef,
      ...(plan.image === null
        ? ["--build-from-source"]
        : ["--image", plan.image.ref, ...(plan.image.local ? ["--local-image"] : [])]),
    ];
    if (readBooleanFlag(parsed, "--i-have-a-backup")) {
      args.push("--i-have-a-backup");
    }
    if (readBooleanFlag(parsed, "--skip-smoke")) {
      args.push("--skip-smoke");
    }
    if (skipSchemaCheck) {
      args.push("--skip-schema-check");
    }

    // Set by upgrade.sh's first line. Until then the moved checkout is the
    // CLI's to report: upgrade.sh puts it back on an early failure, but only
    // once it is running.
    let scriptStarted = false;
    const putBack = renderPutBack(session, move);
    try {
      await runSelfhostScript(deps, session, {
        args,
        // Pre-upgrade backups land under the CLI-managed root, so they show up
        // (labelled) in `restore`'s listing instead of under <repo>/backups
        // where nothing the user runs would ever find them.
        env: {
          SELFHOST_BACKUP_ROOT: session.facts.backupRoot,
          ...sourceRepoScriptEnv(deps.env),
        },
        ...(putBack === null ? {} : { interruptNotes: [putBack] }),
        milestones: UPGRADE_MILESTONES,
        name: "upgrade",
        onOutput: (chunk) => {
          if (chunk.includes("[selfhost] previous ref:")) {
            scriptStarted = true;
          }
        },
        script: "upgrade.sh",
      });
    } catch (error) {
      if (!scriptStarted && putBack !== null && error instanceof Error) {
        error.message = `${error.message}\n\n${putBack}`;
      }
      throw error;
    }

    const summary = [
      `Upgrade complete on ${session.sshTarget}.`,
      `  Source: ${shortRevision(move.oldRevision)} → ${shortRevision(move.newRevision)} (${move.target})`,
      `  Server image: ${upgradeImageLabel(checkout, plan)}`,
    ].join("\n");
    session.progress.stop("Upgrade complete.");
    return summary;
  } catch (error) {
    session.progress.fail("Upgrade failed.");
    throw error;
  }
}

/**
 * Settles what the upgrade does, by reads alone. Without a flag: the newest
 * release's published image, under its tag (on `main`, the migration onto
 * it). `--image` and `--build-from-source` move to the newest image-install
 * tag, else a tag checkout stays at its own tag and `main` is fast-forwarded;
 * `--build-from-source` on `main` always fast-forwards and rebuilds (the
 * escape hatch the downgrade refusal names). A release tag that happens to
 * sit at a branch's HEAD is not a target: detaching there would run that
 * release's older upgrade.sh.
 */
async function planUpgrade(
  deps: CommandDeps,
  checkout: RemoteCheckout,
  flags: { buildFromSource: boolean; image: string | undefined; localImage: boolean },
): Promise<UpgradePlan> {
  if (!flags.buildFromSource && flags.image === undefined) {
    const release = await resolveLatestServerImageRelease({ env: deps.env, fetch: deps.fetch });
    return { image: { local: false, ref: release.imageRef }, kind: "tag", tag: release.tag };
  }

  const image = flags.image === undefined ? null : { local: flags.localImage, ref: flags.image };
  // A tag checkout with no eligible tag stays where it is; `main` whose HEAD
  // happens to carry a tag is still a branch and is fast-forwarded.
  const tag =
    checkout.kind === "branch" && flags.buildFromSource
      ? null
      : ((await resolveLatestServerTagForImage({ env: deps.env, runProcess: deps.runProcess })) ??
        (checkout.kind === "tag" ? checkout.headTag : null));
  return tag === null ? { image, kind: "fast-forward" } : { image, kind: "tag", tag };
}

/**
 * What the upgrade is about to do, shown before anything on the server
 * changes: where the checkout and image are, where they go, and what stays
 * the rollback ref.
 */
function renderUpgradePlan(
  session: SelfhostSession,
  checkout: RemoteCheckout,
  plan: UpgradePlan,
  pulled: boolean,
): { lines: string[]; question: string; warning?: string[] } {
  const where =
    checkout.kind === "tag" ? (checkout.headTag ?? "a release tag") : (checkout.branch ?? "main");
  const head = shortRevision(checkout.head);
  const lines = [
    `Server: ${session.sshTarget}`,
    `Current: ${where} (${head})`,
    `Current image: ${checkout.serverImage === null ? "not set in .env.selfhost" : shortImageRef(checkout.serverImage)}`,
  ];
  // The schema check pulled the target already, so the upgrade's own pull
  // finds it there.
  const targetImage = `Target image: ${shortImageRef(upgradeImageLabel(checkout, plan))}${pulled ? " (pulled for the schema check)" : ""}`;

  if (plan.kind === "fast-forward") {
    lines.push(
      `Target: ${where}, fast-forwarded from origin`,
      targetImage,
      `Checkout: ${where} moves forward in place`,
    );
    return { lines, question: `Upgrade ${session.sshTarget}?` };
  }

  lines.push(`Target: ${plan.tag}`, targetImage);
  if (plan.tag === checkout.headTag) {
    lines.push(`Checkout: stays at ${plan.tag}`);
  } else {
    // upgrade.sh goes back to a branch by name, and to a tag by its exact commit.
    lines.push(
      `Checkout: ${where} → ${plan.tag}`,
      `Rollback ref: ${checkout.kind === "branch" ? where : head}`,
    );
  }
  return {
    lines,
    question: `Upgrade ${session.sshTarget} to ${plan.tag}?`,
    // Every installer before published images left a host-built image; a
    // migration off it needs the old local images to roll back.
    ...(checkout.kind === "branch" && checkout.serverImage === LOCAL_SERVER_IMAGE
      ? {
          warning: [
            `The current image, ${LOCAL_SERVER_IMAGE}, was built on this host.`,
            "Keep the old local images until the upgrade is confirmed: rolling back runs them.",
          ],
        }
      : {}),
  };
}

/**
 * The line that puts a moved checkout back, for a run that ends before
 * upgrade.sh could do it itself (a dropped connection, Ctrl+C). Null when the
 * checkout did not move.
 */
function renderPutBack(session: SelfhostSession, move: SourceMove): string | null {
  if (move.oldRevision === move.newRevision || move.previousRef === move.target) {
    return null;
  }
  return [
    `The checkout in ${session.remotePath} was moved from ${move.previousRef} to ${move.target} before upgrade.sh started.`,
    "If upgrade.sh never ran, put it back on the server with:",
    `  git -C ${session.remotePath} checkout ${move.previousRef}`,
  ].join("\n");
}

/**
 * The same line for a run that ended while the checkout was being moved, so
 * this side never heard whether it moved.
 */
function renderPossibleMove(session: SelfhostSession, previousRef: string, tag: string): string {
  return [
    `The run ended before the server reported the move to ${tag}, so the checkout in ${session.remotePath} may have moved; previous ref is ${previousRef}.`,
    "upgrade.sh did not run. To put the checkout back, run on the server:",
    `  git -C ${session.remotePath} checkout ${previousRef}`,
  ].join("\n");
}

/**
 * Reads the checkout without touching it: a git checkout of the public repo
 * (or a fork of it, or the repository the CLI is configured to install
 * from), clean, and either on the default branch or detached at a server
 * release tag. Anything else is refused with what to fix.
 */
async function inspectRemoteCheckout(
  deps: CommandDeps,
  session: SelfhostSession,
): Promise<RemoteCheckout> {
  session.progress.write("checking the server's copy of the source");
  const sourceRepoUrl = serverSourceRepo(deps.env).url;

  const values = await runSourceScript(
    deps,
    session,
    [
      'cd "$CMPATCH_REMOTE_PATH"',
      'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
      '  printf "sync_error=not-a-checkout\\n"; exit 3',
      "fi",
      // Judged on this side (isSourceRepoOrigin), ahead of any other refusal.
      'printf "remote=%s\\n" "$(git config --get remote.origin.url || true)"',
      'if [ -n "$(git status --porcelain)" ]; then printf "sync_error=dirty\\n"; exit 3; fi',
      'branch="$(git symbolic-ref --quiet --short HEAD || true)"',
      // One release commit carries every component's tag, so the server one is
      // picked out of `--points-at`; `describe --exact-match` could name another.
      'head_tag="$(git tag --points-at HEAD | grep "^codemagic-patch-server-v" | head -n 1 || true)"',
      'server_image="$(sed -n "s/^CODEMAGIC_PATCH_SERVER_IMAGE=//p" .env.selfhost 2>/dev/null | tail -n 1 || true)"',
      'if [ -n "$branch" ]; then',
      '  default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed "s#^origin/##" || true)"',
      '  default_branch="${default_branch:-main}"',
      '  if [ "$branch" != "$default_branch" ]; then',
      '    printf "sync_error=not-default-branch\\nbranch=%s\\ndefault_branch=%s\\n" "$branch" "$default_branch"; exit 3',
      "  fi",
      '  kind=branch',
      'elif [ -n "$head_tag" ]; then',
      '  kind=tag',
      "else",
      '  printf "sync_error=detached\\n"; exit 3',
      "fi",
      'printf "kind=%s\\nbranch=%s\\nhead=%s\\nhead_tag=%s\\nserver_image=%s\\n" "$kind" "$branch" "$(git rev-parse HEAD)" "$head_tag" "$server_image"',
    ],
    {
      refuse: (reported) =>
        reported.remote === undefined || isSourceRepoOrigin(reported.remote, sourceRepoUrl)
          ? undefined
          : `${session.remotePath} on the server tracks ${reported.remote || "no origin"}, not ${sourceRepoUrl}. Fix it on the server (in ${session.remotePath}), then run the upgrade again.`,
    },
  );

  return {
    branch: values.branch || null,
    head: values.head ?? "",
    headTag: values.head_tag || null,
    kind: values.kind === "tag" ? "tag" : "branch",
    serverImage: values.server_image || null,
  };
}

/** The default branch, fast-forwarded: what every upgrade did before release tags. */
async function fastForwardRemoteSource(
  deps: CommandDeps,
  session: SelfhostSession,
  checkout: RemoteCheckout,
): Promise<SourceMove> {
  session.progress.write("updating the server's copy of the source");
  const branch = checkout.branch ?? "main";

  const values = await runSourceScript(
    deps,
    session,
    [
      'cd "$CMPATCH_REMOTE_PATH"',
      'old="$(git rev-parse HEAD)"',
      'git fetch --quiet origin "$CMPATCH_BRANCH"',
      '# --ff-only is the guard: a diverged checkout fails here rather than',
      '# being merged into something nobody reviewed.',
      'if ! git merge --ff-only "origin/${CMPATCH_BRANCH}" >/dev/null 2>&1; then',
      '  printf "sync_error=diverged\\nbranch=%s\\n" "$CMPATCH_BRANCH"; exit 3',
      "fi",
      'printf "old_revision=%s\\nnew_revision=%s\\n" "$old" "$(git rev-parse HEAD)"',
    ],
    { env: { CMPATCH_BRANCH: branch } },
  );

  const oldRevision = values.old_revision ?? "";
  const newRevision = values.new_revision ?? "";
  session.progress.write(
    oldRevision === newRevision
      ? "the server's source is already up to date"
      : `updated the source (${shortRevision(oldRevision)} → ${shortRevision(newRevision)})`,
  );

  // The branch itself: upgrade.sh then sees nothing to put back, which is
  // what this path always did — the fast-forward is not rolled back.
  return { newRevision, oldRevision, previousRef: branch, target: branch };
}

/**
 * Moves a tag checkout, or a `main` checkout being migrated, to `tag`: fetch
 * tags, refuse a target that is not a descendant of HEAD (that would run a
 * server older than its database), note the previous ref, check the tag out. The checkout moves before upgrade.sh runs, so the script
 * that runs is the target release's own.
 */
async function checkOutRemoteTag(
  deps: CommandDeps,
  session: SelfhostSession,
  checkout: RemoteCheckout,
  tag: string,
): Promise<SourceMove> {
  session.progress.write(`moving the server's copy of the source to ${tag}`);

  const values = await runSourceScript(
    deps,
    session,
    [
      'cd "$CMPATCH_REMOTE_PATH"',
      'git fetch --quiet --tags origin || { printf "sync_error=fetch\\n"; exit 3; }',
      'target="$(git rev-parse --verify --quiet "refs/tags/${CMPATCH_TAG}^{commit}" || true)"',
      'if [ -z "$target" ]; then printf "sync_error=unknown-tag\\ntag=%s\\n" "$CMPATCH_TAG"; exit 3; fi',
      'if ! git merge-base --is-ancestor HEAD "$target"; then',
      '  printf "sync_error=not-ancestor\\ntag=%s\\n" "$CMPATCH_TAG"; exit 3',
      "fi",
      'old="$(git rev-parse HEAD)"',
      'previous="$(git symbolic-ref --quiet --short HEAD || printf "%s" "$old")"',
      'git -c advice.detachedHead=false checkout --quiet "refs/tags/${CMPATCH_TAG}" || { printf "sync_error=checkout\\ntag=%s\\n" "$CMPATCH_TAG"; exit 3; }',
      'printf "previous_ref=%s\\nold_revision=%s\\nnew_revision=%s\\n" "$previous" "$old" "$(git rev-parse HEAD)"',
    ],
    {
      checkoutKind: checkout.kind,
      env: { CMPATCH_TAG: tag },
      // Settled before the move, the way the script settles `previous`: a run
      // that ends without an answer still says where the checkout was.
      ...(checkout.headTag === tag
        ? {}
        : { unknownOutcomeNote: renderPossibleMove(session, checkout.branch ?? checkout.head, tag) }),
    },
  );

  const oldRevision = values.old_revision ?? checkout.head;
  const newRevision = values.new_revision ?? "";
  session.progress.write(
    oldRevision === newRevision
      ? `the server's source is already at ${tag}`
      : `moved the source to ${tag} (${shortRevision(oldRevision)} → ${shortRevision(newRevision)})`,
  );

  return {
    newRevision,
    oldRevision,
    previousRef: values.previous_ref ?? oldRevision,
    target: tag,
  };
}

/**
 * The read-only half of a move to a release tag, run before the confirmation
 * so a move that would be refused is never asked about: fetch tags, and refuse
 * a target that is not a descendant of HEAD. On `main` that is a branch with
 * commits of its own (diverged) or one ahead of the latest tag, whose database
 * may already carry migrations the release does not know. The database itself
 * is checked after this, by `checkRemoteSchema`.
 * `checkOutRemoteTag` checks the ancestry again as it moves.
 */
async function checkRemoteTagIsAhead(
  deps: CommandDeps,
  session: SelfhostSession,
  checkout: RemoteCheckout,
  tag: string,
): Promise<void> {
  session.progress.write(`checking that ${tag} is newer than the server's source`);

  await runSourceScript(
    deps,
    session,
    [
      'cd "$CMPATCH_REMOTE_PATH"',
      'git fetch --quiet --tags origin || { printf "sync_error=fetch\\n"; exit 3; }',
      'target="$(git rev-parse --verify --quiet "refs/tags/${CMPATCH_TAG}^{commit}" || true)"',
      'if [ -z "$target" ]; then printf "sync_error=unknown-tag\\ntag=%s\\n" "$CMPATCH_TAG"; exit 3; fi',
      'if [ -n "$CMPATCH_BRANCH" ]; then',
      '  upstream="$(git rev-parse --verify --quiet "refs/remotes/origin/${CMPATCH_BRANCH}^{commit}" || true)"',
      '  if [ -n "$upstream" ] && ! git merge-base --is-ancestor HEAD "$upstream"; then',
      '    printf "sync_error=diverged\\nbranch=%s\\n" "$CMPATCH_BRANCH"; exit 3',
      "  fi",
      "fi",
      'if ! git merge-base --is-ancestor HEAD "$target"; then',
      '  if [ -n "$CMPATCH_BRANCH" ]; then',
      '    printf "sync_error=ahead-of-release\\nbranch=%s\\nhead=%s\\ntag=%s\\n" "$CMPATCH_BRANCH" "$(git rev-parse HEAD)" "$CMPATCH_TAG"',
      "  else",
      '    printf "sync_error=not-ancestor\\ntag=%s\\n" "$CMPATCH_TAG"',
      "  fi",
      "  exit 3",
      "fi",
    ],
    {
      checkoutKind: checkout.kind,
      env: {
        CMPATCH_BRANCH: checkout.kind === "branch" ? (checkout.branch ?? "main") : "",
        CMPATCH_TAG: tag,
      },
    },
  );
}

/**
 * The database half of the read-only checks, before the confirmation: the
 * server's `schema-check.sh` (run from the current checkout, which stays
 * put) pulls the image the upgrade would run and runs that image's own
 * schema check against the deployment's database. An applied migration the
 * image does not know means the database is newer than the server the
 * upgrade would start, so it is refused. A source build has no image before
 * the build: upgrade.sh checks it after the build, before the restart. A
 * checkout from before `schema-check.sh` has none to run; the target's
 * `upgrade.sh` runs the same check before it changes anything. Returns
 * whether the check pulled the target image.
 */
async function checkRemoteSchema(
  deps: CommandDeps,
  session: SelfhostSession,
  plan: UpgradePlan,
  releaseImage: boolean,
): Promise<boolean> {
  const image = plan.image;
  if (image === null) {
    session.progress.write(
      "the server checks its database with the built image's schema check after the build, before restarting anything",
    );
    return false;
  }
  // How the target is named in a refusal: the release, or the image itself.
  const target = releaseImage && plan.kind === "tag" ? plan.tag : shortImageRef(image.ref);
  session.progress.write(
    image.local
      ? `checking the server's database with the schema check of ${target}`
      : `pulling ${target} on the server and checking its database with that image's schema check`,
  );

  const values = await runSourceScript(
    deps,
    session,
    [
      'cd "$CMPATCH_REMOTE_PATH"',
      'if [ ! -x scripts/selfhost/schema-check.sh ]; then printf "schema_check=unavailable\\n"; exit 0; fi',
      'set -- --image "$CMPATCH_IMAGE"',
      'if [ -n "$CMPATCH_LOCAL_IMAGE" ]; then set -- "$@" --local-image; fi',
      'schema_err="$(mktemp)"',
      "schema_status=0",
      'scripts/selfhost/schema-check.sh "$@" 2>"$schema_err" || schema_status=$?',
      // The script's own last line, for a failure that is not one of its
      // reported states (no env file, no docker).
      'printf "schema_detail=%s\\n" "$(sed -n "s/^\\[selfhost\\] FAIL: //p" "$schema_err" | tail -n 1)"',
      'rm -f "$schema_err"',
      'exit "$schema_status"',
    ],
    {
      env: { CMPATCH_IMAGE: image.ref, CMPATCH_LOCAL_IMAGE: image.local ? "1" : "" },
      refuse: (reported) => describeSchemaRefusal(reported, target, shortImageRef(image.ref)),
    },
  );

  if (values.schema_check === "unavailable") {
    session.progress.write(
      "the server's scripts predate the schema check; the target's upgrade.sh runs it before changing anything",
    );
    return false;
  }
  session.progress.write(`the server's database has no migration ${target} does not know`);
  return !image.local;
}

/** The schema check's refusal, mirroring upgrade.sh's; undefined when it passed. */
function describeSchemaRefusal(
  values: Record<string, string>,
  target: string,
  imageRef: string,
): string | undefined {
  const skip =
    "pass --skip-schema-check to upgrade without this check (unsafe: nothing then stops an older server from starting on a newer schema)";
  switch (values.schema_check) {
    case "ok":
    case "unavailable":
      return undefined;
    case "unknown": {
      const names = (values.unknown_migrations ?? "").split(" ").filter(Boolean).join(", ");
      return `The server's database has migrations ${target} does not know (${names}); running it would run an older server on a newer schema. Nothing was changed. Wait for a release that includes them, or restore the database from the backup taken before they were applied (cmpatch selfhost restore --restore-env).`;
    }
    case "unreachable":
      return `Could not read the server's database migration state (${values.schema_error || "no detail"}). Nothing was changed. Start the stack on the server and run the upgrade again, or ${skip}.`;
    case "unsupported":
      return `The server image ${imageRef} predates the schema check (it needs 0.10.0 or newer). Nothing was changed. To upgrade to it anyway, ${skip}.`;
    case "error":
      return `Could not run the schema check of ${target} on the server (${values.schema_error || values.schema_detail || "no detail"}). Nothing was changed. Fix it on the server and run the upgrade again, or ${skip}.`;
    default:
      // The script stopped before reporting a state.
      if (values.schema_detail === undefined) {
        return undefined;
      }
      return `Could not check the server's database against ${target}${values.schema_detail ? ` (${values.schema_detail})` : ""}. Nothing was changed. Fix it on the server and run the upgrade again, or ${skip}.`;
  }
}

/**
 * Runs one of the checkout scripts and returns its key=value lines, or throws
 * its refusal. `unknownOutcomeNote` is added to a failure the script did not
 * name (a dropped connection, ssh failing to start): the script may have got
 * further than anything this side saw. `checkoutKind` picks the way forward a
 * refusal offers, where that depends on the checkout.
 */
async function runSourceScript(
  deps: CommandDeps,
  session: SelfhostSession,
  body: readonly string[],
  options: {
    checkoutKind?: RemoteCheckout["kind"];
    env?: Record<string, string>;
    /** A refusal judged from the reported values, ahead of the script's own. */
    refuse?: (values: Record<string, string>) => string | undefined;
    unknownOutcomeNote?: string;
  } = {},
): Promise<Record<string, string>> {
  const withNote = (message: string): string =>
    options.unknownOutcomeNote === undefined ? message : `${message}\n\n${options.unknownOutcomeNote}`;

  let result: Awaited<ReturnType<typeof captureRemoteShell>>;
  try {
    result = await captureRemoteShell({
      body: body.join("\n"),
      connection: pairedSshInvocation(session.sshTarget, session.identityFile),
      env: { CMPATCH_REMOTE_PATH: session.remotePath, ...options.env },
      runProcess: deps.runProcess,
    });
  } catch (error) {
    if (error instanceof Error) {
      error.message = withNote(error.message);
    }
    throw error;
  }

  const values: Record<string, string> = {};
  for (const line of result.output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }

  const refusal = options.refuse?.(values);
  if (refusal !== undefined) {
    throw new UsageError(refusal);
  }
  if (result.exitCode !== 0) {
    const message = describeSyncFailure(values, session.remotePath, result.output, options.checkoutKind);
    throw new UsageError(values.sync_error === undefined ? withNote(message) : message);
  }
  return values;
}

function describeSyncFailure(
  values: Record<string, string>,
  remotePath: string,
  rawOutput: string,
  checkoutKind?: RemoteCheckout["kind"],
): string {
  const fixByHand = `Fix it on the server (in ${remotePath}), then run the upgrade again.`;

  switch (values.sync_error) {
    case "not-a-checkout":
      return `${remotePath} on the server is not a git checkout, so the upgrade cannot tell which version it runs. Reinstall from a clone of ${SOURCE_REPO_URL}.`;
    case "detached":
      return `${remotePath} on the server is neither on a branch nor at a codemagic-patch-server-v* release tag (detached HEAD), so the upgrade cannot tell which release it runs. ${fixByHand}`;
    case "dirty":
      return `${remotePath} on the server has uncommitted changes. The upgrade runs the compose files and scripts from this checkout, so it will not move a tree with edits it cannot account for. ${fixByHand}`;
    case "not-default-branch":
      return `${remotePath} on the server is on ${values.branch ?? "another branch"}, not ${values.default_branch ?? "the default branch"}. Upgrades move the default branch or a release tag only. ${fixByHand}`;
    case "diverged":
      return `${remotePath} on the server has commits that are not in ${SOURCE_REPO_URL}, so it cannot be fast-forwarded. ${fixByHand}`;
    case "fetch":
      return `could not fetch the release tags into ${remotePath} on the server. Check that the server can reach ${SOURCE_REPO_URL}, then run the upgrade again.`;
    case "unknown-tag":
      return `${values.tag ?? "The release tag"} is not in ${remotePath} on the server even after fetching tags. Run the upgrade again; if it persists, check the checkout's origin.`;
    case "not-ancestor": {
      const refusal = `The server's checkout in ${remotePath} is not an ancestor of ${values.tag ?? "the latest release"}, so moving to it would run a server older than the one the database was migrated by. Nothing was changed.`;
      // On a tag checkout the CLI's --build-from-source still targets the
      // latest release and is refused the same way; upgrade.sh run on the
      // server keeps the checkout it has.
      return checkoutKind === "tag"
        ? `${refusal} Wait for the next release, or upgrade the checkout you have from the server itself: cd ${remotePath} && scripts/selfhost/upgrade.sh --build-from-source (or --image <ref> to run an image built elsewhere).`
        : `${refusal} Wait for the next release, or rerun with --build-from-source to build the checkout you have.`;
    }
    case "ahead-of-release":
      return `This install runs ${shortRevision(values.head ?? "")} on ${values.branch ?? "main"}, which is newer than the latest release ${values.tag ?? ""}; upgrading would downgrade the server under a newer database. Nothing was changed. Wait for the next release, or rerun with --build-from-source to rebuild from ${values.branch ?? "main"}.`;
    case "checkout":
      return `could not check out ${values.tag ?? "the release tag"} in ${remotePath} on the server. ${fixByHand}`;
    default:
      return `could not update the server's copy of the source in ${remotePath}.\n\n${rawOutput.trim()}`;
  }
}

/**
 * Whether a checkout's origin is a repository the upgrade may move: anything
 * named like the product (the public repo or a fork of it), or the
 * repository the CLI installs from (`CMPATCH_TEST_SOURCE_REPO` points it at a
 * scratch repo of any name), in its https or ssh form, with or without `.git`.
 */
function isSourceRepoOrigin(remoteUrl: string, sourceRepoUrl: string): boolean {
  if (remoteUrl.includes("codemagic-patch")) {
    return true;
  }
  const remote = gitRepositoryPath(remoteUrl);
  return remote !== null && remote === gitRepositoryPath(sourceRepoUrl);
}

/** `host/owner/name`, lowercased, for a git URL in scheme or scp-like form. */
function gitRepositoryPath(url: string): string | null {
  const trimmed = url.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(trimmed);
  const scpLike = withScheme === null ? /^(?:[^@/]*@)?([^/:]+):(.+)$/.exec(trimmed) : null;
  const match = withScheme ?? scpLike;
  if (match === null) {
    return null;
  }
  return `${match[1] ?? ""}/${(match[2] ?? "").replace(/^\/+/, "")}`;
}

function shortRevision(revision: string): string {
  return revision.length >= 7 ? revision.slice(0, 7) : revision || "unknown";
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

const BACKUP_FLAGS = {
  ...COMMON_FLAGS,
  "--download": "boolean",
  "--yes": "boolean",
} as const satisfies FlagShape;

async function runBackup(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, BACKUP_FLAGS);
  const sshTarget = takeSingleTarget(parsed, "backup");

  // As for upgrade: an explicit user@vps is the ssh path, and without one a
  // server recorded as a Fly install is backed up through flyctl.
  const resolved = sshTarget === undefined ? await resolveCommandTarget(deps, undefined) : undefined;
  if (resolved?.recorded.kind === "resolved-fly") {
    return runFlyBackup(deps, parsed, resolved.recorded.target);
  }

  const session = await openSession(deps, {
    label: "cmpatch selfhost backup",
    parsed,
    ...(resolved !== undefined ? { resolved } : {}),
    ...(sshTarget !== undefined ? { sshTarget } : {}),
  });

  try {
    // Before the warning, before the confirmation, before anything runs on the
    // server: an older checkout cannot take this backup at all, and the user
    // must not be asked to approve a pause that is going to fail.
    requireDirectoryCapableBackupScript(session);

    const interactive = canAsk(deps, parsed);

    if (interactive && !readBooleanFlag(parsed, "--yes")) {
      session.progress.settle();
      writeNotice(deps, renderBackupIntro(session.coverage));

      const confirmed = await (deps.confirm?.({
        initial: true,
        message: "Continue?",
      }) ?? Promise.resolve(true));
      if (!confirmed) {
        // Declined before anything ran remotely: the pause the user was
        // warned about never happens.
        throw new DeclinedError("Backup cancelled.");
      }
    }

    const directory = `${session.facts.backupRoot}/${utcStamp(deps.now())}`;

    await runSelfhostScript(deps, session, {
      args: ["--directory", directory],
      env: { SELFHOST_BACKUP_ROOT: session.facts.backupRoot },
      milestones: BACKUP_MILESTONES,
      name: "backup",
      script: "backup.sh",
    });

    const lines = [
      `Backup saved on the server:`,
      `  ${directory}`,
    ];

    // --yes means "ask me nothing", so it takes the flags-only answer here too:
    // a download happens because --download said so, never because a run that
    // was told not to ask asked anyway.
    let download = readBooleanFlag(parsed, "--download");
    if (!download && interactive && !readBooleanFlag(parsed, "--yes")) {
      // The script's last milestone is still animating; a prompt over a live
      // spinner corrupts both.
      session.progress.settle();
      download =
        (await deps.confirm?.({
          initial: true,
          message: "Also download a copy to this machine?",
        })) ?? false;
    }

    if (download) {
      const localPath = await downloadBackup(deps, session, directory);
      lines.push("", "Downloaded to:", `  ${localPath}`);
    }

    lines.push(
      "",
      "Restore any time with: cmpatch selfhost restore",
    );
    session.progress.stop("Backup complete.");
    return lines.join("\n");
  } catch (error) {
    session.progress.fail("Backup failed.");
    throw error;
  }
}

/**
 * Refuses a backup the server's own scripts cannot take.
 *
 * `backup` names the exact output directory (`--directory`), and every
 * deployment installed before that flag existed has a `backup.sh` that reads
 * it as the positional backup root and dies inside `mkdir`. The alternative —
 * falling back to a bare positional run — would put the CLI back to guessing
 * which of the directories the script created is the one it just made, which
 * is the newest-directory guess this design exists to avoid. So the skew is
 * named instead, with both routes out of it — the upgrade, and the by-hand run
 * for the dirty or diverged checkout the upgrade itself refuses — and nothing
 * runs.
 *
 * Only a definite "no" refuses: a checkout whose `backup.sh` the probe could
 * not read, or that has none at all, reports null, and its own failure says
 * more than a version-skew message would.
 */
function requireDirectoryCapableBackupScript(session: SelfhostSession): void {
  if (session.facts.backupScriptSupportsDirectory !== false) {
    return;
  }

  throw new UsageError(
    [
      `The scripts on ${session.sshTarget} are older than this copy of cmpatch, so they cannot take this backup: ${session.remotePath}/scripts/selfhost/backup.sh does not understand the --directory option this command uses to name the backup's exact location.`,
      "",
      "Update the server first, then take the backup:",
      "  cmpatch selfhost upgrade",
      "  cmpatch selfhost backup",
      "",
      "The upgrade takes its own backup before it changes anything, so nothing is at risk.",
      "",
      `If the upgrade cannot run — it refuses a checkout with local changes — ssh to ${session.sshTarget} and run the old script by hand: ${session.remotePath}/scripts/selfhost/backup.sh ${session.facts.backupRoot}`,
    ].join("\n"),
  );
}

async function downloadBackup(
  deps: CommandDeps,
  session: SelfhostSession,
  remoteDirectory: string,
): Promise<string> {
  const host = session.sshTarget.slice(session.sshTarget.lastIndexOf("@") + 1);
  const localRoot = localBackupRoot(host);
  const localPath = join(localRoot, remoteDirectory.slice(remoteDirectory.lastIndexOf("/") + 1));

  session.progress.write("downloading");
  // 0700 all the way down: a backup holds the deployment's env file, and that
  // holds every generated secret.
  await mkdir(localRoot, { mode: 0o700, recursive: true });

  const result = await deps.runProcess({
    args: assembleScpArgs(
      pairedSshInvocation(session.sshTarget, session.identityFile),
      [
        formatScpRemotePath(session.sshTarget, remoteDirectory),
        localPath,
      ],
    ),
    command: "scp",
    onOutput: (chunk) => session.progress.detail(chunk.trim()),
  });

  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `the backup was created on the server but could not be downloaded (scp exited with status ${String(
        result.exitCode ?? 1,
      )}). The server-side copy is intact at ${remoteDirectory}.`,
    );
  }

  // Reported only after a verified transfer: an empty directory reported as a
  // downloaded backup is worse than no download at all.
  try {
    await stat(join(localPath, "env.selfhost"));
  } catch {
    throw new RemoteScriptFailure(
      `the download finished but ${localPath} does not contain a backup. The server-side copy is intact at ${remoteDirectory}.`,
    );
  }

  return localPath;
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

const RESTORE_FLAGS = {
  ...COMMON_FLAGS,
  "--restore-env": "boolean",
  // Accepted for parity with restore.sh (the plan says the script's flags pass
  // through), though it is also the default: an operator carrying flags over
  // from a direct restore.sh run must not hit an unknown-flag error.
  "--skip-smoke": "boolean",
  "--smoke": "boolean",
  "--yes": "boolean",
} as const satisfies FlagShape;

/** Mirrors the server's API_TOKEN_PREFIX; a PAT is the only credential --smoke can use. */
const API_TOKEN_PREFIX = "cm_pat_";

/** Cannot collide with a real path: a NUL never survives a filesystem. */
const LOCAL_BACKUP_CHOICE = "\0local";

async function runRestore(
  deps: CommandDeps,
  argv: readonly string[],
): Promise<string> {
  const parsed = parseArgs(argv, RESTORE_FLAGS);
  const { backup, sshTarget } = splitRestorePositionals(parsed);

  // As for upgrade and backup: an explicit user@vps is the ssh path, and
  // without one a server recorded as a Fly install is restored through
  // flyctl, from a Fly backup on this machine.
  if (sshTarget === undefined) {
    const { recorded } = await resolveCommandTarget(deps, undefined);
    if (recorded.kind === "resolved-fly") {
      return runFlyRestore(deps, parsed, recorded.target, backup);
    }
  }

  const interactive = canAsk(deps, parsed);

  // Checked before anything connects: a run that cannot possibly proceed must
  // not first pair with a host and probe it.
  if (!interactive && backup === undefined) {
    throw new UsageError(
      "Which backup? Pass its directory on the server: cmpatch selfhost restore <backup> --yes",
    );
  }

  if (!interactive && !readBooleanFlag(parsed, "--yes")) {
    throw new UsageError(
      "cmpatch selfhost restore replaces the server's data. Pass --yes to confirm in a non-interactive run.",
    );
  }

  if (
    readBooleanFlag(parsed, "--smoke") &&
    readBooleanFlag(parsed, "--skip-smoke")
  ) {
    throw new UsageError("--smoke and --skip-smoke are mutually exclusive.");
  }

  const session = await openSession(deps, {
    label: "cmpatch selfhost restore",
    parsed,
    ...(sshTarget !== undefined ? { sshTarget } : {}),
  });

  let staged: string | null = null;
  // The staged copy is removed on success, failure, AND interruption (the
  // plan's 1e promise): the finally below covers the first two, and this hook
  // covers Ctrl-C / SIGTERM during the upload or the remote run, where Node's
  // default handler would exit without unwinding the stack — leaving a full
  // backup, secrets included, in the server's /tmp. A cleanup hook rather
  // than a signal listener because the run animates a spinner for both, and
  // under one the press never becomes a signal.
  const removeInterruptHook = onInterruptCleanup(async () => {
    if (staged !== null) {
      await cleanUpStagedBackup(deps, session, staged);
    }
  });

  try {
    let selected = backup ?? null;

    // The picker titles and `backup`'s own summary surface bare directory
    // names, and restore.sh resolves a relative path against its cwd (the
    // checkout) — so a name is anchored to the root the backups actually
    // live under.
    if (selected !== null && !selected.startsWith("/")) {
      selected = `${session.facts.backupRoot}/${selected}`;
    }
    let selectedBackup: RemoteBackup | null = null;

    if (selected === null) {
      const backups = await listRemoteBackups({
        backupRoot: session.facts.backupRoot,
        identityFile: session.identityFile,
        runProcess: deps.runProcess,
        sshTarget: session.sshTarget,
      });

      session.progress.settle();
      const choice = await promptBackupChoice(deps, backups);
      if (choice === LOCAL_BACKUP_CHOICE) {
        selected = await stageLocalBackup(deps, session, (path) => {
          staged = path;
        });
      } else {
        selected = choice;
        selectedBackup = backups.find((entry) => entry.path === choice) ?? null;
      }
    }

    const guided = interactive && !readBooleanFlag(parsed, "--yes");
    let restoreEnv = readBooleanFlag(parsed, "--restore-env");

    if (guided) {
      session.progress.settle();
      writeNotice(
        deps,
        renderRestoreConsequence({
          coverage: session.coverage,
          createdAt: selectedBackup?.createdAt ?? null,
        }),
      );

      // The settings question runs *before* the typed gate, never after it:
      // the gate is the strongest confirmation this command family has, and a
      // yes taken afterwards would replace this server's domains and keys with
      // the backup's without anything left to approve that. The flag form
      // answers it already, so it is only asked when it is still open.
      if (!restoreEnv) {
        restoreEnv =
          (await deps.confirm?.({
            initial: false,
            message:
              "Also restore the settings file? Usually no — this keeps your current domains and keys.",
          })) ?? false;
      }
    }

    // A restore with nothing left in its scope is refused rather than run — and
    // refused *before* the typed gate, which exists to approve a destructive
    // change and must never be asked for a no-op. On a fully external
    // deployment the backup holds only the settings file, so without
    // --restore-env `restore.sh` puts nothing back, yet it would still stop the
    // stack, take a safety backup, and let the CLI report "your data is
    // restored". The settings answer is the only thing that can fill the scope,
    // so this sits directly after it and covers the flags-only path too. It is
    // a usage problem because the remedy is a flag or the provider's own
    // tooling, like this command's other refusals.
    if (describeRestoredComponents(session.coverage, restoreEnv).length === 0) {
      throw new UsageError(renderRestoreNoOp(session.coverage));
    }

    if (guided) {
      // The gate states the scope it is approving.
      writeNotice(deps, renderRestoreScope(restoreEnv));
      await confirmTypedRestore(deps);
    }

    const args = ["-y", selected];
    if (restoreEnv) {
      args.push("--restore-env");
    }

    // The publish smoke is skipped by default, and no token is refreshed.
    // `restore.sh` documents a PAT; what the CLI holds is an OAuth access
    // token whose row lives in the very database this restore replaces, so it
    // cannot survive the restore AND still be inside its 900-second TTL when
    // the smoke runs. `--smoke` is the opt-in for the one credential that can
    // work: a PAT that already existed when the backup was taken.
    const smoke = readBooleanFlag(parsed, "--smoke");
    // The operator's own PAT, from the environment, travelling as an env
    // assignment on stdin like every other secret. Without it `smoke.sh`
    // silently degrades to unauthenticated checks and tells the user to sign in
    // and rerun, which would make --smoke claim a publish check it never ran.
    const smokeToken = smoke ? readSmokeToken(deps) : undefined;
    if (!smoke) {
      args.push("--skip-smoke");
    } else {
      // Printed on every --smoke run, interactive or not. This is information,
      // not a prompt, and the run that needs it most is the scripted one: when
      // the smoke fails, restore.sh prints its own rollback command for a
      // restore that has in fact completed, and this line is the only thing
      // standing between the operator and undoing good data. On the --yes
      // path nothing has settled the survey spinner yet, and its redraw would
      // erase exactly this line.
      session.progress.settle();
      writeNotice(
        deps,
        "the publish check only works with a token that already existed when this backup was taken. If it fails, the restore itself may still have completed: open the dashboard before running any rollback command.",
      );
    }

    await runSelfhostScript(deps, session, {
      args,
      env: {
        SELFHOST_BACKUP_ROOT: session.facts.backupRoot,
        ...(smokeToken !== undefined
          ? { CODEMAGIC_PATCH_TOKEN: smokeToken }
          : {}),
      },
      milestones: RESTORE_MILESTONES,
      name: "restore",
      script: "restore.sh",
    });

    const anchor = selectedBackup?.createdAt ?? null;
    const lines = [
      session.serverUrl === null
        ? "Restore complete."
        : `Restore complete — ${session.serverUrl}${
            anchor === null ? "" : ` is now at the state of ${anchor}`
          }.`,
    ];

    if (!smoke) {
      // Named as a deferred step rather than shown as a green check the CLI
      // could not earn.
      lines.push(
        "",
        "Your data is restored. Sign in again with `cmpatch login`, then publish a release to confirm end to end.",
      );
    }

    session.progress.stop("Restore complete.");
    return lines.join("\n");
  } catch (error) {
    session.progress.fail("Restore failed.");
    throw error;
  } finally {
    removeInterruptHook();
    if (staged !== null) {
      await cleanUpStagedBackup(deps, session, staged);
    }
  }
}

/**
 * `--smoke` needs a credential the CLI cannot mint.
 *
 * The one credential that can authenticate a post-restore publish check is a
 * personal access token that already existed when the backup was taken, so it
 * survives the restore as a row in the restored database. The CLI cannot prove
 * that (api_token rows are in that same database and the stored value carries
 * no creation time), which is why the flag warns about the condition instead of
 * checking it. What it can do is refuse the two cases that are certainly wrong:
 * no token at all, and a token that is not a PAT.
 */
function readSmokeToken(deps: CommandDeps): string {
  const token = deps.env.CODEMAGIC_PATCH_TOKEN?.trim();

  if (token === undefined || token.length === 0) {
    throw new UsageError(
      [
        "--smoke needs a personal access token that already existed when this backup was taken.",
        "",
        "Supply it as CODEMAGIC_PATCH_TOKEN:",
        "  CODEMAGIC_PATCH_TOKEN=cm_pat_... cmpatch selfhost restore --smoke",
        "",
        "A token created after the backup cannot work: the restore replaces the database its row lives in. Without --smoke the restore still completes, and the publish check becomes a next step.",
      ].join("\n"),
    );
  }

  if (!token.startsWith(API_TOKEN_PREFIX)) {
    throw new UsageError(
      `CODEMAGIC_PATCH_TOKEN does not look like a personal access token (it should start with ${API_TOKEN_PREFIX}). A browser sign-in token cannot authenticate a post-restore check: its row lives in the database the restore replaces.`,
    );
  }

  return token;
}

function splitRestorePositionals(parsed: ParsedArgs): {
  backup?: string;
  sshTarget?: string;
} {
  const positionals = parsed.positionals;
  if (positionals.length > 2) {
    throw new UsageError(
      "Usage: cmpatch selfhost restore [backup] [user@vps]",
    );
  }

  const targets = positionals.filter((value) => looksLikeSshTarget(value));
  const others = positionals.filter((value) => !looksLikeSshTarget(value));

  if (targets.length > 1) {
    throw new UsageError("Only one server address may be given");
  }

  if (positionals.length === 2 && targets.length === 0) {
    throw new UsageError(
      "The server address must include the login user, as in ubuntu@203.0.113.7, so it can be told apart from the backup directory",
    );
  }

  return {
    ...(others[0] !== undefined ? { backup: others[0] } : {}),
    ...(targets[0] !== undefined ? { sshTarget: targets[0] } : {}),
  };
}

async function promptBackupChoice(
  deps: CommandDeps,
  backups: readonly RemoteBackup[],
): Promise<string> {
  if (deps.prompt === undefined) {
    throw new UsageError(
      "Which backup? Pass its directory on the server: cmpatch selfhost restore <backup>",
    );
  }

  const choices = backups.map((backup) => ({
    title: `${backup.name}  (${formatSize(backup.sizeBytes)}, ${describeBackupOrigin(backup)})`,
    value: backup.path,
  }));
  choices.push({
    title: "a backup folder on this machine…",
    value: LOCAL_BACKUP_CHOICE,
  });

  const answer = await deps.prompt({
    choices,
    message: "Which backup do you want to restore?",
    type: "select",
  });

  return typeof answer === "string" ? answer : (answer[0] ?? "");
}

/**
 * Which family a listed backup belongs to. The scripts' safety backups share
 * one naming scheme and land in subdirectories of the same root, so without
 * this a pre-upgrade and a pre-restore backup taken the same second would be
 * indistinguishable in the picker.
 */
function describeBackupOrigin(backup: RemoteBackup): string {
  switch (backup.category) {
    case null:
      return "on the server";
    case "pre-upgrade":
      return "safety backup taken before an upgrade";
    case "pre-restore":
      return "safety backup taken before a restore";
    default:
      return `in ${backup.category}/ on the server`;
  }
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) {
    return "size unknown";
  }

  const megabytes = sizeBytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

/**
 * Copies a local backup folder to a remote `mktemp -d` so `restore.sh` — which
 * only ever reads a directory on its own host — can use it. Removed again on
 * success, failure, and interruption alike: `onStaged` hands the path to the
 * caller the moment the remote directory exists — before the upload, which is
 * exactly the long phase an interruption is most likely to land in — and the
 * caller's finally / interrupt hook own the cleanup from then on.
 */
async function stageLocalBackup(
  deps: CommandDeps,
  session: SelfhostSession,
  onStaged: (path: string) => void,
): Promise<string> {
  if (deps.prompt === undefined) {
    throw new UsageError("Pass the backup folder as an argument");
  }

  const answer = await deps.prompt({
    message: "Path to the backup folder on this machine",
    type: "text",
  });
  const localPath = resolve(
    process.cwd(),
    typeof answer === "string" ? answer : (answer[0] ?? ""),
  );

  // Validated before anything is uploaded: a folder that is not a backup would
  // otherwise be rejected by restore.sh minutes later, after a slow transfer.
  try {
    await stat(join(localPath, "env.selfhost"));
  } catch {
    throw new UsageError(
      `${localPath} does not look like a ${PRODUCT_NAME} backup (it has no env.selfhost).`,
    );
  }

  const entries = await readdir(localPath);
  if (entries.length === 0) {
    throw new UsageError(`${localPath} is empty.`);
  }

  session.progress.write("uploading the backup to the server");
  const staging = await captureRemoteShell({
    body: 'mktemp -d "${TMPDIR:-/tmp}/cmpatch-restore.XXXXXX"',
    connection: pairedSshInvocation(session.sshTarget, session.identityFile),
    runProcess: deps.runProcess,
  });

  const stagingRoot = staging.output.trim().split("\n").pop()?.trim() ?? "";
  if (staging.exitCode !== 0 || !isAbsolute(stagingRoot)) {
    throw new RemoteScriptFailure(
      `could not create a staging directory on ${session.sshTarget}.`,
    );
  }

  const remotePath = `${stagingRoot}/backup`;
  onStaged(remotePath);

  const result = await deps.runProcess({
    args: assembleScpArgs(
      pairedSshInvocation(session.sshTarget, session.identityFile),
      [localPath, formatScpRemotePath(session.sshTarget, remotePath)],
    ),
    command: "scp",
    onOutput: (chunk) => session.progress.detail(chunk.trim()),
  });

  if (result.exitCode !== 0) {
    throw new RemoteScriptFailure(
      `could not upload ${localPath} to ${session.sshTarget} (scp exited with status ${String(
        result.exitCode ?? 1,
      )}).`,
    );
  }

  return remotePath;
}

async function cleanUpStagedBackup(
  deps: CommandDeps,
  session: SelfhostSession,
  stagedPath: string,
): Promise<void> {
  try {
    await captureRemoteShell({
      // The parent is the mktemp -d directory this CLI created; nothing else
      // ever lives there, and the guard keeps a malformed path from widening
      // the delete.
      body: [
        'case "$CMPATCH_STAGED" in',
        "  */cmpatch-restore.*/backup) rm -rf \"$CMPATCH_STAGED\" \"${CMPATCH_STAGED%/backup}\" ;;",
        "esac",
      ].join("\n"),
      connection: pairedSshInvocation(session.sshTarget, session.identityFile),
      env: { CMPATCH_STAGED: stagedPath },
      runProcess: deps.runProcess,
    });
  } catch {
    // Best effort: a leftover temp directory is not worth failing a completed
    // restore over, and the message would land after the outcome anyway.
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}
