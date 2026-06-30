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

  enum CodingKeys: String, CodingKey {
    case current
    case previous
    case pending
    case failedInstall = "failed_install"
    case pendingStarted = "pending_started"
  }

  var packageHashes: [String] {
    [pending, current, previous].compactMap { $0?.packageHash }
  }

  func sanitized() -> CodemagicPatchState {
    CodemagicPatchState(
      current: current.sanitized(),
      previous: previous.sanitized(),
      pending: pending.sanitized(),
      failedInstall: failedInstall.sanitized(),
      pendingStarted: pendingStarted?.takeIfSafePackageHash()
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
