/**
 * Jest setup for projects using @codemagic/react-native-patch.
 *
 *   setupFiles: ['@codemagic/react-native-patch/jest-setup']
 *
 * The SDK resolves its TurboModule at module scope with
 * `TurboModuleRegistry.getEnforcing`, which is deliberate: a missing native
 * module should fail loudly at app boot. Under Jest there is no native binary,
 * so that same throw stops a suite before any test runs.
 *
 * This file installs the native-boundary fake from
 * `@codemagic/react-native-patch/jest` with the default seed: a device running
 * the store binary, server reporting no update. Every other TurboModule is left
 * untouched. To test another state, call `installPatchFake(seed)` from that
 * entry and load the SDK after it (`loadSdk()`).
 *
 * Loads the built adapter by path so this file needs no transform; the adapter
 * keeps the current fake on `globalThis`, which a test-file `installPatchFake`
 * from the TypeScript source replaces.
 */
require("./dist/fake/jest").installPatchFake();
