package io.codemagic.patch

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.res.Resources
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.io.IOException

/**
 * A download failure that reached an HTTP response, carrying that response's
 * status. `HttpURLConnection` turns a non-2xx into a bare
 * `FileNotFoundException`/`IOException` with no status attached, so the status
 * has to be captured where it is still known.
 */
internal class CodemagicPatchHttpException(
  val status: Int,
  message: String
) : IOException(message)

/**
 * Download-failure reporting shared by the boot-state and download paths.
 *
 * The HTTP status travels to JS separately from the promise's reject code: the
 * reject code is the SDK's public `CodemagicPatchError` value space and must
 * stay stable for host apps, while this channel carries the detail that ends up
 * in `attributes.payload`. See PROTOCOL.md §Metric Event `Failed` Payload.
 */
internal object CodemagicPatchFailure {
  /**
   * Consecutive launches a pending package may boot without `notifyAppReady()`
   * before the SDK treats it as a crash, unless the host overrides it through
   * [MAX_LAUNCH_ATTEMPTS_KEY]. A single unconfirmed launch is not evidence of
   * a crash — the OS can reclaim a healthy process before JS runs — so
   * rollback waits for the whole budget to be spent.
   */
  const val DEFAULT_MAX_LAUNCH_ATTEMPTS = 3

  /**
   * String resource a host app sets to change the launch-attempt budget. Read
   * straight from resources rather than through the module's `config(...)`
   * because the boot-state decision runs from `MainApplication` before the
   * module exists, and both entry points must see the same value.
   */
  const val MAX_LAUNCH_ATTEMPTS_KEY = "CodemagicPatchMaxLaunchAttempts"

  private const val TAG = "CodemagicPatch"

  /**
   * The configured launch-attempt budget, or [DEFAULT_MAX_LAUNCH_ATTEMPTS] when
   * the resource is absent or invalid.
   *
   * Anything that is not a positive integer falls back to the default with a
   * log line rather than failing the boot: a typo in app config must not take
   * OTA down with it.
   */
  fun maxLaunchAttempts(context: Context): Int {
    val id = context.resources.getIdentifier(MAX_LAUNCH_ATTEMPTS_KEY, "string", context.packageName)
    if (id == 0) return DEFAULT_MAX_LAUNCH_ATTEMPTS
    // A resource declared only under a qualified directory (values-en) can
    // resolve an id yet have no value for the current configuration; that must
    // not throw out of the boot path.
    val raw = try {
      context.getString(id)
    } catch (e: Resources.NotFoundException) {
      Log.w(TAG, "$MAX_LAUNCH_ATTEMPTS_KEY is declared but unreadable; using $DEFAULT_MAX_LAUNCH_ATTEMPTS", e)
      return DEFAULT_MAX_LAUNCH_ATTEMPTS
    }
    // `toIntOrNull` bounds the value to Int32, matching the plugin's prebuild
    // check and the iOS reader so a large value behaves the same on both.
    val parsed = raw.trim().toIntOrNull()
    if (parsed != null && parsed >= 1) return parsed
    Log.w(
      TAG,
      "$MAX_LAUNCH_ATTEMPTS_KEY must be a positive integer, got '$raw'; using $DEFAULT_MAX_LAUNCH_ATTEMPTS"
    )
    return DEFAULT_MAX_LAUNCH_ATTEMPTS
  }

  /** Key under which the HTTP status travels in a rejected promise's userInfo. */
  const val DETAIL_CODE_KEY = "detail_code"

  /** Key under which the aggregation-facing failure text travels. */
  const val DETAIL_MESSAGE_KEY = "detail_message"

  /** PROTOCOL.md: the request produced no HTTP response. */
  const val NO_RESPONSE_CODE = "0"

  /**
   * How much of a failed response body to read. S3-style error XML runs a few
   * hundred bytes; a CDN that answers with its own HTML error page can run to
   * tens of kilobytes, and none of it past this point is worth holding in
   * memory to extract two tags from.
   */
  private const val ERROR_BODY_MAX_BYTES = 4096

  /**
   * The failed response's HTTP status, or [NO_RESPONSE_CODE] when the request
   * never got one. Follows the cause chain one level, since the executor may
   * wrap the original throwable.
   */
  fun httpStatusCode(error: Throwable): String {
    val http = error as? CodemagicPatchHttpException
      ?: error.cause as? CodemagicPatchHttpException
      ?: return NO_RESPONSE_CODE

    return http.status.toString()
  }

  /**
   * The origin's own words for a failed download, relayed rather than invented.
   *
   * OTA artifacts are served by object storage or a CDN, never by the API
   * server, and those answer a non-2xx with an error document naming what went
   * wrong — `NoSuchKey` for an artifact that was never uploaded,
   * `AccessDenied` for a bucket policy, `SignatureDoesNotMatch` for signing.
   * That distinction is the whole diagnostic value of a 403 or 404, and it is
   * something only the origin can say.
   *
   * Only `<Code>` and `<Message>` are taken, because the same document also
   * carries `<Key>` and `<Resource>`, which embed the deployment key and
   * package hash. Fields that merely vary per request (`<RequestId>`,
   * `<HostId>`) are excluded only because nothing reads them — `code` is the
   * aggregation key, so a message unique per occurrence would cost nothing.
   *
   * Returns an empty string when the body yields neither tag — a CDN's HTML
   * error page, say. The SDK does not compose a stand-in.
   */
  fun storageErrorMessage(body: String?): String {
    if (body.isNullOrBlank()) {
      return ""
    }

    val code = xmlTagText(body, "Code")
    val message = xmlTagText(body, "Message")

    return when {
      code != null && message != null -> "$code: $message"
      code != null -> code
      message != null -> message
      else -> ""
    }
  }

