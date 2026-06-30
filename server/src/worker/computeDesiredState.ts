import { compare as compareSemver, valid as validSemver } from "semver";

import type { Release, ReleaseId } from "../domain/types";
import {
  makeBundleInternalKey,
  makeBundlePublicKey,
  makeDeploymentMetaPublicKey,
  makeFallbackManifestPublicKey,
  makeManifestPublicKey,
  makePatchInternalKey,
  makePatchPublicKey,
} from "./artifactKeys";
import { selectLatestBinaryVersion } from "./binaryVersionPrecedence";
import type {
  DesiredBundle,
  DesiredBundlePublicKey,
  DesiredDeploymentMetaDraft,
  DesiredManifestDraft,
  DesiredPatch,
  DesiredStateDraft,
  KnownHashSet,
  ManifestContentDraft,
  PreviousPackageInfoDraft,
  ReconcileContext,
  ResolvedTarget,
} from "./types";

export function computeDesiredState(context: ReconcileContext): DesiredStateDraft {
  const targetPackageHash = requireTargetPackageHash(context);
  const activeTargetIdsByVersion = collectTargetIdsByVersion(context.activeTargetsByBinaryVersion);
  const historicalTargetIdsByVersion = collectTargetIdsByVersion(
    context.historicalTargetsByBinaryVersion,
  );
  const resolvedTargets = resolveReconcileTargets(context);
  const resolvedTargetVersions = new Set(resolvedTargets.map((target) => target.binaryVersion));
  const effectiveReleases = buildEffectivePublishedReleases(context);
  const effectiveVersions = collectEffectiveVersions(
    context,
    effectiveReleases,
    activeTargetIdsByVersion,
    resolvedTargetVersions,
  );
  const previousActiveVersions = new Set(
    context.previousActiveTargets.map((target) => target.binaryVersion),
  );
  const manifestVersions = sortBinaryVersions(
    new Set([...effectiveVersions, ...previousActiveVersions]),
  );

  const knownHashSets = new Map<string, KnownHashSet>();
  for (const binaryVersion of sortBinaryVersions(
    new Set([...resolvedTargetVersions, ...manifestVersions]),
  )) {
    knownHashSets.set(
      binaryVersion,
      buildKnownHashSet(
        context,
        binaryVersion,
        historicalTargetIdsByVersion,
        resolvedTargetVersions,
      ),
    );
  }

  const desiredBundle = buildDesiredBundle(
    context,
    targetPackageHash,
    resolvedTargets,
  );
  const desiredPatches = buildDesiredPatches(
    context,
    targetPackageHash,
    resolvedTargets,
    knownHashSets,
    historicalTargetIdsByVersion,
  );
  const patchLookup = new Set(desiredPatches.map((patch) => makePatchLookupKey(patch)));
  const desiredManifests = buildDesiredManifests(
    context,
    manifestVersions,
    effectiveReleases,
    historicalTargetIdsByVersion,
    resolvedTargetVersions,
    knownHashSets,
    patchLookup,
  );
  const desiredDeploymentMeta = buildDesiredDeploymentMeta(context, effectiveVersions);

  return {
    bundle: desiredBundle,
    deploymentMeta: desiredDeploymentMeta,
    manifests: desiredManifests,
    patches: desiredPatches,
  };
}

function requireTargetPackageHash(context: ReconcileContext): string {
  if (!context.release.targetPackageHash) {
    throw new Error("computeDesiredState requires release.targetPackageHash to be set");
  }

  return context.release.targetPackageHash;
}

export function resolveReconcileTargets(context: ReconcileContext): ResolvedTarget[] {
  const targets = new Map<string, ResolvedTarget>();
  const explicitBinaryVersion = context.release.targetBinaryVersion;

  targets.set(explicitBinaryVersion, {
    binaryVersion: explicitBinaryVersion,
    fingerprint: resolveKnownFingerprint(context, explicitBinaryVersion) ?? context.release.fingerprint,
    resolutionSource: "explicit",
  });

  for (const [binaryVersion, fingerprint] of context.inferredFingerprints) {
    if (fingerprint !== context.release.fingerprint) {
      continue;
    }
    if (binaryVersion === explicitBinaryVersion) {
      continue;
    }
    if (targets.has(binaryVersion)) {
      continue;
    }

    targets.set(binaryVersion, {
      binaryVersion,
      fingerprint,
      resolutionSource: "fingerprint",
    });
  }

  return sortBinaryVersions(targets.keys()).map((binaryVersion) => {
    const target = targets.get(binaryVersion);
    if (!target) {
      throw new Error(`Missing resolved target for binary version ${binaryVersion}`);
    }
    return target;
  });
}

