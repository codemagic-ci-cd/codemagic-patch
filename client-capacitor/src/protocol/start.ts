// Capacitor counterpart of upstream codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/wrap.ts (Apache-2.0, client v0.5.0). `Patch.wrap(App)` is a React
// higher-order component; Capacitor apps have no single component framework to wrap,
// so this is the same behaviour as a plain function — see
// specs/adr/0013-native-app-state-events.md:
// 1. A `sync()` when called, where `wrap()` syncs when the root mounts.
// 2. With `CheckFrequency.ON_APP_RESUME`, another `sync()` on every background- or
//    inactive-to-active transition, from the native `CodemagicPatchAppStateChange`
//    event instead of React Native's `AppState`.

import CodemagicPatch from '../nativeCodemagicPatch';

import { APP_STATE_CHANGE_EVENT, readAppState } from './runtime';
import { sync } from './sync';
import { CheckFrequency, type StartOptions, type SyncOptions, type SyncStatus } from './types';

interface RemovableSubscription {
  remove(): Promise<void>;
}

let resumeSubscription: Promise<RemovableSubscription | undefined> | null = null;
let resumeSyncOptions: SyncOptions | undefined;

/**
 * Checks for, downloads and installs an update, and reports the running bundle as
 * healthy — the one-call integration, like upstream's `Patch.wrap(App)`.
 *
 * ```ts
 * import { CheckFrequency, start } from '@codemagic/capacitor-patch';
 *
 * start({ checkFrequency: CheckFrequency.ON_APP_RESUME });
 * ```
 *
 * Call it once the app has rendered its first screen. `sync()` begins by calling
 * `notifyAppReady()`, so this call is what acknowledges the running package as
 * healthy: calling it earlier in bootstrap means a crash between here and the first
 * screen no longer triggers a rollback. Apps that must finish asynchronous setup before
 * they can vouch for the running bundle should call it at that point.
 *
 * `ON_APP_RESUME` also syncs whenever the app returns to the foreground. Install
 * options pass through to `sync()`, whose defaults apply: ordinary updates install
 * `ON_NEXT_RESTART`, mandatory updates install `IMMEDIATE`.
 *
 * Safe to call more than once: each call starts a `sync()` (overlapping calls resolve
 * to `sync-in-progress` rather than a second update cycle), and the latest call's
 * options and check frequency replace the previous ones — there is never more than one
 * foreground listener.
 *
 * @returns The status of the initial `sync()`. Never rejects.
 */
export function start(options?: StartOptions): Promise<SyncStatus> {
  const { checkFrequency = CheckFrequency.ON_APP_START, ...installOptions } = options ?? {};
  const syncOptions: SyncOptions | undefined = options ? installOptions : undefined;

  resumeSyncOptions = syncOptions;
  if (checkFrequency === CheckFrequency.ON_APP_RESUME) {
    subscribeToForegroundReturn();
  } else {
    unsubscribeFromForegroundReturn();
  }

  return sync(syncOptions);
}

function subscribeToForegroundReturn(): void {
  if (resumeSubscription) return;

  let previousState = 'active';
  const onAppStateChange = (event: unknown): void => {
    const nextState = readAppState(event);
    if (!nextState) return;
    const returning = previousState === 'background' || previousState === 'inactive';
    previousState = nextState;
    if (returning && nextState === 'active') void sync(resumeSyncOptions);
  };

  // A failed registration only loses the foreground re-check; the initial sync()
  // still runs, and start() must never reject.
  try {
    resumeSubscription = Promise.resolve(CodemagicPatch.addListener(APP_STATE_CHANGE_EVENT, onAppStateChange)).catch(
      () => undefined,
    );
  } catch {
    resumeSubscription = Promise.resolve(undefined);
  }
}

function unsubscribeFromForegroundReturn(): void {
  const subscription = resumeSubscription;
  resumeSubscription = null;
  void subscription?.then((handle) => handle?.remove()).catch(() => undefined);
}
