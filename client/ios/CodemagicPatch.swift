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
    prepareBootState(binaryVersion: binaryVersion)

    let state = storage.readState()
    let failed = state.failedInstall?.packageHash
    if let pending = state.pending?.packageHash,
       pending != failed,
       let url = resolveBundle(hash: pending, binaryVersion: binaryVersion) {
      try? storage.mutateState { $0.pendingStarted = pending }
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

  private static func prepareBootState(binaryVersion: String) {
    if hasCompletedLaunchSelection {
      return
    }

    let storage = CodemagicPatchStorage.shared

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
      try? storage.mutateState { $0.pendingStarted = nil }
      return
    }
    if started != pending {
      try? storage.mutateState { $0.pendingStarted = nil }
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
        state.pendingStarted = nil
      }
    } catch {
      return
    }
    enqueueCrashRollbackMetric(
      packageHash: pending,
      binaryVersion: binaryVersion,
      emittedAt: failedAt
    )
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

  private static func currentBinaryVersion() -> String? {
    guard let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else {
      return nil
    }
    let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func enqueueCrashRollbackMetric(
    packageHash: String,
    binaryVersion: String,
    emittedAt: String
  ) {
    do {
      try withCodemagicPatchMetricsLock {
        let storage = CodemagicPatchStorage.shared
        let deviceId = storage.getOrCreateDeviceId()
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
          "deployment_key": Bundle.main.object(forInfoDictionaryKey: "CodemagicPatchDeploymentKey") as? String ?? "",
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
}