function resolveKnownFingerprint(
  context: ReconcileContext,
  binaryVersion: string,
): string | null {
  return context.inferredFingerprints.get(binaryVersion) ?? null;
}

function collectTargetIdsByVersion(
  targetsByBinaryVersion: Map<string, { releaseId: ReleaseId }[]>,
): Map<string, Set<ReleaseId>> {
  const idsByVersion = new Map<string, Set<ReleaseId>>();

  for (const [binaryVersion, targets] of targetsByBinaryVersion) {
    const ids = idsByVersion.get(binaryVersion) ?? new Set<ReleaseId>();
    for (const target of targets) {
      ids.add(target.releaseId);
    }
    idsByVersion.set(binaryVersion, ids);
  }

  return idsByVersion;
}

function buildEffectivePublishedReleases(context: ReconcileContext): Release[] {
  const releases = context.publishedReleases.filter(
    (release) => release.id !== context.release.id && release.status === "published",
  );

  if (shouldServeCurrentRelease(context)) {
    releases.push(context.release);
  }

  return releases.sort(compareReleasesDesc);
}

function shouldServeCurrentRelease(context: ReconcileContext): boolean {
  const { job, release } = context;

  if (job.triggerType === "release_enabled" && release.status === "disabled") {
    return true;
  }

  return (
    release.status === "uploaded" ||
    release.status === "processing" ||
    release.status === "published"
  );
}

function collectEffectiveVersions(
  context: ReconcileContext,
  effectiveReleases: Release[],
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
  resolvedTargetVersions: Set<string>,
): Set<string> {
  const versions = new Set<string>();

  for (const release of effectiveReleases) {
    if (release.id === context.release.id) {
      for (const binaryVersion of resolvedTargetVersions) {
        versions.add(binaryVersion);
      }
      continue;
    }

    for (const [binaryVersion, releaseIds] of historicalTargetIdsByVersion) {
      if (releaseIds.has(release.id)) {
        versions.add(binaryVersion);
      }
    }
  }

  return versions;
}

function buildKnownHashSet(
  context: ReconcileContext,
  binaryVersion: string,
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
  resolvedTargetVersions: Set<string>,
): KnownHashSet {
  const hashes = new Set<string>();
  const historicalReleases = getHistoricalChainReleases(
    context,
    binaryVersion,
    historicalTargetIdsByVersion,
  );
  const historicalSourceHashes: string[] = [];

  if (resolvedTargetVersions.has(binaryVersion) && context.release.targetPackageHash) {
    hashes.add(context.release.targetPackageHash);
  }

  for (const release of historicalReleases) {
    if (!release.targetPackageHash) {
      continue;
    }

    hashes.add(release.targetPackageHash);
    if (release.id === context.release.id) {
      continue;
    }
    if (!historicalSourceHashes.includes(release.targetPackageHash)) {
      historicalSourceHashes.push(release.targetPackageHash);
    }
  }

  const patchEligibleHashes = new Set<string>();
  const patchWindow = context.patchWindow;
  const eligibleReleaseHashes =
    patchWindow === null
      ? historicalSourceHashes
      : historicalSourceHashes.slice(0, patchWindow);
  for (const hash of eligibleReleaseHashes) {
    patchEligibleHashes.add(hash);
  }

  return {
    binaryVersion,
    hashes: [...hashes].sort(),
    patchEligibleHashes: [...patchEligibleHashes].sort(),
  };
}

function getHistoricalChainReleases(
  context: ReconcileContext,
  binaryVersion: string,
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
): Release[] {
  const ids = historicalTargetIdsByVersion.get(binaryVersion);
  if (!ids) {
    return [];
  }

  return context.publishedReleases
    .filter((release) => ids.has(release.id))
    .sort(compareReleasesDesc);
}

