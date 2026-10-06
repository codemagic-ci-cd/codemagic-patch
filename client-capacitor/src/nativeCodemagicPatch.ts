import { registerPlugin } from '@capacitor/core';

import type { CodemagicPatchPlugin } from './definitions';

/**
 * The one `registerPlugin` call for this package — the "Binding" layer in
 * `specs/ARCHITECTURE.md` § 3. This file exists separately from `src/index.ts` for one
 * reason: `src/protocol/*` (runtime.ts, checkForUpdate.ts, etc.) needs the registered
 * plugin instance to call native methods, and `src/index.ts` needs to export both this
 * instance *and* the protocol layer's public API (`sync`, `checkForUpdate`, ...). If the
 * plugin were registered inside `index.ts`, protocol files importing it would create a
 * circular import (`index.ts` -> `protocol/*` -> `index.ts`). Everything imports this
 * file instead; nothing imports `index.ts` except the package's own consumers.
 *
 * `src/protocol/` is still Capacitor-free by the letter of ADR-0001: nothing under it
 * imports `@capacitor/core` directly. This file is the one place that boundary is
 * deliberately crossed, and it is the only file protocol code is allowed to cross it
 * through.
 */
const CodemagicPatch = registerPlugin<CodemagicPatchPlugin>('CodemagicPatch', {
  web: () => import('./web').then((m) => new m.CodemagicPatchWeb()),
});

export default CodemagicPatch;
