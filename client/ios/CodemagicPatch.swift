import Foundation

@objc(CodemagicPatch)
public final class CodemagicPatch: NSObject {
  private enum LaunchSelection {
    case pending(String)
    case current(String)
    case embedded
  }

  private static var launchSelection: LaunchSelection?

  static var hasCompletedLaunchSelection: Bool {
    launchSelection != nil
  }

  static var currentLaunchPackageHash: String? {
    switch launchSelection {
    case .pending(let hash), .current(let hash):
      return hash
    case .embedded, .none:
      return nil
    }
  }

  @objc
  public static func bundleURL() -> URL? {
    guard let binaryVersion = currentBinaryVersion() else { return nil }
    return bundleURL(binaryVersion: binaryVersion)
  }

  @objc
  public static func bundleURL(binaryVersion: String) -> URL? {
    guard !binaryVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return nil
    }
    return codemagicPatchIoQueueSync {
      selectBundleURL(binaryVersion: binaryVersion)
    }
  }

  private static func selectBundleURL(binaryVersion: String) -> URL? {
    let storage = CodemagicPatchStorage.shared
    // The static path runs from the app delegate, before the module exists,
    // and resolves every envelope value from the bundle and storage alone.
    // CodemagicPatchModule supplies its own resolution for the same values.
    prepareBootState(storage: storage, binaryVersion: binaryVersion) { packageHash, failedAt in
      writeCrashRollbackEvent(
        storage: storage,
        binaryVersion: binaryVersion,
        deploymentKey: Bundle.main.object(forInfoDictionaryKey: "CodemagicPatchDeploymentKey") as? String ?? "",
        deviceId: storage.getOrCreateDeviceId(),
        packageHash: packageHash,
        emittedAt: failedAt
      )
    }

    let state = storage.readState()
    let failed = state.failedInstall?.packageHash
    if let pending = state.pending?.packageHash,
       pending != failed,
       let url = resolveBundle(hash: pending, binaryVersion: binaryVersion) {
      // Charge once per *boot of this package*: `alreadySelected` is true only
      // while the process is already running this pending hash, so the charge
      // happens exactly when it switches to it.
      //
      // Neither of the simpler units works. Charging per call lets React
      // Native's repeated bundle requests drain the budget, condemning a
      // package after fewer launches than it promises. Charging per process
      // misses the in-process reload an IMMEDIATE install performs — the
      // selection is already `.embedded` by then — so a freshly installed
      // package would boot without spending anything and could stay
      // unconfirmed forever.
      var alreadySelected = false
      if case .pending(let selected) = launchSelection, selected == pending {
        alreadySelected = true
      }
      if !alreadySelected {
        try? storage.mutateState { $0.chargePendingLaunch(pending) }
      }
      launchSelection = .pending(pending)
      return url
    }
    if let current = state.current?.packageHash,
       let url = resolveBundle(hash: current, binaryVersion: binaryVersion) {
      launchSelection = .current(current)
      return url
    }
    launchSelection = .embedded
    return nil
  }

  /**
   Decides, once per process, whether an unconfirmed pending package has run
   out of launch attempts and must be rolled back.

   Both entry points into the SDK reach this: the static boot path above and
   `CodemagicPatchModule`, whichever runs first. The decision lives here so the
   two cannot drift — a rollback rule that fires on one path and not the other
   would depend on how the host app is wired, which is exactly the kind of
   difference nobody reproduces.

   The metric is not written here. Its envelope needs a deployment key and a
   device id, and the two callers resolve those differently: only the module
   consults E2E launch arguments. Handing the write back through
   `onCrashRollback` keeps that difference visible at the call site instead of
   forking this function.
   */
  internal static func prepareBootState(
    storage: CodemagicPatchStorage,
    binaryVersion: String,
    onCrashRollback: (_ packageHash: String, _ failedAt: String) -> Void
  ) {
    if hasCompletedLaunchSelection {
      return
    }

    let state = storage.readState()
    let hashes = state.packageHashes

    if hashes.contains(where: { !storage.metadataMatchesBinary(packageHash: $0, binaryVersion: binaryVersion) }) {
      try? storage.writeState(CodemagicPatchState())
      return
    }

    guard let started = state.pendingStarted else {
      return
    }
    guard let pending = state.pending?.packageHash else {
      try? storage.mutateState { $0.clearPendingLaunchTracking() }
      return
    }
    if started != pending {
      try? storage.mutateState { $0.clearPendingLaunchTracking() }
      return
    }

    // The previous launch booted this package and never confirmed it. That
    // alone does not prove a crash — the OS can reclaim a healthy process
    // first — so spend an attempt and boot it again until the budget runs out.
    if state.pendingLaunchAttempts < CodemagicPatchFailure.pendingLaunchAttemptBudget {
      return
    }

    let failedAt = CodemagicPatchUtil.currentIsoTimestamp()
    do {
      try storage.mutateState { state in
        state.failedInstall = CodemagicPatchFailedInstall(
          packageHash: pending,
          reason: "crash_rollback",
          failedAt: failedAt
        )
        state.pending = nil
        state.clearPendingLaunchTracking()
      }
    } catch {
      return
    }
    onCrashRollback(pending, failedAt)
  }

  private static func resolveBundle(hash: String, binaryVersion: String) -> URL? {
    let storage = CodemagicPatchStorage.shared
    guard CodemagicPatchStorage.isSafePackageHash(hash),
          storage.metadataMatchesBinary(packageHash: hash, binaryVersion: binaryVersion) else {
      return nil
    }

    let candidate = storage.packageContentsDir(hash).appendingPathComponent("main.jsbundle")
    return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
  }

  private static func currentBinaryVersion() -> String? { bundleBinaryVersion() }

  /**
   Writes one crash-rollback `Failed` event to the on-disk queue.

   Every value the envelope cannot derive is passed in, because the two callers
   resolve them from different places — see `prepareBootState`. Failures are
   swallowed: losing the metric is preferable to failing the boot that was
   already rolling a bad package back.
   */
  internal static func writeCrashRollbackEvent(
    storage: CodemagicPatchStorage,
    binaryVersion: String,
    deploymentKey: String,
    deviceId: String,
    packageHash: String,
    emittedAt: String
  ) {
    do {
      try withCodemagicPatchMetricsLock {
        let eventId = CodemagicPatchUtil.crashRollbackEventId(
          deviceId: deviceId,
          packageHash: packageHash,
          failedAt: emittedAt
        )
        let event: [String: Any] = [
          "event_id": eventId,
          "event_name": "Failed",
          "emitted_at": emittedAt,
          "device_id": deviceId,
          "deployment_key": deploymentKey,
          "binary_version": binaryVersion,
          "running_package_hash": NSNull(),
          "target_package_hash": packageHash,
          "platform": "ios",
          "sdk_version": "0.0.0",
          "attributes": [
            "reason": "install_fail",
            "failure_subtype": "crash_rollback"
          ]
        ]
        try storage.writeJson("events/\(eventId).json", event)
        storage.enforceEventQueueCap()
      }
    } catch {
    }
  }

  /**
   The app's store binary version, straight from the main bundle.

   Shared with `CodemagicPatchModule`, which layers its E2E override on top.
   */
  internal static func bundleBinaryVersion() -> String? {
    guard let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else {
      return nil
    }
    let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
