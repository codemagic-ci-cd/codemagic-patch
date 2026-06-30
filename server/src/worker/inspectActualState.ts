import type { StorageAdapter } from "../adapters";
import type {
  ActualState,
  DesiredState,
  ExistingObject,
  ExistingPatchState,
} from "./types";

export async function inspectActualState(
  desired: DesiredState,
  storage: StorageAdapter,
  options: {
    heartbeat?: () => Promise<void>;
  } = {},
): Promise<ActualState> {
  await options.heartbeat?.();
  const bundle = desired.bundle
    ? await inspectBundleState(desired, storage, options.heartbeat)
    : null;
  await options.heartbeat?.();
  const existingPatches = await inspectExistingPatches(desired, storage, options.heartbeat);
  await options.heartbeat?.();
  const existingManifests = await inspectExistingManifests(
    desired,
    storage,
    options.heartbeat,
  );
  await options.heartbeat?.();
  const deploymentMeta = await storage.head(desired.deploymentMeta.publicKey);

  return {
    bundle,
    deploymentMetaContentHash: deploymentMeta?.metadata.content_hash ?? null,
    deploymentMetaExists: deploymentMeta !== null,
    existingManifests,
    existingPatches,
  };
}

async function inspectBundleState(
  desired: DesiredState,
  storage: StorageAdapter,
  heartbeat?: () => Promise<void>,
): Promise<NonNullable<ActualState["bundle"]>> {
  const bundle = desired.bundle;
  if (!bundle) {
    throw new Error("inspectBundleState requires desired.bundle to exist");
  }

  await heartbeat?.();
  const internalObject = await storage.head(bundle.internalKey);
  const publicObjects: Array<{ exists: boolean; key: string }> = [];

  for (const bundleKey of bundle.publicKeys) {
    await heartbeat?.();
    publicObjects.push({
      exists: (await storage.head(bundleKey.key)) !== null,
      key: bundleKey.key,
    });
  }

  return {
    existingPublicKeys: new Set(
      publicObjects.filter((entry) => entry.exists).map((entry) => entry.key),
    ),
    internalKeyExists: internalObject !== null,
  };
}

async function inspectExistingPatches(
  desired: DesiredState,
  storage: StorageAdapter,
  heartbeat?: () => Promise<void>,
): Promise<ActualState["existingPatches"]> {
  const existingPatches = new Map<string, ExistingPatchState>();

  for (const patch of desired.patches) {
    await heartbeat?.();
    const internalObject = await storage.head(patch.internalKey);
    await heartbeat?.();
    const publicObject = await storage.head(patch.publicKey);

    if (!internalObject && !publicObject) {
      continue;
    }

    existingPatches.set(patch.publicKey, {
      internalKey: patch.internalKey,
      internalObject: toExistingObject(patch.internalKey, internalObject),
      publicKey: patch.publicKey,
      publicObject: toExistingObject(patch.publicKey, publicObject),
    });
  }

  return existingPatches;
}

async function inspectExistingManifests(
  desired: DesiredState,
  storage: StorageAdapter,
  heartbeat?: () => Promise<void>,
): Promise<ActualState["existingManifests"]> {
  const existingManifests = new Map<string, ExistingObject>();

  for (const manifest of desired.manifests) {
    await heartbeat?.();
    const existingManifest = await storage.head(manifest.publicKey);
    if (!existingManifest) {
      continue;
    }

    existingManifests.set(manifest.publicKey, {
      contentHash: existingManifest.metadata.content_hash ?? null,
      key: manifest.publicKey,
      size: existingManifest.size,
    });
  }

  return existingManifests;
}

function toExistingObject(
  key: string,
  object: Awaited<ReturnType<StorageAdapter["head"]>>,
): ExistingObject | null {
  if (!object) {
    return null;
  }

  return {
    contentHash: object.metadata.content_hash ?? null,
    key,
    size: object.size,
  };
}
