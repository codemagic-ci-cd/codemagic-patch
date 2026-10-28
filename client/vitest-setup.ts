/**
 * Vitest setup for projects using @codemagic/react-native-patch.
 *
 *   setupFiles: ['@codemagic/react-native-patch/vitest-setup']
 *
 * Installs the native-boundary fake from `@codemagic/react-native-patch/vitest`
 * with the default seed: a device running the store binary, server reporting
 * no update. To test another state, call `installPatchFake(seed)` from that
 * entry and load the SDK after it (`loadSdk()`).
 *
 * Needs the `codemagicPatch()` plugin from
 * `@codemagic/react-native-patch/vitest-plugin` in the Vitest config.
 */
import { installPatchFake } from "./src/fake/vitest";

installPatchFake();
