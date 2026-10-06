// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/CodemagicPatchModule.kt's metrics-queue
// methods (`commitMetricEvent`, `readCommittedMetricEvents`, `applyMetricMetadataSideEffect`)
// (Apache-2.0). Same on-disk layout, cap, and retention window — see
// client/specs/metrics/Spec.md § Native Queue Bridge Contract / § Queue Size Limit and
// Eviction / § Retention Window.
package io.codemagic.patch

import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/** One committed WAL entry, resolved from disk for a flush attempt. */
internal data class CodemagicPatchMetricEvent(
    val file: File,
    val eventId: String,
    val envelope: JSONObject,
)

/**
 * The on-device write-ahead log for metric events. Every operation here treats an event
 * envelope as opaque JSON — parsed only far enough to read `event_id` (for the filename)
 * and, on flush, to build the batch request body — so a `reason`/`attributes` value this
 * SDK version does not recognize is stored and forwarded unchanged. That is what makes
 * "tolerate future reason codes" (specs/IMPLEMENTATION-PLAN.md Phase 5) true by
 * construction rather than by an allowlist check.
 *
 * All operations are called from within a single caller-held lock
 * (`CodemagicPatchMetricsDelivery.lock`) — this class itself performs no synchronization,
 * matching upstream's actual `synchronized(CodemagicPatchExecutors.metricsLock)` shape
 * (client/specs/sdk-native/Spec.md § Thread Safety).
 */
internal class CodemagicPatchMetricsQueue(
    private val storage: CodemagicPatchStorage,
) {
    private companion object {
        const val MAX_QUEUE_SIZE = 100
        val RETENTION_MILLIS = TimeUnit.DAYS.toMillis(7)
        val UNSAFE_EVENT_ID = Regex("[^A-Za-z0-9._-]")
    }

    /**
     * Persists [eventJson] durably before any network attempt, applies the
     * Active/Applied metadata side effect, and enforces the queue cap. Never throws —
     * `enqueueMetricEvent()` must resolve after the attempt regardless of outcome
     * (client/specs/metrics/Spec.md § Native Queue Bridge Contract: "a failed enqueue
     * may drop that metric event, but it must not surface as INTEGRITY_ERROR").
     */
    fun enqueue(eventJson: String) {
        try {
            val event = JSONObject(eventJson)
            val eventId = event.optString("event_id").takeIf(::isSafeEventId) ?: return
            storage.writeText("events/$eventId.json", eventJson)
            applyMetricMetadataSideEffect(event)
            storage.enforceEventQueueCap(MAX_QUEUE_SIZE)
        } catch (_: Exception) {
            // Best-effort: drop the event rather than propagate.
        }
    }

    /**
     * Committed events ready to send, oldest first, with corrupt or retention-expired
     * entries deleted as a side effect (client/specs/metrics/Spec.md § Corruption
     * Recovery on Read / § Retention Window — both scoped to flush time, not enqueue).
     */
    fun listPendingForFlush(): List<CodemagicPatchMetricEvent> {
        val cutoffMs = System.currentTimeMillis() - RETENTION_MILLIS
        return storage
            .listFiles("events")
            .filter { it.name.endsWith(".json") }
            .sortedBy { it.lastModified() }
            .mapNotNull { file ->
                if (file.lastModified() < cutoffMs) {
                    file.delete()
                    return@mapNotNull null
                }
                val envelope =
                    try {
                        JSONObject(file.readText(Charsets.UTF_8))
                    } catch (_: Exception) {
                        file.delete()
                        return@mapNotNull null
                    }
                val eventId = envelope.optString("event_id").takeIf(::isSafeEventId)
                if (eventId == null) {
                    file.delete()
                    return@mapNotNull null
                }
                CodemagicPatchMetricEvent(file, eventId, envelope)
            }
    }

    fun remove(event: CodemagicPatchMetricEvent) {
        storage.delete("events/${event.file.name}")
    }

    private fun isSafeEventId(eventId: String): Boolean = eventId.isNotBlank() && !UNSAFE_EVENT_ID.containsMatchIn(eventId)

    /**
     * Stamps `success_reported_at`/`last_active_reported_at` onto the target package's
     * `update.json` when this event is an `Applied`/`Active` report — the persisted half
     * of the once-ever / once-per-24h dedupe rule JS enforces in memory
     * (src/protocol/events.ts, src/protocol/runtime.ts). Without this, a fresh process
     * has no way to know a previous one already reported it, and `Applied`/`Active`
     * would fire on every single launch.
     *
     * Code-review finding (critical): this checked for the pre-rename `Success` event
     * name (PROTOCOL.md § Metric Lifecycle Names). JS now emits `Applied` — see
     * src/protocol/notifyAppReady.ts — and this must recognize it, or a rename on the
     * JS side alone would silently stop `success_reported_at` from ever being
     * persisted again. The storage key itself stays `success_reported_at`/
     * `successReportedAt`, per the protocol's own instruction to keep it stable across
     * the rename.
     */
    private fun applyMetricMetadataSideEffect(event: JSONObject) {
        val eventName = event.optString("event_name")
        if (eventName != "Active" && eventName != "Applied") return

        val packageHash = event.optString("target_package_hash")
        if (!storage.isSafePackageHash(packageHash)) return

        val metadata = storage.packageMetadata(packageHash) ?: return
        val emittedAt = event.optString("emitted_at").takeIf { it.isNotBlank() } ?: CodemagicPatchUtil.currentIsoTimestamp()
        if (eventName == "Active") {
            metadata.put("last_active_reported_at", emittedAt)
        } else {
            metadata.put("success_reported_at", emittedAt)
        }
        storage.writeJson("packages/$packageHash/update.json", metadata)
    }
}
