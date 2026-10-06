// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchModule.swift's
// `flushMetricEventsLocked`/`scheduleMetricRetry`/`resetMetricRetry`/`acknowledgedMetricUrls`
// (Apache-2.0). Same synchronous `URLSession` + `DispatchSemaphore` shape this project's
// own `CodemagicPatchManifestClient`/`CodemagicPatchDownloader` already use — safe off
// the main thread for the same reason documented there (Capacitor's own plugin-call
// dispatch queue).
import Foundation
import UIKit

/// Batches and delivers the metrics WAL to `POST {apiUrl}/v1/metrics/events`
/// (client/specs/metrics/Spec.md § Delivery Strategy). Enqueue and flush both run
/// through `lock`, so a flush triggered by app-foreground entry can never tear a write
/// triggered by a concurrent plugin call — the two can arrive on different threads
/// (Capacitor's own plugin-call dispatch queue vs. this class's own serial queue),
/// unlike every other native method in this project, which Capacitor's single dispatch
/// queue already serializes.
final class CodemagicPatchMetricsDelivery {
    private static let batchLimit = 100
    private static let maxRetryAttempts = 5

    private let queue: CodemagicPatchMetricsQueue
    private let session: URLSession
    // Real production defaults (1s base, 60s cap); overridable so tests can exercise
    // the full retry/backoff/exhaustion path in well under a second instead of the
    // ~30s a real cap would take — see CodemagicPatchMetricsDeliveryTests.swift.
    private let baseRetryInterval: TimeInterval
    private let maxRetryInterval: TimeInterval
    private let lock = NSLock()
    // A dedicated serial queue, not a concurrent one: "serialize all metrics queue
    // operations on the native I/O executor" (client/specs/sdk-native/Spec.md § Thread
    // Safety) — a concurrent queue would let a delayed retry race a fresh flush.
    private let dispatchQueue = DispatchQueue(label: "io.codemagic.patch.metrics")

    private var retryAttempt = 0
    private var retryScheduled = false
    private var backoffUntil: Date?

    init(
        queue: CodemagicPatchMetricsQueue,
        session: URLSession = .shared,
        baseRetryInterval: TimeInterval = 1,
        maxRetryInterval: TimeInterval = 60
    ) {
        self.queue = queue
        self.session = session
        self.baseRetryInterval = baseRetryInterval
        self.maxRetryInterval = maxRetryInterval
    }

    /// Persists `eventJson` synchronously on the calling thread (already off the main
    /// thread — see the class doc comment), so `enqueueMetricEvent()` resolves only
    /// once the write attempt has actually completed, per client/specs/metrics/Spec.md §
    /// Native Queue Bridge Contract.
    func enqueue(_ eventJson: String) {
        lock.lock()
        defer { lock.unlock() }
        queue.enqueue(eventJson)
    }

    /// Triggers a flush attempt on the metrics dispatch queue — never call this from
    /// the caller's own thread, since it performs blocking network I/O. Safe to call
    /// from a foreground-entry notification: "flush only on native-observed foreground
    /// entry ... not immediately after enqueue, after notifyAppReady(), or on
    /// background entry" (client/specs/metrics/Spec.md § Native Queue Bridge Contract).
    func flushAsync(apiUrl: String) {
        guard !apiUrl.isEmpty else { return }
        let trimmed = apiUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        dispatchQueue.async { [weak self] in
            self?.flushLocked(apiUrl: trimmed)
        }
    }

    private func flushLocked(apiUrl: String) {
        lock.lock()
        defer { lock.unlock() }

        if isRetryDeferred() { return }
        // Clear it here, under the lock, whether this call is a fresh foreground-entry
        // flush (where it's already false) or the scheduled retry's own invocation
        // (where this is the "the wait is over" transition) — see scheduleRetry.
        retryScheduled = false

        var events = queue.listPendingForFlush()
        while !events.isEmpty {
            let batch = Array(events.prefix(Self.batchLimit))
            guard sendBatch(apiUrl: apiUrl, batch: batch) else { return }
            events.removeFirst(batch.count)
        }
    }