function buildDesiredBundle(
  context: ReconcileContext,
  targetPackageHash: string,
  resolvedTargets: ResolvedTarget[],
): DesiredBundle | null {
  if (!context.bundleSource) {
    return null;
  }

  const publicKeys: DesiredBundlePublicKey[] = resolvedTargets.map((target) => ({
    binaryVersion: target.binaryVersion,
    key: makeBundlePublicKey(
      context.deployment.deploymentKey,
      target.binaryVersion,
      targetPackageHash,
    ),
  }));

  return {
    internalKey: makeBundleInternalKey(context.release.id),
    publicKeys,
    releaseId: context.release.id,
  };
}

function buildDesiredPatches(
  context: ReconcileContext,
  targetPackageHash: string,
  resolvedTargets: ResolvedTarget[],
  knownHashSets: Map<string, KnownHashSet>,
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
): DesiredPatch[] {
  const patchesByKey = new Map<string, DesiredPatch>();

  for (const target of resolvedTargets) {
    const knownHashSet = knownHashSets.get(target.binaryVersion);
    if (!knownHashSet) {
      continue;
    }

    for (const fromPackageHash of knownHashSet.patchEligibleHashes) {
      addPatchIfNeeded(
        patchesByKey,
        createPatch(
          context,
          target.binaryVersion,
          fromPackageHash,
          targetPackageHash,
          false,
        ),
      );
    }

    const previousRelease = findPreviousPublishedReleaseForCurrent(
      context,
      target.binaryVersion,
      historicalTargetIdsByVersion,
    );
    if (!previousRelease?.targetPackageHash) {
      continue;
    }

    for (const fromPackageHash of knownHashSet.hashes) {
      addPatchIfNeeded(
        patchesByKey,
        createPatch(
          context,
          target.binaryVersion,
          fromPackageHash,
          previousRelease.targetPackageHash,
          true,
        ),
      );
    }
  }

  return [...patchesByKey.values()].sort((left, right) =>
    left.publicKey.localeCompare(right.publicKey),
  );
}

function addPatchIfNeeded(
  patchesByKey: Map<string, DesiredPatch>,
  patch: DesiredPatch | null,
): void {
  if (!patch) {
    return;
  }

  patchesByKey.set(patch.publicKey, patch);
}

function createPatch(
  context: ReconcileContext,
  binaryVersion: string,
  fromPackageHash: string,
  toPackageHash: string,
  isRolloutFallback: boolean,
): DesiredPatch | null {
  if (fromPackageHash === toPackageHash) {
    return null;
  }

  return {
    binaryVersion,
    fromPackageHash,
    internalKey: makePatchInternalKey(
      context.release.id,
      binaryVersion,
      fromPackageHash,
      toPackageHash,
    ),
    isRolloutFallback,
    publicKey: makePatchPublicKey(
      context.deployment.deploymentKey,
      binaryVersion,
      toPackageHash,
      fromPackageHash,
    ),
    releaseId: context.release.id,
    toPackageHash,
  };
}

function findPreviousPublishedReleaseForCurrent(
  context: ReconcileContext,
  binaryVersion: string,
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
): Release | null {
  return (
    getHistoricalChainReleases(context, binaryVersion, historicalTargetIdsByVersion).find(
      (release) => release.id !== context.release.id && release.status === "published",
    ) ?? null
  );
}

