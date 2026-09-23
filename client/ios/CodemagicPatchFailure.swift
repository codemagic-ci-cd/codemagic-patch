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
   before the SDK treats it as a crash, unless the host overrides it through
   `maxLaunchAttemptsKey`. A single unconfirmed launch is not evidence of a
   crash — the OS can reclaim a healthy process before JS runs — so rollback
   waits for the whole budget to be spent.
   */
  static let defaultMaxLaunchAttempts = 3

  /**
   Info.plist key a host app sets to change the launch-attempt budget. Read
   directly from the bundle rather than through the module's `config(_:)`
   because the boot-state decision runs from the app delegate before the module
   exists, and both entry points must see the same value.
   */
  static let maxLaunchAttemptsKey = "CodemagicPatchMaxLaunchAttempts"

  /**
   The configured launch-attempt budget, or `defaultMaxLaunchAttempts` when the
   key is absent or invalid.

   Info.plist stores the value as a number or a string, so both are accepted.
   Anything that is not a positive integer falls back to the default with a log
   line rather than failing the boot: a typo in app config must not take OTA
   down with it.
   */
  static func maxLaunchAttempts(bundle: Bundle = .main) -> Int {
    guard let raw = bundle.object(forInfoDictionaryKey: maxLaunchAttemptsKey) else {
      return defaultMaxLaunchAttempts
    }
    if let parsed = parsePositiveInt(raw) {
      return parsed
    }
    NSLog(
      "[CodemagicPatch] %@ must be a positive integer, got '%@'; using %d",
      maxLaunchAttemptsKey,
      String(describing: raw),
      defaultMaxLaunchAttempts
    )
    return defaultMaxLaunchAttempts
  }

  private static func parsePositiveInt(_ raw: Any) -> Int? {
    let value: Int?
    switch raw {
    case let number as NSNumber:
      // A plist `<true/>` also bridges to NSNumber and must not read as 1, and
      // a Double such as 2.5 must not silently truncate to 2.
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        value = nil
      } else {
        value = number.doubleValue == number.doubleValue.rounded() ? number.intValue : nil
      }
    case let text as String:
      value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines))
    default:
      value = nil
    }
    // Int32 is the range Android can read, so it is the range both platforms
    // accept; a larger value would roll back on one platform and not the other.
    guard let value = value, value >= 1, value <= Int(Int32.max) else {
      return nil
    }
    return value
  }

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