    /// Returns `false` on a transient failure (a retry was scheduled), `true` otherwise.
    private func sendBatch(apiUrl: String, batch: [CodemagicPatchMetricEvent]) -> Bool {
        guard let url = URL(string: "\(apiUrl)/v1/metrics/events"),
              let body = try? JSONSerialization.data(withJSONObject: ["events": batch.map { $0.envelope }]) else {
            // A malformed URL/body can never succeed on retry — drop this batch rather
            // than spin on it forever.
            batch.forEach(queue.remove)
            return true
        }

        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let semaphore = DispatchSemaphore(value: 0)
        var statusCode: Int?
        var responseData: Data?
        var retryAfter: String?
        var responseError: Error?
        session.dataTask(with: request) { data, response, error in
            if let http = response as? HTTPURLResponse {
                statusCode = http.statusCode
                retryAfter = http.value(forHTTPHeaderField: "Retry-After")
            }
            responseData = data
            responseError = error
            semaphore.signal()
        }.resume()
        semaphore.wait()

        guard responseError == nil, let status = statusCode else {
            // Network error (no response): transient, retry with backoff.
            scheduleRetry(apiUrl: apiUrl, retryAfter: retryAfter)
            return false
        }

        if (200...299).contains(status) {
            acknowledged(batch: batch, data: responseData).forEach(queue.remove)
            resetRetry()
            return true
        }
        if (400...499).contains(status), status != 408, status != 429 {
            // Permanent client error other than the two transient 4xx codes:
            // malformed payloads will not succeed on retry.
            batch.forEach(queue.remove)
            resetRetry()
            return true
        }
        // 408, 429, or 5xx: transient server error, retry with backoff.
        scheduleRetry(apiUrl: apiUrl, retryAfter: retryAfter)
        return false
    }

    /// Per client/specs/metrics/Spec.md § Batch Transmission: an empty/invalid body, or
    /// one missing `acknowledged_event_ids`, is treated as whole-batch acknowledgment on
    /// a 2xx; otherwise only the named ids are removed.
    ///
    /// Code-review finding: this used to require `as? [String]` on the whole array, so
    /// a single non-string element (a stray number, say) failed the cast and silently
    /// whole-batch-acknowledged everything else too — treating "one element the wrong
    /// type" the same as "the whole body is unparseable", which loses more than it
    /// needs to. Android's equivalent already coerces per element rather than failing
    /// the whole array; this now does the same, keeping only the elements that are
    /// actually strings and ignoring the rest, rather than discarding all of them.
    private func acknowledged(batch: [CodemagicPatchMetricEvent], data: Data?) -> [CodemagicPatchMetricEvent] {
        guard let data, !data.isEmpty,
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let ids = body["acknowledged_event_ids"] as? [Any] else {
            return batch
        }
        let acknowledgedIds = Set(ids.compactMap { $0 as? String })
        return batch.filter { acknowledgedIds.contains($0.eventId) }
    }

    private func isRetryDeferred() -> Bool {
        guard retryScheduled, let until = backoffUntil else { return false }
        return Date() < until
    }

    private func resetRetry() {
        retryAttempt = 0
        backoffUntil = nil
    }

    /// Exponential backoff with jitter, capped at `maxRetryAttempts` per flush cycle —
    /// client/specs/metrics/Spec.md § Retry with Exponential Backoff. Once exhausted,
    /// this stops rescheduling itself entirely; the queue is retried again only on the
    /// next natural `flushAsync()` call (the next foreground entry).
    private func scheduleRetry(apiUrl: String, retryAfter: String?) {
        guard retryAttempt < Self.maxRetryAttempts, !retryScheduled else { return }

        let retryAfterSeconds = retryAfter.flatMap { TimeInterval($0) }
        let base = retryAfterSeconds ?? min(maxRetryInterval, baseRetryInterval * pow(2, Double(retryAttempt)))
        let delay = base * (1 + Double.random(in: 0...0.2))
        retryAttempt += 1
        retryScheduled = true
        backoffUntil = Date().addingTimeInterval(delay)

        dispatchQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.flushLocked(apiUrl: apiUrl)
        }
    }
}

extension CodemagicPatchMetricsDelivery {
    /// "Flush only on native-observed foreground entry, including first foreground
    /// entry after process launch and later background → foreground resume
    /// transitions" (client/specs/metrics/Spec.md § Native Queue Bridge Contract).
    /// `CAPPlugin` has no Android-style `handleOnResume()` hook on iOS, so this
    /// subscribes directly to the same notification Capacitor's own lifecycle plumbing
    /// is built on — `didBecomeActive` fires for both cases (a fresh launch's first
    /// activation and every later resume), so no separate first-launch hook is needed.
    /// `apiUrl` is resolved lazily on each firing (not captured once) so this stays
    /// correct across a config that resolves only after this call — pass a closure
    /// reading whatever the caller's own config state is at that moment.
    func observeForegroundEntry(resolvingApiUrl apiUrl: @escaping () -> String?) {
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
            guard let url = apiUrl() else { return }
            self?.flushAsync(apiUrl: url)
        }
    }
}
