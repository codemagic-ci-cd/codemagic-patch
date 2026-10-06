// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchUtil.swift (Apache-2.0).
import Foundation
import Security

enum CodemagicPatchUtil {
    /// RS256 (RSASSA-PKCS1-v1_5 with SHA-256) verification of a release signature JWT
    /// (client/specs/sdk-native/Spec.md § RSA/JWT Signature Verification): split
    /// `header.payload.signature`, verify the signature against the configured public
    /// key, then check the payload's `contentHash` claim against the package this
    /// signature is meant to cover. A validation-result API — returns `false` for
    /// anything unverifiable (malformed JWT, wrong signature, wrong key, `contentHash`
    /// mismatch, missing/invalid key material), never throws. The PEM public key never
    /// crosses the JS bridge — only this native call sees it.
    static func verifyJwtSignature(jwt: String, expectedHash: String, publicKeyPem: String) -> Bool {
        guard !jwt.isEmpty, !expectedHash.isEmpty, !publicKeyPem.isEmpty else { return false }

        let parts = jwtParts(from: jwt)
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
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    /// Mirrors the JS event_id sanitization (src/protocol/events.ts): keep only
    /// filename-safe characters so an event_id can double as the on-disk queue filename
    /// (client/specs/metrics/Spec.md § Event Envelope).
    static func sanitizeEventIdComponent(_ value: String) -> String {
        value.replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
    }

    /// Crash-rollback event_id must be unique per (device, package, occurrence) so the
    /// server's global dedup on event_id does not collapse fleet-wide rollbacks into a
    /// single Failed row. Every dynamic component is sanitized: the id doubles as the
    /// on-disk queue filename, so an unsafe character (e.g. a stray "/") would otherwise
    /// write under a nested path the top-level event scanner never flushes.
    static func crashRollbackEventId(deviceId: String, packageHash: String, failedAt: String) -> String {
        let device = sanitizeEventIdComponent(deviceId)
        let hash = sanitizeEventIdComponent(packageHash)
        let failed = sanitizeEventIdComponent(failedAt)
        return "crash-rollback-\(device)-\(hash)-\(failed)"
    }

    /// Split a JWT into its dot-separated segments. Extracted out of
    /// `verifyJwtSignature` (rather than inlined) so a test can pin its exact shape
    /// directly — `verifyJwtSignature`'s own boolean result can't distinguish "rejected
    /// because there weren't 3 parts" from "rejected because a 3rd, valid-shaped part
    /// failed to decode/verify," since a malformed JWT could never happen to carry a
    /// signature that verifies either way.
    ///
    /// `omittingEmptySubsequences: false` — Swift's default (`true`) silently disagrees
    /// with Kotlin's `String.split(".")` (which always keeps empty parts) on inputs like
    /// ".a.b.c" or "a..c": the two platforms would parse a different number of parts,
    /// contradicting PROTOCOL-CONFORMANCE.md's L4 row, which claims identical behavior.
    static func jwtParts(from jwt: String) -> [String] {
        jwt.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    }

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

    /// `CodemagicPatchPublicKey` is a standard SPKI PEM (`-----BEGIN PUBLIC KEY-----`),
    /// the format the CLI's own signer's counterpart public key export produces.
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
