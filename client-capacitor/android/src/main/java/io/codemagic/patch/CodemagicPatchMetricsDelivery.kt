// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/CodemagicPatchModule.kt's
// `flushMetricEventsLocked`/`scheduleMetricRetry`/`resetMetricRetry`/`acknowledgedMetricFiles`
// (Apache-2.0). One deliberate divergence, consistent with every other network call in this
// port (see specs/UPSTREAM-DIVERGENCE.md): plain `HttpURLConnection`, not OkHttp — upstream
// itself already uses `HttpURLConnection` for this one call site (not its own OkHttp
// client), so this is a non-divergence in practice, just ported as-is.
package io.codemagic.patch

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

/** What a batch response status means for the WAL — see [CodemagicPatchMetricsDelivery.outcomeForStatus]. */
internal enum class BatchOutcome { ACKNOWLEDGE, DROP, RETRY }

/**
 * Batches and delivers the metrics WAL to `POST {apiUrl}/v1/metrics/events`
 * (client/specs/metrics/Spec.md § Delivery Strategy). Enqueue and flush both run through
 * [lock], so a flush triggered by [android.app.Activity] resume can never tear a write
 * triggered by a concurrent plugin call — the two arrive on different threads (Capacitor's
 * own plugin-call dispatch thread vs. this class's own executor), unlike every other native
 * method in this project, which Capacitor's own single dispatch thread already serializes.
 */
