/**
 * Jest adapter for the native-boundary fake:
 * `@codemagic/react-native-patch/jest`.
 *
 * Installs a fake in place of the `NativeCodemagicPatch` TurboModule so the
 * real SDK loads under Jest and hydrates from a scenario you seed.
 *
 * Isolation contract:
 * - There is one current fake per test file (Jest gives each test file its
 *   own environment). It lives on `globalThis`, so `jest.resetModules()` does
 *   not drop it.
 * - `installPatchFake(seed)` replaces the current fake. An SDK instance that
 *   was already imported keeps the native module it captured at import and the
 *   state it hydrated, so install before importing the app graph, or call
 *   `loadSdk()` after installing.
 * - `loadSdk()` runs `jest.resetModules()` and imports a fresh SDK, which
 *   hydrates from the current fake. It clears every module, so SDK runtime
 *   state goes with it; anything else that imports the SDK must be required
 *   again after it. It does not reset the fake: failures, server answers and
 *   packages downloaded so far stay. A new scenario means a new
 *   `installPatchFake(seed)`.
 * - `loadSdk()` cancels the pending `ON_NEXT_SUSPEND` activation timer of the
 *   SDK the previous `loadSdk()` imported, so it cannot reload the bundle
 *   during a later scenario. An SDK imported without `loadSdk()` (install,
 *   then a plain import) is not disposed this way.
 */

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

// The subset of the Jest object this adapter uses. Jest hands `jest` to every
// module it loads, so this is a free variable at runtime, not an import.
interface JestRuntime {
  mock(moduleName: string, factory: () => unknown): unknown;
  requireActual<T = unknown>(moduleName: string): T;
  resetModules(): unknown;
}
declare const jest: JestRuntime;

/**
 * Shared with `jest-setup.js` through this module's build output. The registry
 * mock reads `nativeModule` from here on every lookup, so whichever copy of
 * this adapter installed the fake (the `dist` one from `jest-setup`, or the
 * TypeScript source under the `react-native` condition) serves it.
 */
interface JestFakeState {
  registryMocked: boolean;
  nativeModule: Spec | null;
  /** Cancels the pending `ON_NEXT_SUSPEND` timer of the SDK the last `loadSdk()` imported. */
  disposeSdk: (() => void) | null;
}

const STATE_KEY = "__codemagicPatchJestFake";

function fakeState(): JestFakeState {
  const scope = globalThis as unknown as Record<string, JestFakeState | undefined>;
  let state = scope[STATE_KEY];
  if (!state) {
    state = { registryMocked: false, nativeModule: null, disposeSdk: null };
    scope[STATE_KEY] = state;
  }
  return state;
}

interface TurboModuleRegistryModule {
  get(name: string): unknown;
  getEnforcing(name: string): unknown;
}

function mockTurboModuleRegistry(): void {
  const state = fakeState();
  if (state.registryMocked) {
    return;
  }
  // Mocks the registry rather than `react-native`, so every other TurboModule
  // and the rest of React Native stay as the consumer's preset set them up.
  // The fake is looked up when the SDK asks for it, not captured here.
  //
  // Called through an alias: when the consumer's babel-jest transforms this
  // file, babel-plugin-jest-hoist would reject a `jest.mock` factory that uses
  // the declared `jest` and module constants. Nothing here needs hoisting.
  const mockJest = jest;
  mockJest.mock("react-native/Libraries/TurboModule/TurboModuleRegistry", () => {
    const actual = mockJest.requireActual<TurboModuleRegistryModule>(
      "react-native/Libraries/TurboModule/TurboModuleRegistry",
    );
    const current = (name: string): Spec | null =>
      name === "NativeCodemagicPatch"
        ? ((globalThis as unknown as Record<string, JestFakeState | undefined>)[STATE_KEY]
            ?.nativeModule ?? null)
        : null;
    return {
      ...actual,
      get: (name: string) => current(name) ?? actual.get(name),
      getEnforcing: (name: string) => current(name) ?? actual.getEnforcing(name),
    };
  });
  state.registryMocked = true;
}

/**
 * Make `seed` the native state the SDK sees, replacing any earlier fake. Only
 * SDK instances imported after this call use it: call it before importing the
 * app graph, or follow it with `loadSdk()`.
 */
export function installPatchFake(seed: PatchFakeSeed = {}): PatchFake {
  const fake = createPatchFake(seed);
  mockTurboModuleRegistry();
  fakeState().nativeModule = patchFakeNativeModule(fake);
  return fake;
}

/**
 * Reset Jest's module registry and import a fresh SDK, which hydrates from the
 * current fake. Modules that import the SDK must be required again after this
 * to share the fresh instance.
 */
export async function loadSdk(): Promise<typeof import("../index")> {
  const state = fakeState();
  if (!state.nativeModule) {
    throw new Error(
      "loadSdk: no Codemagic Patch fake is installed. Call installPatchFake() or add @codemagic/react-native-patch/jest-setup to setupFiles.",
    );
  }
  state.disposeSdk?.();
  state.disposeSdk = null;
  jest.resetModules();
  // `require`, not `import()`: Jest only runs dynamic import in CommonJS
  // modules with --experimental-vm-modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("../index") as typeof import("../index");
  // Same fresh registry, so this is the runtime the SDK above runs on.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtime = require("../runtime") as typeof import("../runtime");
  state.disposeSdk = runtime.clearSuspendActivationTimer;
  return sdk;
}
