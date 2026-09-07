import Foundation

struct CodemagicPatchPackagePointer: Codable {
  var packageHash: String

  enum CodingKeys: String, CodingKey {
    case packageHash = "package_hash"
  }
}

struct CodemagicPatchFailedInstall: Codable {
  var packageHash: String
  var reason: String
  var failedAt: String

  enum CodingKeys: String, CodingKey {
    case packageHash = "package_hash"
    case reason
    case failedAt = "failed_at"
  }
}

struct CodemagicPatchState: Codable {
  var current: CodemagicPatchPackagePointer? = nil
  var previous: CodemagicPatchPackagePointer? = nil
  var pending: CodemagicPatchPackagePointer? = nil
  var failedInstall: CodemagicPatchFailedInstall? = nil
  var pendingStarted: String? = nil
  // Optional so state written by an SDK older than the launch-attempt budget
  // still decodes: the synthesized decoder would throw on a missing key for a
  // non-optional, and a throw here resets every lifecycle pointer.
  var pendingStartCount: Int? = nil

  enum CodingKeys: String, CodingKey {
    case current
    case previous
    case pending
    case failedInstall = "failed_install"
    case pendingStarted = "pending_started"
    case pendingStartCount = "pending_start_count"
  }

  var packageHashes: [String] {
    [pending, current, previous].compactMap { $0?.packageHash }
  }

  /// Launches already charged against the pending package's attempt budget.
  var pendingLaunchAttempts: Int {
    max(pendingStartCount ?? 0, 0)
  }

  /**
   Charges one launch against `hash`'s attempt budget. A different pending hash
   restarts the budget, so a freshly installed package always gets the full
   allowance.
   */
  mutating func chargePendingLaunch(_ hash: String) {
    pendingStartCount = pendingStarted == hash ? pendingLaunchAttempts + 1 : 1
    pendingStarted = hash
  }

  /**
   Clears the launch-attempt tracking pair. The marker and its counter are only
   ever meaningful together, so they are always cleared together.
   */
  mutating func clearPendingLaunchTracking() {
    pendingStarted = nil
    pendingStartCount = nil
  }

  func sanitized() -> CodemagicPatchState {
    let safePendingStarted = pendingStarted?.takeIfSafePackageHash()
    return CodemagicPatchState(
      current: current.sanitized(),
      previous: previous.sanitized(),
      pending: pending.sanitized(),
      failedInstall: failedInstall.sanitized(),
      pendingStarted: safePendingStarted,
      pendingStartCount: safePendingStarted == nil ? nil : pendingStartCount
    )
  }
}

private extension Optional where Wrapped == CodemagicPatchPackagePointer {
  func sanitized() -> CodemagicPatchPackagePointer? {
    guard let pointer = self,
          CodemagicPatchStorage.isSafePackageHash(pointer.packageHash) else {
      return nil
    }
    return pointer
  }
}

private extension Optional where Wrapped == CodemagicPatchFailedInstall {
  func sanitized() -> CodemagicPatchFailedInstall? {
    guard let failed = self,
          CodemagicPatchStorage.isSafePackageHash(failed.packageHash) else {
      return nil
    }
    return failed
  }
}

private extension String {
  func takeIfSafePackageHash() -> String? {
    CodemagicPatchStorage.isSafePackageHash(self) ? self : nil
  }
}