  /** Reads at most [ERROR_BODY_MAX_BYTES] of a failed response body. */
  fun readErrorBody(stream: java.io.InputStream?): String? {
    if (stream == null) {
      return null
    }

    return try {
      stream.use { input ->
        val buffer = ByteArray(ERROR_BODY_MAX_BYTES)
        var read = 0
        while (read < buffer.size) {
          val count = input.read(buffer, read, buffer.size - read)
          if (count <= 0) break
          read += count
        }
        String(buffer, 0, read, Charsets.UTF_8)
      }
    } catch (_: Exception) {
      null
    }
  }

  private val XML_ENTITIES = listOf(
    "&lt;" to "<",
    "&gt;" to ">",
    "&quot;" to "\"",
    "&apos;" to "'",
    // Ampersand last: decoding it first would let "&amp;lt;" become "<".
    "&amp;" to "&"
  )

  private fun xmlTagText(body: String, tag: String): String? {
    val match = Regex("<$tag>(.*?)</$tag>", RegexOption.DOT_MATCHES_ALL).find(body)
      ?: return null

    var text = match.groupValues[1].trim()
    for ((entity, replacement) in XML_ENTITIES) {
      text = text.replace(entity, replacement)
    }

    return text.takeIf { it.isNotEmpty() }
  }

  /**
   * Why this app's previous process ended, or null when the platform cannot
   * say (Android 10 and older, or no record yet).
   *
   * `getHistoricalProcessExitReasons` is a fact lookup rather than an
   * inference, which is what makes it worth carrying on every failure: it is
   * the only way to tell a launch that crashed apart from one the OS reclaimed
   * under memory pressure. Only the most recent record is read — older ones
   * describe launches the current failure cannot be about.
   *
   * Best-effort throughout: the reason is diagnostic context, so any failure
   * to obtain it degrades to null rather than disturbing the caller.
   */
  fun previousProcessExitReason(context: Context): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return null
    }

    return try {
      val activityManager =
        context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
      // A null package name means "this app"; maxNum 1 means "the latest".
      val record = activityManager.getHistoricalProcessExitReasons(null, 0, 1).firstOrNull()
      record?.let { exitReasonName(it.reason) }
    } catch (_: Exception) {
      null
    }
  }

  /**
   * Constant name for an `ApplicationExitInfo` reason. A value this SDK version
   * does not know — a constant added by a later platform release — is reported
   * as its decimal number rather than folded into an existing name, so a new
   * reason shows up as itself instead of silently joining another bucket.
   */
  private fun exitReasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_UNKNOWN -> "REASON_UNKNOWN"
    ApplicationExitInfo.REASON_EXIT_SELF -> "REASON_EXIT_SELF"
    ApplicationExitInfo.REASON_SIGNALED -> "REASON_SIGNALED"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "REASON_LOW_MEMORY"
    ApplicationExitInfo.REASON_CRASH -> "REASON_CRASH"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "REASON_CRASH_NATIVE"
    ApplicationExitInfo.REASON_ANR -> "REASON_ANR"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "REASON_INITIALIZATION_FAILURE"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "REASON_PERMISSION_CHANGE"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "REASON_EXCESSIVE_RESOURCE_USAGE"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "REASON_USER_REQUESTED"
    ApplicationExitInfo.REASON_USER_STOPPED -> "REASON_USER_STOPPED"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "REASON_DEPENDENCY_DIED"
    ApplicationExitInfo.REASON_OTHER -> "REASON_OTHER"
    ApplicationExitInfo.REASON_FREEZER -> "REASON_FREEZER"
    ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "REASON_PACKAGE_STATE_CHANGE"
    ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "REASON_PACKAGE_UPDATED"
    else -> reason.toString()
  }
}

/**
 * Attributes for the native-owned crash-rollback `Failed` event.
 *
 * `install_fail` has no status or text of its own to relay, but it does have
 * the one field that matters most here: whether the OS killed the previous
 * process or the package genuinely crashed. Every payload field is optional
 * precisely so this event can report that alone. The payload is omitted
 * entirely when the platform cannot say.
 */
internal fun crashRollbackAttributes(context: Context): JSONObject {
  val attributes = JSONObject()
    .put("reason", "install_fail")
    .put("failure_subtype", "crash_rollback")

  val exitReason = CodemagicPatchFailure.previousProcessExitReason(context)
  if (exitReason != null) {
    attributes.put(
      "payload",
      JSONObject().put("android_previous_process_exit", exitReason).toString()
    )
  }

  return attributes
}
