// This CLI computes no native fingerprint — there is no agreed definition of one
// for a Capacitor app yet (client-capacitor ADR-0005).
// The release upload contract still requires a non-empty `fingerprint`, and the
// server does two things with it:
//
//   1. The first fingerprint a deployment sees for a binary version becomes that
//      version's registered fingerprint; later uploads that disagree are flagged.
//   2. The release worker also delivers a release to every OTHER binary version of
//      the deployment whose registered fingerprint equals the release's.
//
// So the value sent here has to be the same for every release of one binary
// version (or (1) would flag each upload) and different for every other binary
// version (or (2) would hand a web bundle to a native build it was never tested
// on). Deriving it from the target binary version gives exactly that for a release
// that keeps the target it was uploaded with. Retargeting one afterwards (PATCH, or
// promote with another version) carries the label to a version it does not name —
// cli-capacitor-tech-spec §4 has the consequence.

export const BINARY_VERSION_FINGERPRINT_PREFIX = "binary-version:";

/**
 * The value this CLI sends as a release's `fingerprint`. The prefix cannot occur
 * in a computed fingerprint (those are hex digests), so a server or dashboard can
 * always tell "scoped to its binary version" from "hash of a native project".
 */
export function binaryVersionFingerprint(targetBinaryVersion: string): string {
  return `${BINARY_VERSION_FINGERPRINT_PREFIX}${targetBinaryVersion}`;
}
