package io.codemagic.patch

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

object CodemagicPatch {
  private const val TAG = "CodemagicPatch"

  private sealed class LaunchSelection {
    data class Pending(val hash: String) : LaunchSelection()
    data class Current(val hash: String) : LaunchSelection()
    object Embedded : LaunchSelection()
  }

  private var launchSelection: LaunchSelection? = null

  /**
   * The pending hash whose charge waits for this process's next activity,
   * confined to the io executor like [launchSelection]. One slot rather than
   * one per deferral, so a process that selects the same hash twice before an
   * activity appears still pays for a single launch.
   */
  private var deferredChargeHash: String? = null

  /**
   * How long an activity callback waits for a deferred charge to reach disk.
   * An idle io queue writes it in milliseconds; the bound keeps a queue busy
   * with background work, such as installing an update, far from the 5 s
   * input-dispatch ANR.
   */
  private const val DEFERRED_CHARGE_WAIT_MS = 1_000L

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
        chargeUserFacingLaunch(context, storage, pending)
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

  /**
   * Charges this boot of [hash] against its budget once the user can see it.
   *
   * A boot in a background process is not charged when it happens; the charge
   * waits for the process's next activity. If none comes, the OS reclaims an
   * idle process that never had a chance to confirm, which says nothing about
   * the package — see [CodemagicPatchLaunchVisibility].
   */
  private fun chargeUserFacingLaunch(context: Context, storage: CodemagicPatchStorage, hash: String) {
    if (CodemagicPatchLaunchVisibility.isUserFacing()) {
      deferredChargeHash = null
      storage.mutateState { it.chargePendingLaunch(hash) }
      return
    }

    // The callback may wait for an activity for the rest of the process, so it
    // holds the application context rather than whatever the host passed.
    val appContext = context.applicationContext ?: context
    val deferred = CodemagicPatchLaunchVisibility.runOnNextActivity(appContext) {
      chargeDeferredLaunch(CodemagicPatchStorage(appContext), hash)
    }
    if (deferred) {
      deferredChargeHash = hash
      Log.i(TAG, "Pending package $hash booted in the background; its launch counts once an activity appears")
    } else {
      storage.mutateState { it.chargePendingLaunch(hash) }
    }
  }

  /**
   * Writes a deferred charge from an activity callback on the main thread.
   *
   * The wait puts the charge on disk before the activity can render the
   * package and crash. If the io queue is too busy to finish within
   * [DEFERRED_CHARGE_WAIT_MS], the activity goes ahead and the charge still
   * lands in queue order; a crash in that window goes uncounted once.
   */
  private fun chargeDeferredLaunch(storage: CodemagicPatchStorage, hash: String) {
    val write = CodemagicPatchExecutors.io.submit {
      // A later selection in this process replaces or clears the slot, and a
      // confirmation empties the pending pointer; either makes this charge stale.
      if (deferredChargeHash != hash) return@submit
      deferredChargeHash = null
      if ((launchSelection as? LaunchSelection.Pending)?.hash != hash) return@submit
      storage.mutateState { state ->
        if (state.pending?.packageHash == hash) state.chargePendingLaunch(hash)
      }
    }
    try {
      write.get(DEFERRED_CHARGE_WAIT_MS, TimeUnit.MILLISECONDS)
    } catch (_: TimeoutException) {
      Log.w(TAG, "Launch charge for pending package $hash is still queued behind other SDK work")
    } catch (e: ExecutionException) {
      Log.w(TAG, "Launch charge for pending package $hash failed", e.cause)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
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
        .put("attributes", attributes))
      storage.enforceEventQueueCap()
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
