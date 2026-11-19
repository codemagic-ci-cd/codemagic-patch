// The iOS bundle mode (client/specs/build-integration/Spec.md §2 rule 10), from
// the environment of the "Codemagic Patch build metadata" phase after it has
// sourced the .xcode.env files.

import type { BundleMode } from "./writer";

export type XcodeBundleEnv = Readonly<
  Partial<Record<"CONFIGURATION" | "PLATFORM_NAME" | "ACTION" | "SKIP_BUNDLING" | "FORCE_BUNDLING", string>>
>;

export function xcodeBundleMode(env: XcodeBundleEnv): BundleMode {
  const debug = (env.CONFIGURATION ?? "").includes("Debug");
  // React Native's react-native-xcode.sh, which both integrations' bundle phases run.
  const bundles = !env.SKIP_BUNDLING && !(debug && (env.PLATFORM_NAME ?? "").endsWith("simulator") && !env.FORCE_BUNDLING);
  // Archive and install builds always require the bundle (specs/build-metadata.md §5.2 rule 5).
  return !bundles && debug && env.ACTION !== "install" ? "metro" : "embedded";
}
