# `src/protocol/`

The portable delivery-protocol layer, ported from the React Native client in this
repository ([`client/src/`](../../../client/src)). **No file in this directory may import
`@capacitor/core`, `@capacitor/*`, or any native-bridge type.** This is enforced by an
ESLint `no-restricted-imports` block for `client-capacitor/src/protocol/**` in the
repository's root `eslint.config.mjs`, not just by convention — run
`yarn workspace @codemagic/capacitor-patch eslint` after adding an import here if you are
unsure whether it is allowed.

The boundary exists so this layer stays comparable, file by file, with the React Native
client's copy: manifest parsing, rollout evaluation, version precedence and failure
payloads have no framework dependency, and keeping them that way is what would let both
clients share one core later instead of maintaining two forks.

Several ported files (`manifest.ts`, `rollout.ts`, more to follow) use `!` where the
React Native client's own schema validation guarantees non-null a few lines earlier than
TypeScript can see it. That is deliberate — matching the original source there is worth
more than threading a type guard through code this is meant to be verifiably identical to.

## Layout

| File | React Native client source | Status |
| --- | --- | --- |
| `types.ts` | `client/src/types.ts` | Ported, minus the error section — this package has one unified `CodemagicPatchError` taxonomy |
| `version.ts` | `client/src/version.ts` | Ported verbatim |
| `rollout.ts` | `client/src/rollout.ts` | Ported verbatim |
| `manifest.ts` | `client/src/manifest.ts` | Ported verbatim |
| `parser.ts` | `client/src/parser.ts` | Ported verbatim |
| `runtime.ts` | `client/src/runtime.ts` | Adapted — app state comes from this plugin's own native event, not React Native's `AppState` |
| `events.ts` | `client/src/events.ts` | Adapted — platform string, SDK version source, native call target |
| `failurePayload.ts` | `client/src/failurePayload.ts` | Adapted — native rejection shape (`error.data.*`, not `error.userInfo.*`) |
| `checkForUpdate.ts` | `client/src/checkForUpdate.ts` | Adapted — unwraps this plugin's object-wrapped native return shapes; records `Failed` on a rejected manifest fetch |
| `downloadUpdate.ts` | `client/src/downloadUpdate.ts` | Adapted — `CodemagicPatch.addListener()`, not `DeviceEventEmitter` |
| `installUpdate.ts` | `client/src/installUpdate.ts` | Adapted, same reasons as above |
| `notifyAppReady.ts` | `client/src/notifyAppReady.ts` | Adapted, same reasons as above |
| `start.ts` | `client/src/wrap.ts` | Counterpart — `wrap()`'s behaviour as a function, not a React component |
| `sync.ts` | `client/src/sync.ts` | Ported, minus the React Native-only `__DEV__` failure warning |
| `getRunningBundleUpdateMetadata.ts` | `client/src/getRunningBundleUpdateMetadata.ts` | Ported verbatim |
| `isNextVersionReady.ts` | `client/src/isNextVersionReady.ts` | Ported verbatim |
| `testing.ts` | `client/src/testing.ts` | Ported verbatim |

Every ported file carries a header naming the exact source path and the commit it was
taken from. This table says *that* something changed; each adapted file's header comment
says *what* changed and why.
