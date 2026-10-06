// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchModule.swift's metrics-queue methods (`commitMetricEvent`,
// `readCommittedMetricEvents`, `applyMetricMetadataSideEffect`) (Apache-2.0). Same
// on-disk layout, cap, and retention window — see client/specs/metrics/Spec.md § Native
// Queue Bridge Contract / § Queue Size Limit and Eviction / § Retention Window.
import Foundation

/// One committed WAL entry, resolved from disk for a flush attempt.
struct CodemagicPatchMetricEvent {
    let url: URL
    let eventId: String
    let envelope: [String: Any]
}

/// The on-device write-ahead log for metric events. Every operation here treats an event
/// envelope as opaque JSON — parsed only far enough to read `event_id` (for the filename)
/// and, on flush, to build the batch request body — so a `reason`/`attributes` value this
/// SDK version does not recognize is stored and forwarded unchanged. That is what makes
/// "tolerate future reason codes" (specs/IMPLEMENTATION-PLAN.md Phase 5) true by
/// construction rather than by an allowlist check.
///
/// All operations are called from within a single caller-held lock
/// (`CodemagicPatchMetricsDelivery.lock`) — this class itself performs no
/// synchronization, matching upstream's actual `withCodemagicPatchMetricsLock` shape
/// (client/specs/sdk-native/Spec.md § Thread Safety).
final class CodemagicPatchMetricsQueue {
    private static let maxQueueSize = 100
    private static let retentionSeconds: TimeInterval = 7 * 24 * 60 * 60

    private let storage: CodemagicPatchStorage

    init(storage: CodemagicPatchStorage) {
        self.storage = storage
    }

    /// Persists `eventJson` durably before any network attempt, applies the
    /// Active/Applied metadata side effect, and enforces the queue cap. Never throws —
    /// `enqueueMetricEvent()` must resolve after the attempt regardless of outcome
    /// (client/specs/metrics/Spec.md § Native Queue Bridge Contract: "a failed enqueue
    /// may drop that metric event, but it must not surface as INTEGRITY_ERROR").
    func enqueue(_ eventJson: String) {
        guard let data = eventJson.data(using: .utf8),
              let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let eventId = event["event_id"] as? String, isSafeEventId(eventId) else {
            return
        }
        try? storage.writeBytes("events/\(eventId).json", data)
        applyMetricMetadataSideEffect(event)
        storage.enforceEventQueueCap(maxEvents: Self.maxQueueSize)
    }

