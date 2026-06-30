package io.codemagic.patch

import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object CodemagicPatchUtil {
  fun verifyJwtSignature(jwt: String, expectedHash: String, publicKeyPem: String): Boolean {
    if (jwt.isBlank() || expectedHash.isBlank() || publicKeyPem.isBlank()) return false
    val parts = jwt.split(".")
    if (parts.size != 3) return false

    return try {
      val urlSafeFlags = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP
      val payload = String(Base64.decode(parts[1], urlSafeFlags), Charsets.UTF_8)
      if (JSONObject(payload).optString("contentHash") != expectedHash) return false
      val keyBytes = Base64.decode(
        publicKeyPem
          .replace("-----BEGIN PUBLIC KEY-----", "")
          .replace("-----END PUBLIC KEY-----", "")
          .replace("\\s".toRegex(), ""),
        Base64.DEFAULT
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

  fun currentIsoTimestamp(): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    formatter.timeZone = TimeZone.getTimeZone("UTC")
    return formatter.format(Date())
  }

  // Mirrors the JS event_id sanitization (client/src/events.ts): keep only filename-safe
  // characters so an event_id can double as the on-disk queue filename.
  fun sanitizeEventIdComponent(value: String): String =
    value.replace(Regex("[^A-Za-z0-9._-]"), "_")

  // Crash-rollback event_id must be unique per (device, package, occurrence) so the server's
  // global dedup on event_id does not collapse fleet-wide rollbacks into a single Failed row.
  // Every dynamic component is sanitized: the id doubles as the on-disk queue filename, so an
  // unsafe character (e.g. a "/" in a device id) would otherwise write under a nested path that
  // the top-level event scanner never flushes.
  fun crashRollbackEventId(deviceId: String, packageHash: String, failedAt: String): String =
    "crash-rollback-" +
      "${sanitizeEventIdComponent(deviceId)}-" +
      "${sanitizeEventIdComponent(packageHash)}-" +
      sanitizeEventIdComponent(failedAt)
}
