import Capacitor
import Foundation

/// Extracted out of `CodemagicPatchPlugin` itself purely to stay under SwiftLint's
/// `type_body_length` limit (the same reason `CodemagicPatchPlugin+NetworkError.swift`
/// was split out in Phase 4/5) — this is still plugin-bridging glue, not domain logic,
/// so it stays an extension of the plugin class rather than moving to its own type.
extension CodemagicPatchPlugin {
    @objc func verifyJwtSignature(_ call: CAPPluginCall) {
        guard let jwt = call.getString("jwt"), !jwt.isEmpty else {
            call.reject("jwt is required", "INVALID_ARGUMENT")
            return
        }
        guard let contentHash = call.getString("contentHash"), !contentHash.isEmpty else {
            call.reject("contentHash is required", "INVALID_ARGUMENT")
            return
        }
        let publicKeyPem = resolvedPublicKeyPem()
        let valid = CodemagicPatchUtil.verifyJwtSignature(jwt: jwt, expectedHash: contentHash, publicKeyPem: publicKeyPem)
        call.resolve(["valid": valid])
    }
}
