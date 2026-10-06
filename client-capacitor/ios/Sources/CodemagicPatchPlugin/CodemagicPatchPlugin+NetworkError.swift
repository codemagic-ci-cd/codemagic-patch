import Capacitor
import Foundation

/// Extracted out of `CodemagicPatchPlugin` itself purely to stay under SwiftLint's
/// `type_body_length` limit (the same reason `CodemagicPatchCrashRollbackEvent` and
/// `CodemagicPatchMetricsDelivery.observeForegroundEntry` were split out in Phase 5) —
/// this is still plugin-bridging glue, not domain logic, so it stays an extension of
/// the plugin class rather than moving to its own type.
extension CodemagicPatchPlugin {
    /// Shared HTTP-failure rejection for `fetchManifest`/`downloadUpdate`: carries the
    /// HTTP status/message under `error.data.detail_code`/`detail_message`
    /// (`src/protocol/failurePayload.ts`'s `networkFailurePayload`) — verified against
    /// Capacitor's actual bridge, `PluginCallResult.swift`'s error nesting (see
    /// specs/UPSTREAM-DIVERGENCE.md's "Native rejection detail" row).
    ///
    /// `context` merges additional string fields onto the same `data` object —
    /// `fetchManifest()` uses this to carry `deployment_key`/`binary_version` (resolved
    /// from local config before the fetch was ever attempted) onto a *rejected* call
    /// too, not just a resolved one: `state.deploymentKey`/`state.binaryVersion`
    /// (src/protocol/runtime.ts) have no other source before a manifest fetch first
    /// succeeds, so without this, a device's first check of the process — or every
    /// check, for a sustained outage — would record a `Failed(reason=network)` event
    /// with a blank `deployment_key`, which the server's required-field validation
    /// silently drops rather than persists (a code-review follow-up finding).
    func rejectNetworkError(_ call: CAPPluginCall, method: String, error: Error, context: [String: Any] = [:]) {
        var data: [String: Any] = [
            CodemagicPatchFailure.detailCodeKey: CodemagicPatchFailure.httpStatusCode(error),
            CodemagicPatchFailure.detailMessageKey: error.localizedDescription
        ]
        for (key, value) in context {
            data[key] = value
        }
        call.reject("CodemagicPatch.\(method)() failed: \(error.localizedDescription)", "NETWORK_ERROR", error, data)
    }
}
