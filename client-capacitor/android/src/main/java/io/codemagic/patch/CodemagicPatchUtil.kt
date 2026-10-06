// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/CodemagicPatchUtil.kt (Apache-2.0).
package io.codemagic.patch

import android.util.Base64
import com.getcapacitor.JSObject
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * `org.json.JSONObject.put(key, value)` (which `JSObject.put` delegates straight to)
 * treats a bare Kotlin/Java `null` as "remove this key" — documented Android platform
 * behaviour, not a bug in our code, but the opposite of what every `BootState`/
 * `PackageMetadata`/metric-envelope field typed `T | null` needs: those fields must
 * always be *present*, holding JSON `null`, never silently absent. Route every
 * map-to-JSObject conversion through this so that promise actually holds. Shared
 * (rather than private to `CodemagicPatchPlugin`) so `CodemagicPatchCrashRollbackEvent`
 * can build its envelope the same way without duplicating this.
 */
internal fun JSObject.putNullable(
    key: String,
    value: Any?,
): JSObject = put(key, value ?: JSObject.NULL)

internal fun jsObjectOf(map: Map<String, Any?>): JSObject {
    val result = JSObject()
    for ((key, value) in map) {
        result.putNullable(key, value)
    }
    return result
}

internal object CodemagicPatchUtil {
    /**
     * RS256 (RSASSA-PKCS1-v1_5 with SHA-256) verification of a release signature JWT
     * (client/specs/sdk-native/Spec.md § RSA/JWT Signature Verification): split
     * `header.payload.signature`, verify the signature against the configured public
     * key, then check the payload's `contentHash` claim against the package this
     * signature is meant to cover. A validation-result API — returns `false` for
     * anything unverifiable (malformed JWT, wrong signature, wrong key, `contentHash`
     * mismatch, missing/invalid key material), never throws. The PEM public key never
     * crosses the JS bridge — only this native call sees it.
     */
    fun verifyJwtSignature(
        jwt: String,
        expectedHash: String,
        publicKeyPem: String,
    ): Boolean {
        if (jwt.isBlank() || expectedHash.isBlank() || publicKeyPem.isBlank()) return false
        val parts = jwtParts(jwt)
        if (parts.size != 3) return false

        return try {
            val urlSafeFlags = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
            val payload = String(Base64.decode(parts[1], urlSafeFlags), Charsets.UTF_8)
            if (JSONObject(payload).optString("contentHash") != expectedHash) return false

            val keyBytes =
                Base64.decode(
                    publicKeyPem
                        .replace("-----BEGIN PUBLIC KEY-----", "")
                        .replace("-----END PUBLIC KEY-----", "")
                        .replace("\\s".toRegex(), ""),
                    Base64.DEFAULT,
                )
            val publicKey = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(keyBytes))
            val verifier = Signature.getInstance("SHA256withRSA")
            verifier.initVerify(publicKey)
            verifier.update("${parts[0]}.${parts[1]}".toByteArray(Charsets.UTF_8))
            verifier.verify(Base64.decode(parts[2], urlSafeFlags))
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Split a JWT into its dot-separated segments. Extracted out of
     * [verifyJwtSignature] (rather than inlined) so a test can pin its exact shape
     * directly — [verifyJwtSignature]'s own boolean result can't distinguish "rejected
     * because there weren't 3 parts" from "rejected because a 3rd, valid-shaped part
     * failed to decode/verify," since a malformed JWT could never happen to carry a
     * signature that verifies either way.
     *
     * Kotlin's `String.split(".")` always keeps empty parts (unlike Swift's
     * `split(separator:)`, which omits them by default) — on inputs like ".a.b.c" or
     * "a..c", the two platforms would parse a different number of parts, contradicting
     * PROTOCOL-CONFORMANCE.md's L4 row, which claims identical behavior. iOS's
     * `CodemagicPatchUtil.jwtParts` passes `omittingEmptySubsequences: false` to match.
     */
    internal fun jwtParts(jwt: String): List<String> = jwt.split(".")

    fun currentIsoTimestamp(): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date())
    }

    // Mirrors the JS event_id sanitization (src/protocol/events.ts): keep only
    // filename-safe characters so an event_id can double as the on-disk queue filename
    // (client/specs/metrics/Spec.md § Event Envelope).
    fun sanitizeEventIdComponent(value: String): String = value.replace(Regex("[^A-Za-z0-9._-]"), "_")

    // Crash-rollback event_id must be unique per (device, package, occurrence) so the
    // server's global dedup on event_id does not collapse fleet-wide rollbacks into a
    // single Failed row. Every dynamic component is sanitized: the id doubles as the
    // on-disk queue filename, so an unsafe character (e.g. a stray "/" ) would otherwise
    // write under a nested path the top-level event scanner never flushes.
    fun crashRollbackEventId(
        deviceId: String,
        packageHash: String,
        failedAt: String,
    ): String =
        "crash-rollback-" +
            "${sanitizeEventIdComponent(deviceId)}-" +
            "${sanitizeEventIdComponent(packageHash)}-" +
            sanitizeEventIdComponent(failedAt)
}
