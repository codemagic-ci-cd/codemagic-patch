import Foundation

/**
 Download-failure reporting shared by the boot-state and download paths.

 The HTTP status travels to JS separately from the promise's reject code: the
 reject code is the SDK's public `CodemagicPatchError` value space and must stay
 stable for host apps, while this channel carries the detail that ends up in
 `attributes.payload`. See PROTOCOL.md §Metric Event `Failed` Payload.
 */
enum CodemagicPatchFailure {
  /**
   Consecutive launches a pending package may boot without `notifyAppReady()`
   before the SDK treats it as a crash. A single unconfirmed launch is not
   evidence of a crash — the OS can reclaim a healthy process before JS runs —
   so rollback waits for the whole budget to be spent.
   */
  static let pendingLaunchAttemptBudget = 3

  /// Key under which the HTTP status travels in a rejected promise's userInfo.
  static let detailCodeKey = "detail_code"

  /// Key under which the aggregation-facing failure text travels.
  static let detailMessageKey = "detail_message"

  /// PROTOCOL.md: the request produced no HTTP response.
  static let noResponseCode = "0"

  /**
   How much of a failed response body to read. S3-style error XML runs a few
   hundred bytes; a CDN that answers with its own HTML error page can run to
   tens of kilobytes, and none of it past this point is worth holding in memory
   to extract two tags from.
   */
  private static let errorBodyMaxBytes = 4096

  /**
   The origin's own words for a failed download, relayed rather than invented.

   OTA artifacts are served by object storage or a CDN, never by the API
   server, and those answer a non-2xx with an error document naming what went
   wrong — `NoSuchKey` for an artifact that was never uploaded, `AccessDenied`
   for a bucket policy, `SignatureDoesNotMatch` for signing. That distinction is
   the whole diagnostic value of a 403 or 404, and it is something only the
   origin can say.

   Only `<Code>` and `<Message>` are taken, because the same document also
   carries `<Key>` and `<Resource>`, which embed the deployment key and package
   hash. Fields that merely vary per request (`<RequestId>`, `<HostId>`) are
   excluded only because nothing reads them — `code` is the aggregation key, so
   a message unique per occurrence would cost nothing.

   Returns an empty string when the body yields neither tag — a CDN's HTML
   error page, say. The SDK does not compose a stand-in.
   */
  static func storageErrorMessage(_ body: String?) -> String {
    guard let body = body, !body.isEmpty else {
      return ""
    }

    let code = xmlTagText(body, tag: "Code")
    let message = xmlTagText(body, tag: "Message")

    switch (code, message) {
    case let (code?, message?):
      return "\(code): \(message)"
    case let (code?, nil):
      return code
    case let (nil, message?):
      return message
    default:
      return ""
    }
  }

  /// Reads at most `errorBodyMaxBytes` of a failed response body from disk.
  static func readErrorBody(at url: URL) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: url) else {
      return nil
    }
    defer { try? handle.close() }

    guard let data = try? handle.read(upToCount: errorBodyMaxBytes) else {
      return nil
    }

    return String(data: data, encoding: .utf8)
  }

  private static let xmlEntities: [(String, String)] = [
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", "\""),
    ("&apos;", "'"),
    // Ampersand last: decoding it first would let "&amp;lt;" become "<".
    ("&amp;", "&")
  ]

  private static func xmlTagText(_ body: String, tag: String) -> String? {
    guard let range = body.range(
      of: "<\(tag)>(.*?)</\(tag)>",
      options: [.regularExpression, .caseInsensitive]
    ) else {
      return nil
    }

    var text = String(body[range])
    text = String(text.dropFirst(tag.count + 2).dropLast(tag.count + 3))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    for (entity, replacement) in xmlEntities {
      text = text.replacingOccurrences(of: entity, with: replacement)
    }

    return text.isEmpty ? nil : text
  }

  /// Domain marking an NSError whose `code` is a real HTTP status.
  private static let httpDomain = "CodemagicPatchHTTP"

  /// Builds an error carrying the failed response's HTTP status.
  static func httpError(status: Int, message: String) -> NSError {
    NSError(
      domain: httpDomain,
      code: status,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }

  /// Builds an error for a failure that never reached an HTTP response.
  static func transportError(message: String) -> NSError {
    NSError(
      domain: "CodemagicPatch",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }

  /**
   The failed response's HTTP status, or `noResponseCode` when the request never
   got one — a `URLSession` transport error, a timeout, a cancelled request.
   */
  static func httpStatusCode(_ error: Error) -> String {
    let nsError = error as NSError
    guard nsError.domain == httpDomain else {
      return noResponseCode
    }

    return String(nsError.code)
  }
}
