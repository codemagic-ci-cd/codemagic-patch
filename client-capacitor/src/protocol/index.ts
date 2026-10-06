// Barrel export for the protocol layer. Mirrors upstream
// codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9 client/src/index.ts's
// shape closely, adjusted for what actually shipped in Phase 1 — see
// specs/adr/0008-unified-error-taxonomy.md for why the error export moved to
// ../definitions. `start()` is this SDK's counterpart of upstream's `wrap()` — see
// ./start.ts.

export { checkForUpdate } from './checkForUpdate';
export { downloadUpdate } from './downloadUpdate';
export { getRunningBundleUpdateMetadata } from './getRunningBundleUpdateMetadata';
export { installUpdate } from './installUpdate';
export { isNextVersionReady } from './isNextVersionReady';
export { notifyAppReady } from './notifyAppReady';
export { start } from './start';
export { sync } from './sync';
export { allowRestart, disallowRestart, ensureHydrated as hydrate, restartApp } from './runtime';

export { CheckFrequency, InstallMode } from './types';
export type {
  DownloadProgress,
  EmbeddedRevertUpdate,
  InstallOptions,
  InstallTarget,
  LocalPackage,
  RemotePackage,
  RunningBundleUpdateMetadata,
  StartOptions,
  SyncOptions,
  SyncStatus,
  UpdateCheckResult,
} from './types';
