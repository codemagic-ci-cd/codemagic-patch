package io.codemagic.patch

import android.content.Context
import org.json.JSONObject
import java.io.File

object CodemagicPatch {
  private sealed class LaunchSelection {
    data class Pending(val hash: String) : LaunchSelection()
    data class Current(val hash: String) : LaunchSelection()
    object Embedded : LaunchSelection()
  }

  private var launchSelection: LaunchSelection? = null

  internal fun hasCompletedLaunchSelection(): Boolean = launchSelection != null

  internal fun currentLaunchPackageHash(): String? =
      when (val selection = launchSelection) {
        is LaunchSelection.Pending -> selection.hash
        is LaunchSelection.Current -> selection.hash
        LaunchSelection.Embedded -> null
        null -> null
      }

  /**
   * Host apps call this from `ReactNativeHost.getJSBundleFile()`.
   * Returns null when no boot-eligible OTA bundle exists so React Native
   * falls back to the embedded bundle.
   */
  @JvmStatic
  fun getJSBundleFile(context: Context): String? {
    val binaryVersion = binaryVersion(context) ?: return null
    return getJSBundleFile(context, binaryVersion)
  }

  @JvmStatic
  fun getJSBundleFile(context: Context, binaryVersion: String): String? {
    if (binaryVersion.isBlank()) return null
    return CodemagicPatchExecutors.io.submit<String?> {
      selectJSBundleFile(context, binaryVersion)
    }.get()
  }

  private fun selectJSBundleFile(context: Context, binaryVersion: String): String? {
    val storage = CodemagicPatchStorage(context)
    prepareBootState(context, storage, binaryVersion)
    val state = storage.readState()
    val failed = state.failedInstall?.packageHash
    val pending = state.pending?.packageHash
    if (pending != null && pending != failed && isBootEligible(storage, pending, binaryVersion)) {
      storage.mutateState { it.pendingStarted = pending }
      launchSelection = LaunchSelection.Pending(pending)
      return resolveBundlePath(storage, pending)?.absolutePath
    }
    val current = state.current?.packageHash
    if (current != null && isBootEligible(storage, current, binaryVersion)) {
      launchSelection = LaunchSelection.Current(current)
      return resolveBundlePath(storage, current)?.absolutePath
    }
    launchSelection = LaunchSelection.Embedded
    return null
  }

  private fun prepareBootState(context: Context, storage: CodemagicPatchStorage, binaryVersion: String) {
    if (hasCompletedLaunchSelection()) {
      return
    }

    val state = storage.readState()
    val hashes = state.packageHashes
    if (hashes.any { !storage.metadataMatchesBinary(it, binaryVersion) }) {
      storage.writeState(CodemagicPatchState())
      return
    }

    val started = state.pendingStarted ?: return
    val pending = state.pending?.packageHash ?: run {
      storage.mutateState { it.pendingStarted = null }
      return
    }
    if (started != pending) {
      storage.mutateState { it.pendingStarted = null }
      return
    }
    val failedAt = CodemagicPatchUtil.currentIsoTimestamp()
    storage.mutateState {
      it.failedInstall = CodemagicPatchFailedInstall(
        packageHash = pending,
        reason = "crash_rollback",
        failedAt = failedAt
      )
      it.pending = null
      it.pendingStarted = null
    }
    enqueueCrashRollbackMetric(context, storage, pending, binaryVersion, failedAt)
  }

  private fun isBootEligible(storage: CodemagicPatchStorage, hash: String, binaryVersion: String): Boolean {
    if (!storage.metadataMatchesBinary(hash, binaryVersion)) {
      return false
    }
    return resolveBundlePath(storage, hash) != null
  }

  private fun resolveBundlePath(storage: CodemagicPatchStorage, hash: String): File? {
    if (!storage.isSafePackageHash(hash)) return null
    val candidate = File(storage.packageContentsDir(hash), "index.android.bundle")
    return if (candidate.isFile) candidate else null
  }

  private fun enqueueCrashRollbackMetric(
    context: Context,
    storage: CodemagicPatchStorage,
    packageHash: String,
    binaryVersion: String,
    emittedAt: String
  ) {
    try {
      synchronized(CodemagicPatchExecutors.metricsLock) {
        val deviceId = storage.getDeviceId()
        val eventId = CodemagicPatchUtil.crashRollbackEventId(deviceId, packageHash, emittedAt)
        storage.writeJson("events/$eventId.json", JSONObject()
          .put("event_id", eventId)
          .put("event_name", "Failed")
          .put("emitted_at", emittedAt)
          .put("device_id", deviceId)
          .put("deployment_key", config(context, "CodemagicPatchDeploymentKey"))
          .put("binary_version", binaryVersion)
          .put("running_package_hash", JSONObject.NULL)
          .put("target_package_hash", packageHash)
          .put("platform", "android")
          .put("sdk_version", "0.0.0")
          .put("attributes", JSONObject()
            .put("reason", "install_fail")
            .put("failure_subtype", "crash_rollback")))
        storage.enforceEventQueueCap()
      }
    } catch (_: Exception) {}
  }

  private fun config(context: Context, key: String): String {
    val id = context.resources.getIdentifier(key, "string", context.packageName)
    return if (id == 0) "" else context.getString(id)
  }

  private fun binaryVersion(context: Context): String? {
    return try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      info.versionName?.trim()?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
      null
    }
  }
}
