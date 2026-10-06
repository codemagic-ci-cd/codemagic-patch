// Mirrors ios/Sources/CodemagicPatchPlugin/CodemagicPatchMetricsQueue.swift's
// CodemagicPatchCrashRollbackEvent — extracted out of CodemagicPatchPlugin (which stays
// a thin Capacitor-bridging layer by design) into its own free, Context-free type
// specifically so it is unit-testable without a Bridge/PluginCall, unlike the plugin
// method that calls it. A code-review finding noted this was the one asymmetry between
// the two platforms' crash-rollback event construction: iOS already had this split
// (originally for a SwiftLint type_body_length reason, but it also happened to make the
// envelope testable), while Android inlined it into a private plugin method no test
// could reach — and this is the *only* one of the two envelopes carrying
// `payload.android_previous_process_exit`, so that gap meant zero shape coverage for it
// anywhere.
package io.codemagic.patch

/**
 * Builds the native-owned crash-rollback `Failed` event envelope
 * (client/specs/sdk-native/Spec.md § Crash Rollback Detection step 5) — JS may not run
 * before rollback is applied, so this can't wait for `src/protocol/events.ts`.
 *
 * `deploymentKey` is passed in as whatever the caller's config resolved to, even if
 * invalid (an empty string): metrics are best-effort and must never depend on OTA
 * configuration being correct, only the boot-selection/rollback logic itself does.
 * `previousProcessExit` is omitted from `attributes.payload` entirely when null (Android
 * 10 and older, or no record yet) — `payload` itself is optional and must not be sent as
 * an empty object when there's nothing to put in it.
 */
internal object CodemagicPatchCrashRollbackEvent {
    fun envelope(
        binaryVersion: String,
        deviceId: String,
        deploymentKey: String,
        packageHash: String,
        failedAt: String,
        previousProcessExit: String?,
    ): String {
        val eventId = CodemagicPatchUtil.crashRollbackEventId(deviceId, packageHash, failedAt)
        val attributes =
            jsObjectOf(
                mapOf(
                    "reason" to "install_fail",
                    "failure_subtype" to "crash_rollback",
                ),
            )
        previousProcessExit?.let { exitReason ->
            attributes.put(
                "payload",
                jsObjectOf(mapOf("android_previous_process_exit" to exitReason)).toString(),
            )
        }
        val envelope =
            jsObjectOf(
                mapOf(
                    "event_id" to eventId,
                    "event_name" to "Failed",
                    "emitted_at" to failedAt,
                    "device_id" to deviceId,
                    "deployment_key" to deploymentKey,
                    "binary_version" to binaryVersion,
                    "running_package_hash" to null,
                    "target_package_hash" to packageHash,
                    "platform" to "capacitor",
                    // Keep in sync with package.json's "version" — same constant as
                    // src/protocol/events.ts's SDK_VERSION, enforced there by
                    // src/protocol/events.test.ts. Native has no runtime access to
                    // package.json (see that file's comment on why not to read it live).
                    "sdk_version" to "0.1.0",
                    "attributes" to attributes,
                ),
            )
        return envelope.toString()
    }
}
