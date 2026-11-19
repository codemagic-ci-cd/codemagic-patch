// `@codemagic/patch-shared/store-artifact`: the build-metadata parser and the
// store-artifact reader (specs/build-metadata.md §3, §4.3, §7). Node only; the
// package root entry, which the dashboard bundles, does not include it.

export * from "../buildMetadata";
export { StoreArtifactError, type StoreArtifactErrorCode } from "./errors";
export {
  readStoreArtifact,
  STORE_ARTIFACT_LIMITS,
  type StoreArtifactKind,
  type StoreArtifactMetadata,
  type StoreArtifactPlatform,
} from "./reader";
