export { checkForUpdate } from "./checkForUpdate";
export { downloadUpdate } from "./downloadUpdate";
export { installUpdate } from "./installUpdate";
export { notifyAppReady } from "./notifyAppReady";
export { sync } from "./sync";
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
  type DownloadProgress,
  type EmbeddedRevertUpdate,
  type InstallTarget,
  type InstallMode,
  type InstallOptions,
  type LocalPackage,
  type RemotePackage,
  type SyncOptions,
  type SyncStatus,
  type UpdateCheckResult,
} from "./types";
