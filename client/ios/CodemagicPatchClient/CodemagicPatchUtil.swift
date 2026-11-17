import Foundation
import Security

enum CodemagicPatchUtil {
  static func verifyJwtSignature(jwt: String, expectedHash: String, publicKeyPem: String) -> Bool {
    guard !jwt.isEmpty, !expectedHash.isEmpty, !publicKeyPem.isEmpty else { return false }

    let parts = jwt.split(separator: ".").map(String.init)
    guard parts.count == 3,
          let payloadData = base64UrlDecode(parts[1]),
          let signatureData = base64UrlDecode(parts[2]),
          let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
          payload["contentHash"] as? String == expectedHash,
          let publicKey = publicKey(fromPem: publicKeyPem) else {
      return false
    }

    let signedData = Data("\(parts[0]).\(parts[1])".utf8)
    return SecKeyVerifySignature(
      publicKey,
      .rsaSignatureMessagePKCS1v15SHA256,
      signedData as CFData,
      signatureData as CFData,
      nil
    )
  }

  static func currentIsoTimestamp() -> String {
    isoFormatter.string(from: Date())
  }

  // Mirrors the JS event_id sanitization (client/src/events.ts): keep only filename-safe
  // characters so an event_id can double as the on-disk queue filename.
  static func sanitizeEventIdComponent(_ value: String) -> String {
    value.replacingOccurrences(
      of: "[^A-Za-z0-9._-]",
      with: "_",
      options: .regularExpression
    )
  }

  // Crash-rollback event_id must be unique per (device, package, occurrence) so the server's
  // global dedup on event_id does not collapse fleet-wide rollbacks into a single Failed row.
  // Every dynamic component is sanitized: the id doubles as the on-disk queue filename, so an
  // unsafe character (e.g. a "/" in a device id) would otherwise write under a nested path that
  // the top-level event scanner never flushes.
  static func crashRollbackEventId(deviceId: String, packageHash: String, failedAt: String) -> String {
    let device = sanitizeEventIdComponent(deviceId)
    let hash = sanitizeEventIdComponent(packageHash)
    let failed = sanitizeEventIdComponent(failedAt)
    return "crash-rollback-\(device)-\(hash)-\(failed)"
  }

  private static let isoFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    return formatter
  }()

  private static func base64UrlDecode(_ value: String) -> Data? {
    var normalized = value
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    let padding = normalized.count % 4
    if padding > 0 {
      normalized.append(String(repeating: "=", count: 4 - padding))
    }
    return Data(base64Encoded: normalized)
  }

  private static func publicKey(fromPem pem: String) -> SecKey? {
    let body = pem
      .replacingOccurrences(of: "-----BEGIN PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "-----END PUBLIC KEY-----", with: "")
      .replacingOccurrences(of: "\\s", with: "", options: .regularExpression)

    guard let data = Data(base64Encoded: body) else { return nil }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 2048
    ]
    return SecKeyCreateWithData(data as CFData, attributes as CFDictionary, nil)
  }
}
