// `@codemagic/react-native-patch/build-tools/fingerprint`: the SDK's Node-only
// build tools (specs/build-metadata.md). Never imported by the React Native
// runtime entry, never part of the Metro bundle.
//
// As a library: only what `cmpatch` calls (specs/build-metadata.md §6.1). As
// an executable: `node <this file> <command> ...` (see cli.ts).

export { BUILD_TOOLS_CONTRACT_VERSION } from "./cli";
export {
  computeNativeFingerprint,
  type FingerprintPlatform,
  type NativeFingerprintResult,
} from "./calculator";

import { runCli } from "./cli";

if (typeof require !== "undefined" && require.main === module) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