function buildDesiredManifests(
  context: ReconcileContext,
  manifestVersions: string[],
  effectiveReleases: Release[],
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
  resolvedTargetVersions: Set<string>,
  knownHashSets: Map<string, KnownHashSet>,
  patchLookup: Set<string>,
): DesiredManifestDraft[] {
  const manifests: DesiredManifestDraft[] = [];

  for (const binaryVersion of manifestVersions) {
    const chain = getEffectiveChainReleases(
      context,
      binaryVersion,
      effectiveReleases,
      historicalTargetIdsByVersion,
      resolvedTargetVersions,
    );
    const latestRelease = chain[0] ?? null;
    const previousRelease = chain[1] ?? null;
    const knownHashSet = knownHashSets.get(binaryVersion);

    if (!knownHashSet) {
      continue;
    }

    manifests.push({
      binaryVersion,
      content: buildManifestContent(
        context,
        binaryVersion,
        null,
        latestRelease,
        previousRelease,
        chain,
        patchLookup,
      ),
      currentPackageHash: null,
      kind: "fallback",
      publicKey: makeFallbackManifestPublicKey(
        context.deployment.deploymentKey,
        binaryVersion,
      ),
    });

    for (const currentPackageHash of knownHashSet.hashes) {
      const content = buildManifestContent(
        context,
        binaryVersion,
        currentPackageHash,
        latestRelease,
        previousRelease,
        chain,
        patchLookup,
      );

      manifests.push({
        binaryVersion,
        content,
        currentPackageHash,
        kind: "primary",
        publicKey: makeManifestPublicKey(
          context.deployment.deploymentKey,
          binaryVersion,
          currentPackageHash,
        ),
      });
    }
  }

  return manifests.sort((left, right) => left.publicKey.localeCompare(right.publicKey));
}

function getEffectiveChainReleases(
  context: ReconcileContext,
  binaryVersion: string,
  effectiveReleases: Release[],
  historicalTargetIdsByVersion: Map<string, Set<ReleaseId>>,
  resolvedTargetVersions: Set<string>,
): Release[] {
  return effectiveReleases
    .filter((release) =>
      release.id === context.release.id
        ? resolvedTargetVersions.has(binaryVersion)
        : historicalTargetIdsByVersion.get(binaryVersion)?.has(release.id) ?? false,
    )
    .sort(compareReleasesDesc);
}

function buildManifestContent(
  context: ReconcileContext,
  binaryVersion: string,
  currentPackageHash: string | null,
  latestRelease: Release | null,
  previousRelease: Release | null,
  chain: Release[],
  patchLookup: Set<string>,
): ManifestContentDraft {
  if (!latestRelease?.targetPackageHash) {
    return {
      isMandatory: false,
      releaseNotes: null,
      rolloutPercentage: 100,
      targetPackageHash: null,
    };
  }

  const content: ManifestContentDraft = {
    bundlePublicKey: makeBundlePublicKey(
      context.deployment.deploymentKey,
      binaryVersion,
      latestRelease.targetPackageHash,
    ),
    isMandatory: computeMandatoryFlag(currentPackageHash, latestRelease, chain),
    releaseLabel: latestRelease.releaseLabel,
    releaseNotes: latestRelease.releaseNotes,
    rolloutPercentage: latestRelease.rolloutPercentage,
    targetPackageHash: latestRelease.targetPackageHash,
  };

  if (
    currentPackageHash !== null &&
    currentPackageHash !== latestRelease.targetPackageHash &&
    patchLookup.has(
      makePatchLookupKeyFromParts(
        binaryVersion,
        currentPackageHash,
        latestRelease.targetPackageHash,
      ),
    )
  ) {
    content.patchPublicKey = makePatchPublicKey(
      context.deployment.deploymentKey,
      binaryVersion,
      latestRelease.targetPackageHash,
      currentPackageHash,
    );
  }

  if (latestRelease.signature) {
    content.signature = latestRelease.signature;
  }

  const previousPackageInfo = buildPreviousPackageInfo(
    context,
    binaryVersion,
    currentPackageHash,
    previousRelease,
    chain,
    patchLookup,
  );
  if (previousPackageInfo) {
    content.previousPackageInfo = previousPackageInfo;
  }

  return content;
}

