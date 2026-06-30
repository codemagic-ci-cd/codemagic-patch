package io.codemagic.patch

import org.json.JSONObject

internal data class CodemagicPatchPackagePointer(val packageHash: String) {
  fun toJson(): JSONObject =
      JSONObject().put("package_hash", packageHash)
}

internal data class CodemagicPatchFailedInstall(
    val packageHash: String,
    val reason: String,
    val failedAt: String
) {
  fun toJson(): JSONObject =
      JSONObject()
        .put("package_hash", packageHash)
        .put("reason", reason)
        .put("failed_at", failedAt)
}

internal data class CodemagicPatchState(
    var current: CodemagicPatchPackagePointer? = null,
    var previous: CodemagicPatchPackagePointer? = null,
    var pending: CodemagicPatchPackagePointer? = null,
    var failedInstall: CodemagicPatchFailedInstall? = null,
    var pendingStarted: String? = null
) {
  val packageHashes: List<String>
    get() = listOfNotNull(
      pending?.packageHash,
      current?.packageHash,
      previous?.packageHash
    )

  fun toJson(): JSONObject {
    val json = JSONObject()
    current?.let { json.put("current", it.toJson()) }
    previous?.let { json.put("previous", it.toJson()) }
    pending?.let { json.put("pending", it.toJson()) }
    failedInstall?.let { json.put("failed_install", it.toJson()) }
    pendingStarted?.let { json.put("pending_started", it) }
    return json
  }

  companion object {
    fun fromJson(json: JSONObject, isSafePackageHash: (String) -> Boolean): CodemagicPatchState {
      fun pointer(name: String): CodemagicPatchPackagePointer? {
        val hash = json.optJSONObject(name)?.optString("package_hash") ?: return null
        return if (isSafePackageHash(hash)) CodemagicPatchPackagePointer(hash) else null
      }

      val failed = json.optJSONObject("failed_install")?.let {
        val hash = it.optString("package_hash")
        if (isSafePackageHash(hash)) {
          CodemagicPatchFailedInstall(
            packageHash = hash,
            reason = it.optString("reason"),
            failedAt = it.optString("failed_at")
          )
        } else {
          null
        }
      }
      val pendingStarted = json.optString("pending_started")
        .takeIf { isSafePackageHash(it) }

      return CodemagicPatchState(
        current = pointer("current"),
        previous = pointer("previous"),
        pending = pointer("pending"),
        failedInstall = failed,
        pendingStarted = pendingStarted
      )
    }
  }
}
