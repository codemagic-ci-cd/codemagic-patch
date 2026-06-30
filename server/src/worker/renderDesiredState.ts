import type { DeliveryAdapter } from "../adapters";
import { materializeManifestContent } from "./materializeManifestContent";
import type {
  DesiredDeploymentMeta,
  DesiredManifest,
  DesiredState,
  DesiredStateDraft,
  ManifestSerializer,
} from "./types";

export function renderDesiredState(
  desired: DesiredStateDraft,
  serializer: ManifestSerializer,
  delivery: DeliveryAdapter,
): DesiredState {
  return {
    bundle: desired.bundle,
    deploymentMeta: renderDeploymentMeta(desired, serializer),
    manifests: desired.manifests.map((manifest) =>
      renderManifest(manifest, serializer, delivery),
    ),
    patches: desired.patches,
  };
}

function renderManifest(
  manifest: DesiredStateDraft["manifests"][number],
  serializer: ManifestSerializer,
  delivery: DeliveryAdapter,
): DesiredManifest {
  const content = materializeManifestContent(manifest.content, delivery);
  const { contentHash } = serializer.serialize(content);

  return {
    ...manifest,
    content,
    contentHash,
  };
}

function renderDeploymentMeta(
  desired: DesiredStateDraft,
  serializer: ManifestSerializer,
): DesiredDeploymentMeta {
  if (!desired.deploymentMeta.content) {
    return {
      ...desired.deploymentMeta,
      contentHash: null,
    };
  }

  const { contentHash } = serializer.serializeDeploymentMeta(desired.deploymentMeta.content);

  return {
    ...desired.deploymentMeta,
    contentHash,
  };
}
