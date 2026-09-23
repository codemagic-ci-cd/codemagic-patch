export { checkForUpdate } from "./checkForUpdate";
export { downloadUpdate } from "./downloadUpdate";
export { getRunningBundleUpdateMetadata } from "./getRunningBundleUpdateMetadata";
export { installUpdate } from "./installUpdate";
export { isNextVersionReady } from "./isNextVersionReady";
export { notifyAppReady } from "./notifyAppReady";
export { sync } from "./sync";
export { wrap, type WrappedRootComponent, type WrappedRootProps } from "./wrap";
export {
  allowRestart,
  disallowRestart,
  ensureHydrated as hydrate,
  restartApp,
} from "./runtime";

export {
  CodemagicPatchError,
  CodemagicPatchErrorCode,
  type CodemagicPatchErrorCodeType,
  type RunningBundleUpdateMetadata,
  type DownloadProgress,
  type EmbeddedRevertUpdate,
  type InstallTarget,
  CheckFrequency,
  type WrapOptions,
  InstallMode,
  type InstallOptions,
  type LocalPackage,
  type RemotePackage,
  type SyncOptions,
  type SyncStatus,
  type UpdateCheckResult,
} from "./types";
