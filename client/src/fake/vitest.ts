/**
 * Vitest adapter for the native-boundary fake:
 * `@codemagic/react-native-patch/vitest`.
 *
 * React Native's own entry is Flow source that Node cannot load, so under
 * Vitest this adapter mocks the whole `react-native` module with just what the
 * SDK reads from it: `TurboModuleRegistry` (serving the fake as
 * `NativeCodemagicPatch`), `AppState` and `DeviceEventEmitter`. Anything else
 * imported from `react-native` (`View`, `Text`, ...) is undefined under this
 * mock; render with `react-dom` in a jsdom environment instead.
 *
 * Needs the `codemagicPatch()` plugin from
 * `@codemagic/react-native-patch/vitest-plugin`: Vitest's module mocks do not
 * reach the package's CommonJS build, so the plugin points the package entry
 * at its TypeScript source, which Vitest transforms itself.
 *
 * Isolation contract:
 * - There is one current fake per test file. It lives on `globalThis`, so
 *   `vi.resetModules()` does not drop it.
 * - `installPatchFake(seed)` replaces the current fake. An SDK instance that
 *   was already imported keeps the native module it captured at import and the
 *   state it hydrated, so install before importing the app graph, or call
 *   `loadSdk()` after installing.
 * - `loadSdk()` runs `vi.resetModules()` and imports a fresh SDK, which
 *   hydrates from the current fake, under a fresh `react-native` mock (no
 *   `AppState` listener of an earlier load survives). Modules that import the
 *   SDK must be imported again after it. React and other dependencies Vitest
 *   leaves to Node are not reset, so a test's React and the SDK's stay one
 *   instance. It does not reset the fake: failures, server answers and
 *   packages downloaded so far stay. A new scenario means a new
 *   `installPatchFake(seed)`.
 * - `loadSdk()` cancels the pending `ON_NEXT_SUSPEND` activation timer of the
 *   SDK the previous `loadSdk()` imported, so it cannot reload the bundle
 *   during a later scenario. An SDK imported without `loadSdk()` (install,
 *   then a plain import) is not disposed this way.
 */

import { vi } from "vitest";

import type { Spec } from "../NativeCodemagicPatch";
import { createPatchFake, patchFakeNativeModule } from "./createPatchFake";
import type { PatchFake, PatchFakeSeed } from "./types";

export type {
  PatchFake,
  PatchFakeMethod,
  PatchFakeSeed,
  PatchFakeServer,
  PatchPackageSeed,
} from "./types";

const STATE_KEY = "__codemagicPatchVitestFake";
const MODULE_NAME = "NativeCodemagicPatch";

interface VitestFakeState {
  nativeModule: Spec | null;
  /** Cancels the pending `ON_NEXT_SUSPEND` timer of the SDK the last `loadSdk()` imported. */
  disposeSdk: (() => void) | null;
}

function fakeState(): VitestFakeState {
  const scope = globalThis as unknown as Record<string, VitestFakeState | undefined>;
  let state = scope[STATE_KEY];
  if (!state) {
    state = { nativeModule: null, disposeSdk: null };
    scope[STATE_KEY] = state;
  }
  return state;
}

/**
 * The `react-native` module the SDK sees. Built once per module load, so each
 * `loadSdk()` starts with an `AppState` nobody subscribed to yet. The fake is
 * looked up when the SDK asks for it, not captured here.
 */
function reactNativeMock() {
  const lookup = (name: string): Spec | null =>
    name === MODULE_NAME ? fakeState().nativeModule : null;
  return {
    TurboModuleRegistry: {
      get: (name: string) => lookup(name),
      getEnforcing: (name: string) => {
        const module = lookup(name);
        if (!module) {
          throw new Error(
            `TurboModuleRegistry.getEnforcing(...): '${name}' could not be found. The @codemagic/react-native-patch/vitest mock of react-native only provides ${MODULE_NAME}.`,
          );
        }
        return module;
      },
    },
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => {} }),
    },
    DeviceEventEmitter: {
      addListener: () => ({ remove: () => {} }),
    },
  };
}

/**
 * Make `seed` the native state the SDK sees, replacing any earlier fake. Only
 * SDK instances imported after this call use it: call it before importing the
 * app graph (a setup file does), or follow it with `loadSdk()`.
 */
export function installPatchFake(seed: PatchFakeSeed = {}): PatchFake {
  const fake = createPatchFake(seed);
  fakeState().nativeModule = patchFakeNativeModule(fake);
  vi.doMock("react-native", reactNativeMock);
  return fake;
}

/**
 * Reset Vitest's module registry and import a fresh SDK, which hydrates from
 * the current fake. Modules that import the SDK must be imported again after
 * this to share the fresh instance.
 */
export async function loadSdk(): Promise<typeof import("../index")> {
  const state = fakeState();
  if (!state.nativeModule) {
    throw new Error(
      "loadSdk: no Codemagic Patch fake is installed. Call installPatchFake() or add @codemagic/react-native-patch/vitest-setup to setupFiles.",
    );
  }
  state.disposeSdk?.();
  state.disposeSdk = null;
  vi.resetModules();
  const sdk = await import("../index");
  // Same fresh registry, so this is the runtime the SDK above runs on.
  state.disposeSdk = (await import("../runtime")).clearSuspendActivationTimer;
  return sdk;
}