function buildPreviousPackageInfo(
  context: ReconcileContext,
  binaryVersion: string,
  currentPackageHash: string | null,
  previousRelease: Release | null,
  chain: Release[],
  patchLookup: Set<string>,
): PreviousPackageInfoDraft | undefined {
  if (!previousRelease?.targetPackageHash) {
    return undefined;
  }

  const info: PreviousPackageInfoDraft = {
    bundlePublicKey: makeBundlePublicKey(
      context.deployment.deploymentKey,
      binaryVersion,
      previousRelease.targetPackageHash,
    ),
    isMandatory: computeMandatoryFlag(currentPackageHash, previousRelease, chain),
    packageHash: previousRelease.targetPackageHash,
    releaseLabel: previousRelease.releaseLabel,
    releaseNotes: previousRelease.releaseNotes,
    rolloutPercentage: previousRelease.rolloutPercentage,
  };

  if (
    currentPackageHash !== null &&
    currentPackageHash !== previousRelease.targetPackageHash &&
    patchLookup.has(
      makePatchLookupKeyFromParts(
        binaryVersion,
        currentPackageHash,
        previousRelease.targetPackageHash,
      ),
    )
  ) {
    info.patchPublicKey = makePatchPublicKey(
      context.deployment.deploymentKey,
      binaryVersion,
      previousRelease.targetPackageHash,
      currentPackageHash,
    );
  }

  if (previousRelease.signature) {
    info.signature = previousRelease.signature;
  }

  return info;
}

function computeMandatoryFlag(
  currentPackageHash: string | null,
  targetRelease: Release,
  chain: Release[],
): boolean {
  const chronologicalChain = [...chain].sort(compareReleasesAsc);
  const targetIndex = chronologicalChain.findIndex((release) => release.id === targetRelease.id);
  if (targetIndex === -1) {
    return targetRelease.isMandatory;
  }

  const currentIndex = chronologicalChain.findIndex(
    (release) => release.targetPackageHash === currentPackageHash,
  );
  const chainSlice =
    currentIndex === -1
      ? chronologicalChain.slice(0, targetIndex + 1)
      : chronologicalChain.slice(currentIndex + 1, targetIndex + 1);

  return chainSlice.some((release) => release.isMandatory) || targetRelease.isMandatory;
}

function buildDesiredDeploymentMeta(
  context: ReconcileContext,
  effectiveVersions: Set<string>,
): DesiredDeploymentMetaDraft {
  const publicKey = makeDeploymentMetaPublicKey(context.deployment.deploymentKey);
  // Clients compare this metadata token with their native binary version by
  // precedence and surface a hint only when it is strictly higher, so we
  // publish the highest comparable binary version. Non-semver but
  // numeric-dotted tokens (e.g. `2024.06`) are valid candidates; opaque tokens
  // are only chosen when no comparable version exists. See PROTOCOL.md and
  // `binaryVersionPrecedence.ts`.
  const latestBinaryVersion = selectLatestBinaryVersion(effectiveVersions);

  if (!latestBinaryVersion) {
    return {
      content: null,
      publicKey,
    };
  }

  return {
    content: { latestBinaryVersion },
    publicKey,
  };
}

function makePatchLookupKey(patch: DesiredPatch): string {
  return makePatchLookupKeyFromParts(
    patch.binaryVersion,
    patch.fromPackageHash,
    patch.toPackageHash,
  );
}

function makePatchLookupKeyFromParts(
  binaryVersion: string,
  fromPackageHash: string,
  toPackageHash: string,
): string {
  return `${binaryVersion}:${fromPackageHash}:${toPackageHash}`;
}

function sortBinaryVersions(versions: Iterable<string>): string[] {
  return [...versions].sort(compareBinaryVersions);
}

// Deterministic ordering of the binary versions in a deployment, used to keep
// the generated manifest / bundle / patch lists in a stable order. Binary
// versions are not required to be semver: semver deployments order by semver
// and opaque tokens fall back to lexical order. The store-update metadata token
// is selected separately by `selectLatestBinaryVersion` (see PROTOCOL.md), not
// by this ordering.
function compareBinaryVersions(left: string, right: string): number {
  const leftIsSemver = validSemver(left) !== null;
  const rightIsSemver = validSemver(right) !== null;
  if (leftIsSemver && rightIsSemver) {
    return compareSemver(left, right);
  }
  if (leftIsSemver !== rightIsSemver) {
    return leftIsSemver ? 1 : -1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReleasesDesc(left: Release, right: Release): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}

function compareReleasesAsc(left: Release, right: Release): number {
  return left.createdAt.getTime() - right.createdAt.getTime();
}