    /// Committed events ready to send, oldest first, with corrupt or retention-expired
    /// entries deleted as a side effect (client/specs/metrics/Spec.md § Corruption
    /// Recovery on Read / § Retention Window — both scoped to flush time, not enqueue).
    func listPendingForFlush() -> [CodemagicPatchMetricEvent] {
        let dir = storage.root.appendingPathComponent("events", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let cutoff = Date().addingTimeInterval(-Self.retentionSeconds)

        let sorted = files
            .filter { $0.pathExtension == "json" }
            .sorted { modificationDate(of: $0) < modificationDate(of: $1) }

        return sorted.compactMap { url in
            if modificationDate(of: url) < cutoff {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            guard let data = try? Data(contentsOf: url),
                  let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let eventId = envelope["event_id"] as? String, isSafeEventId(eventId) else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return CodemagicPatchMetricEvent(url: url, eventId: eventId, envelope: envelope)
        }
    }

    /// Code-review finding: this used to call `FileManager.default.removeItem`
    /// directly, unlike Android's equivalent (`CodemagicPatchStorage.delete`), which
    /// fsyncs the parent directory after removing. Without that, a power loss right
    /// after a successful `POST` could resurrect an already-delivered event on next
    /// launch (harmless — the server's own dedup on `event_id` covers a re-delivery —
    /// but needlessly so, when the durable helper already exists and every other
    /// removal in this codebase already goes through it).
    func remove(_ event: CodemagicPatchMetricEvent) {
        storage.removeItemDurably(at: event.url)
    }

    private func modificationDate(of url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
    }

    private func isSafeEventId(_ eventId: String) -> Bool {
        guard !eventId.isEmpty else { return false }
        return eventId.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }

    /// Stamps `success_reported_at`/`last_active_reported_at` onto the target package's
    /// `update.json` when this event is an `Applied`/`Active` report — the persisted
    /// half of the once-ever / once-per-24h dedupe rule JS enforces in memory
    /// (src/protocol/events.ts, src/protocol/runtime.ts). Without this, a fresh process
    /// has no way to know a previous one already reported it, and `Applied`/`Active`
    /// would fire on every single launch.
    ///
    /// Code-review finding (critical): this checked for the pre-rename `Success` event
    /// name (PROTOCOL.md § Metric Lifecycle Names). JS now emits `Applied` — see
    /// src/protocol/notifyAppReady.ts — and this must recognize it, or a rename on the
    /// JS side alone would silently stop `success_reported_at` from ever being
    /// persisted again. The storage key itself stays `success_reported_at`/
    /// `successReportedAt`, per the protocol's own instruction to keep it stable across
    /// the rename.
    private func applyMetricMetadataSideEffect(_ event: [String: Any]) {
        guard let eventName = event["event_name"] as? String,
              eventName == "Active" || eventName == "Applied",
              let packageHash = event["target_package_hash"] as? String,
              CodemagicPatchStorage.isSafePackageHash(packageHash),
              var metadata = storage.readJson("packages/\(packageHash)/update.json") else {
            return
        }

        let emittedAt = event["emitted_at"] as? String ?? CodemagicPatchUtil.currentIsoTimestamp()
        if eventName == "Active" {
            metadata["last_active_reported_at"] = emittedAt
        } else {
            metadata["success_reported_at"] = emittedAt
        }
        try? storage.writeJson("packages/\(packageHash)/update.json", metadata)
    }
}

/// Builds the native-owned crash-rollback `Failed` event envelope
/// (client/specs/sdk-native/Spec.md § Crash Rollback Detection step 5) — JS may not run
/// before rollback is applied, so this can't wait for `src/protocol/events.ts`. Kept out
/// of `CodemagicPatchPlugin` (which stays a thin Capacitor-bridging layer by design) and
/// out of `CodemagicPatchMetricsQueue` (whose job is persisting an envelope, not
/// constructing one) — this is protocol/metrics domain logic, so it lives alongside the
/// rest of that domain in this file.
///
/// `deploymentKey` is passed in as whatever the caller's config resolved to, even if
/// invalid (an empty string): metrics are best-effort and must never depend on OTA
/// configuration being correct, only the boot-selection/rollback logic itself does. No
/// `payload` field is ever included: its only defined content today is
/// `android_previous_process_exit`, which has no iOS equivalent ("Omitted on iOS ...
/// where no platform API can answer the question" — PROTOCOL.md § Metric Event `Failed`
/// Payload) — `payload` itself is optional and must not be sent as an empty object when
/// there's nothing to put in it. Returns `nil` only if `JSONSerialization` itself somehow
/// fails to encode a `[String: Any]` built entirely from strings — should not happen in
/// practice, but this stays best-effort rather than force-unwrapping.
enum CodemagicPatchCrashRollbackEvent {
    static func envelope(
        binaryVersion: String,
        deviceId: String,
        deploymentKey: String,
        packageHash: String,
        failedAt: String
    ) -> String? {
        let eventId = CodemagicPatchUtil.crashRollbackEventId(deviceId: deviceId, packageHash: packageHash, failedAt: failedAt)
        let envelope: [String: Any] = [
            "event_id": eventId,
            "event_name": "Failed",
            "emitted_at": failedAt,
            "device_id": deviceId,
            "deployment_key": deploymentKey,
            "binary_version": binaryVersion,
            "running_package_hash": NSNull(),
            "target_package_hash": packageHash,
            "platform": "capacitor",
            // Keep in sync with package.json's "version" — same constant as
            // src/protocol/events.ts's SDK_VERSION, enforced there by
            // src/protocol/events.test.ts. Native has no runtime access to
            // package.json (see that file's comment on why not to read it live).
            "sdk_version": "0.1.0",
            "attributes": [
                "reason": "install_fail",
                "failure_subtype": "crash_rollback"
            ]
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}