internal class CodemagicPatchMetricsDelivery(
    private val queue: CodemagicPatchMetricsQueue,
    // Real production defaults; overridable so tests can exercise the full retry/
    // backoff/exhaustion path in well under a second instead of the ~30s a real cap
    // would take — see CodemagicPatchMetricsDeliveryTest.kt.
    private val baseRetryMs: Long = BASE_RETRY_MS,
    private val maxRetryMs: Long = MAX_RETRY_MS,
) {
    internal companion object {
        const val BATCH_LIMIT = 100
        const val MAX_RETRY_ATTEMPTS = 5
        const val BASE_RETRY_MS = 1_000L
        const val MAX_RETRY_MS = 60_000L

        // A dedicated single-thread executor, not a pool: "serialize all metrics queue
        // operations on the native I/O executor" (client/specs/sdk-native/Spec.md §
        // Thread Safety) — a pool would let a delayed retry race a fresh flush.
        val executor: ScheduledExecutorService =
            Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "CodemagicPatchMetrics").apply { isDaemon = true }
            }

        /**
         * client/specs/metrics/Spec.md § Delivery Strategy: 2xx acknowledges: 4xx other
         * than 408/429 is permanent (drop the batch, it cannot succeed on retry); 408,
         * 429, and every 5xx are transient (retry with backoff). A pure function of the
         * status code, with no I/O, so this is testable as a plain JVM unit test rather
         * than needing a real HTTP round trip per case.
         */
        fun outcomeForStatus(status: Int): BatchOutcome =
            when {
                status in 200..299 -> BatchOutcome.ACKNOWLEDGE
                status in 400..499 && status !in intArrayOf(408, 429) -> BatchOutcome.DROP
                else -> BatchOutcome.RETRY
            }
    }

    private val lock = Any()
    private var retryAttempt = 0
    private var retryScheduled = false
    private var backoffUntilMs = 0L

    /**
     * Persists [eventJson] synchronously on the calling thread (already a Capacitor
     * plugin-call background thread, never the UI thread — see the class doc comment),
     * so `enqueueMetricEvent()` resolves only once the write attempt has actually
     * completed, per client/specs/metrics/Spec.md § Native Queue Bridge Contract.
     */
    fun enqueue(eventJson: String) {
        synchronized(lock) { queue.enqueue(eventJson) }
    }

    /**
     * Triggers a flush attempt on the metrics executor — never call this from the
     * caller's own thread, since it performs blocking network I/O. Safe to call from a
     * lifecycle callback (`Plugin.handleOnResume()`): "flush only on native-observed
     * foreground entry ... not immediately after enqueue, after notifyAppReady(), or on
     * background entry" (client/specs/metrics/Spec.md § Native Queue Bridge Contract).
     */
    fun flushAsync(apiUrl: String) {
        if (apiUrl.isBlank()) return
        executor.execute { flushLocked(apiUrl.trimEnd('/')) }
    }

    private fun flushLocked(apiUrl: String) {
        synchronized(lock) {
            if (isRetryDeferred()) return
            // Clear it here, under the lock, whether this call is a fresh foreground-entry
            // flush (where it's already false) or the scheduled retry's own invocation
            // (where this is the "the wait is over" transition) — see scheduleRetry.
            retryScheduled = false
            var events = queue.listPendingForFlush()
            while (events.isNotEmpty()) {
                val batch = events.take(BATCH_LIMIT)
                if (!sendBatch(apiUrl, batch)) return
                events = events.drop(batch.size)
            }
        }
    }

    /** Returns `false` on a transient failure (a retry was scheduled), `true` otherwise. */
    private fun sendBatch(
        apiUrl: String,
        batch: List<CodemagicPatchMetricEvent>,
    ): Boolean {
        val body = JSONObject().put("events", JSONArray(batch.map { it.envelope })).toString()
        val connection = URL("$apiUrl/v1/metrics/events").openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")

        try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            when (outcomeForStatus(status)) {
                BatchOutcome.ACKNOWLEDGE -> {
                    acknowledged(batch, responseBody(connection)).forEach(queue::remove)
                    resetRetry()
                    return true
                }
                BatchOutcome.DROP -> {
                    // A permanent client error other than the two transient 4xx codes:
                    // malformed payloads will not succeed on retry.
                    batch.forEach(queue::remove)
                    resetRetry()
                    return true
                }
                BatchOutcome.RETRY -> {
                    // 408, 429, or 5xx: transient server error, retry with backoff.
                    scheduleRetry(apiUrl, connection.getHeaderField("Retry-After"))
                    return false
                }
            }
        } catch (_: IOException) {
            // Network error (no response): transient, retry with backoff.
            scheduleRetry(apiUrl, null)
            return false
        } finally {
            connection.disconnect()
        }
    }

    private fun responseBody(connection: HttpURLConnection): String {
        val stream =
            try {
                connection.inputStream
            } catch (_: IOException) {
                connection.errorStream
            } ?: return ""
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    /**
     * Per client/specs/metrics/Spec.md § Batch Transmission: an empty/invalid body, or
     * one missing `acknowledged_event_ids`, is treated as whole-batch acknowledgment on
     * a 2xx; otherwise only the named ids are removed.
     */
    private fun acknowledged(
        batch: List<CodemagicPatchMetricEvent>,
        responseText: String,
    ): List<CodemagicPatchMetricEvent> {
        val body = responseText.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return batch
        val array = body.optJSONArray("acknowledged_event_ids") ?: return batch
        val acknowledgedIds =
            buildSet {
                for (index in 0 until array.length()) {
                    array.optString(index).takeIf { it.isNotBlank() }?.let(::add)
                }
            }
        return batch.filter { it.eventId in acknowledgedIds }
    }

    private fun isRetryDeferred(): Boolean = retryScheduled && System.currentTimeMillis() < backoffUntilMs

    private fun resetRetry() {
        retryAttempt = 0
        backoffUntilMs = 0L
    }

    /**
     * Exponential backoff with jitter, capped at [MAX_RETRY_ATTEMPTS] per flush cycle —
     * client/specs/metrics/Spec.md § Retry with Exponential Backoff. Once exhausted,
     * this stops rescheduling itself entirely; the queue is retried again only on the
     * next natural `flushAsync()` call (the next foreground entry).
     */
    private fun scheduleRetry(
        apiUrl: String,
        retryAfterHeader: String?,
    ) {
        if (retryAttempt >= MAX_RETRY_ATTEMPTS || retryScheduled) return
        val retryAfterMs = retryAfterHeader?.toLongOrNull()?.let { it * 1000L }
        val baseMs = retryAfterMs ?: min(maxRetryMs.toDouble(), baseRetryMs * 2.0.pow(retryAttempt.toDouble())).toLong()
        val jitteredMs = (baseMs * (1.0 + Math.random() * 0.2)).toLong()
        retryAttempt += 1
        retryScheduled = true
        backoffUntilMs = System.currentTimeMillis() + jitteredMs

        executor.schedule({ flushLocked(apiUrl) }, jitteredMs, TimeUnit.MILLISECONDS)
    }
}
