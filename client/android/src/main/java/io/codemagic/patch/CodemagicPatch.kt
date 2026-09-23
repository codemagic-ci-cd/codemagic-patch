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
    prepareBootState(context, storage, binaryVersion) { packageHash, failedAt ->
      // The static path runs before React exists, so it has no activity to
      // read E2E launch arguments from and resolves every value from
      // resources and storage alone. CodemagicPatchModule supplies its own
      // resolution for the same reason.
      writeCrashRollbackEvent(
        storage = storage,
        binaryVersion = binaryVersion,
        deploymentKey = config(context, "CodemagicPatchDeploymentKey"),
        deviceId = storage.getDeviceId(),
        packageHash = packageHash,
        emittedAt = failedAt,
        attributes = crashRollbackAttributes(context)
      )
    }
    val state = storage.readState()
    val failed = state.failedInstall?.packageHash
    val pending = state.pending?.packageHash
    if (pending != null && pending != failed && isBootEligible(storage, pending, binaryVersion)) {
      // Charge once per *boot of this package*: the condition is true exactly
      // when the process is switching to this pending hash, and false only
      // while it is already running it.
      //
      // Neither of the simpler units works. Charging per call lets React
      // Native's repeated bundle requests drain the budget, condemning a
      // package after fewer launches than it promises. Charging per process
      // misses the in-process reload an IMMEDIATE install performs — the
      // selection is already `Embedded` by then — so a freshly installed
      // package would boot without spending anything and could stay
      // unconfirmed forever.
      if ((launchSelection as? LaunchSelection.Pending)?.hash != pending) {
        storage.mutateState { it.chargePendingLaunch(pending) }
      }
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

  /**
   * Decides, once per process, whether an unconfirmed pending package has run
   * out of launch attempts and must be rolled back.
   *
   * Both entry points into the SDK reach this: the static boot path above and
   * `CodemagicPatchModule`, whichever runs first. The decision lives here so
   * the two cannot drift — a rollback rule that fires on one path and not the
   * other would depend on how the host app is wired, which is exactly the kind
   * of difference nobody reproduces.
   *
   * The metric is not written here. Its envelope needs a deployment key and a
   * device id, and the two callers resolve those differently: the static path
   * has no activity and therefore no E2E launch arguments to consult. Handing
   * the write back through [onCrashRollback] keeps that difference visible at
   * the call site instead of forking this function.
   */
  internal fun prepareBootState(
    context: Context,
    storage: CodemagicPatchStorage,
    binaryVersion: String,
    onCrashRollback: (packageHash: String, failedAt: String) -> Unit
  ) {
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
      storage.mutateState { it.clearPendingLaunchTracking() }
      return
    }
    if (started != pending) {
      storage.mutateState { it.clearPendingLaunchTracking() }
      return
    }

    // The previous launch booted this package and never confirmed it. That
    // alone does not prove a crash — the OS can reclaim a healthy process
    // first — so spend an attempt and boot it again until the budget runs out.
    if (state.pendingStartCount < CodemagicPatchFailure.maxLaunchAttempts(context)) {
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
      it.clearPendingLaunchTracking()
    }
    onCrashRollback(pending, failedAt)
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

  /**
   * Writes one crash-rollback `Failed` event to the on-disk queue.
   *
   * Every value the envelope cannot derive is passed in, because the two
   * callers resolve them from different places — see [prepareBootState].
   * Failures are swallowed: losing the metric is preferable to failing the
   * boot that was already rolling a bad package back.
   */
  internal fun writeCrashRollbackEvent(
    storage: CodemagicPatchStorage,
    binaryVersion: String,
    deploymentKey: String,
    deviceId: String,
    packageHash: String,
    emittedAt: String,
    attributes: JSONObject
  ) {
    try {
      synchronized(CodemagicPatchExecutors.metricsLock) {
        val eventId = CodemagicPatchUtil.crashRollbackEventId(deviceId, packageHash, emittedAt)
        storage.writeJson("events/$eventId.json", JSONObject()
          .put("event_id", eventId)
          .put("event_name", "Failed")
          .put("emitted_at", emittedAt)
          .put("device_id", deviceId)
          .put("deployment_key", deploymentKey)
          .put("binary_version", binaryVersion)
          .put("running_package_hash", JSONObject.NULL)
          .put("target_package_hash", packageHash)
          .put("platform", "android")
          .put("sdk_version", "0.0.0")
          .put("attributes", attributes))
        storage.enforceEventQueueCap()
      }
    } catch (_: Exception) {}
  }

  private fun config(context: Context, key: String): String {
    val id = context.resources.getIdentifier(key, "string", context.packageName)
    return if (id == 0) "" else context.getString(id)
  }

  /**
   * The app's store binary version, straight from the package manager.
   *
   * Shared with `CodemagicPatchModule`, which layers its E2E launch-argument
   * override on top. The override cannot be read here: the static path is
   * called from `MainApplication` with the application context, which has no
   * activity and therefore no launch intent.
   */
  internal fun packageManagerBinaryVersion(context: Context): String? {
    return try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      info.versionName?.trim()?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
      null
    }
  }

  private fun binaryVersion(context: Context): String? =
      packageManagerBinaryVersion(context)
}
