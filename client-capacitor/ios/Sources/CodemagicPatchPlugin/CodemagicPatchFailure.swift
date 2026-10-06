// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchFailure.swift (Apache-2.0). Phase 3 ported only the
// crash-loop launch-attempt budget; the HTTP-failure detail-code/message plumbing below
// is added now that fetchManifest()/downloadUpdate() (Phase 4) actually produce HTTP
// failures to classify. There is no iOS equivalent of Android's ApplicationExitInfo
// capture — BootState.androidPreviousProcessExit is always null on iOS
// (src/definitions.ts). The configurable budget (`defaultMaxLaunchAttempts`/
// `maxLaunchAttemptsKey`) follows
// codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9 (client v0.5.0).
import Foundation

/// The domain `httpStatusCode(_:)` recognizes — distinct from whatever domain a
/// transport-level failure (no connectivity, DNS failure) surfaces under, so the two
/// are never confused: only an error actually built by `CodemagicPatchFailure.httpError`
/// carries a real HTTP status at all.
let codemagicPatchHttpErrorDomain = "CodemagicPatchHTTP"

enum CodemagicPatchFailure {
    /// Consecutive launches a pending package may boot without `notifyAppReady()`
    /// before the SDK treats it as a crash, unless the host overrides it (see
    /// `CodemagicPatchConfigResolver.resolveMaxLaunchAttempts`). A single unconfirmed
    /// launch is not evidence of a crash — the OS can reclaim a healthy process before JS
    /// runs — so rollback waits for the whole budget to be spent.
    static let defaultMaxLaunchAttempts = 3

    /// `Info.plist` key that overrides the launch-attempt budget — upstream's own name.
    static let maxLaunchAttemptsKey = "CodemagicPatchMaxLaunchAttempts"

    /// Key under which the HTTP status travels in a rejected call's `data`.
    static let detailCodeKey = "detail_code"

    /// Key under which the aggregation-facing failure text travels.
    static let detailMessageKey = "detail_message"

    /// `PROTOCOL.md`: the request produced no HTTP response.
    static let noResponseCode = "0"

    /// How much of a failed response body to read. S3-style error XML runs a few
    /// hundred bytes; a CDN that answers with its own HTML error page can run to tens
    /// of kilobytes, and none of it past this point is worth holding in memory to
    /// extract two tags from.
    private static let errorBodyMaxBytes = 4096

    /// Builds the `NSError` a failed HTTP response is surfaced as, tagged with the
    /// domain `httpStatusCode(_:)` recognizes.
    static func httpError(status: Int, message: String) -> NSError {
        NSError(
            domain: codemagicPatchHttpErrorDomain,
            code: status,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    /// The failed response's HTTP status, or `noResponseCode` when the request never
    /// got one (a transport-level failure, not an HTTP one) — only an error built by
    /// `httpError(status:message:)` carries a real status.
    static func httpStatusCode(_ error: Error) -> String {
        let nsError = error as NSError
        guard nsError.domain == codemagicPatchHttpErrorDomain else {
            return noResponseCode
        }
        return String(nsError.code)
    }

    /// The origin's own words for a failed request, relayed rather than invented.
    ///
    /// OTA artifacts and manifests are served by object storage or a CDN, never by the
    /// API server, and those answer a non-2xx with an error document naming what went
    /// wrong — `NoSuchKey` for an artifact that was never uploaded, `AccessDenied` for a
    /// bucket policy, `SignatureDoesNotMatch` for signing. That distinction is the whole
    /// diagnostic value of a 403 or 404, and it is something only the origin can say.
    ///
    /// Only `<Code>` and `<Message>` are taken, because the same document also carries
    /// `<Key>` and `<Resource>`, which embed the deployment key and package hash.
    /// Returns an empty string when the body yields neither tag — a CDN's HTML error
    /// page, say. The SDK does not compose a stand-in.
    static func storageErrorMessage(_ body: String?) -> String {
        guard let body = body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ""
        }

        let code = xmlTagText(body, "Code")
        let message = xmlTagText(body, "Message")

        switch (code, message) {
        case let (code?, message?): return "\(code): \(message)"
        case let (code?, nil): return code
        case let (nil, message?): return message
        default: return ""
        }
    }

    /// Reads at most `errorBodyMaxBytes` of a failed response body already in memory
    /// (the manifest-fetch path, which uses a plain data task).
    static func readErrorBody(data: Data?) -> String? {
        guard let data = data else { return nil }
        return String(data: data.prefix(errorBodyMaxBytes), encoding: .utf8)
    }

    /// Reads at most `errorBodyMaxBytes` of a failed response body already written to
    /// disk (the download path, which uses a download task — the error body from a
    /// non-2xx response is what ends up at the task's temp file location).
    static func readErrorBody(at location: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: location) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: errorBodyMaxBytes) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static let xmlEntities = [
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&apos;", "'"),
        // Ampersand last: decoding it first would let "&amp;lt;" become "<".
        ("&amp;", "&")
    ]

    private static func xmlTagText(_ body: String, _ tag: String) -> String? {
        // (?s) makes '.' match newlines too — an error body can wrap the message text
        // across lines, and the capture must still span all of it.
        guard let regex = try? NSRegularExpression(pattern: "(?s)<\(tag)>(.*?)</\(tag)>"),
              let match = regex.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)),
              let captureRange = Range(match.range(at: 1), in: body) else {
            return nil
        }

        var text = String(body[captureRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        for (entity, replacement) in xmlEntities {
            text = text.replacingOccurrences(of: entity, with: replacement)
        }
        return text.isEmpty ? nil : text
    }
}
