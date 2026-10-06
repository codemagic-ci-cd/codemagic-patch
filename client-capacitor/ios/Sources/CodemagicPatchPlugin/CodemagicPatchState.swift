// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchState.swift (Apache-2.0). No logic changes from upstream —
// same state.json schema, same launch-attempt budget mechanism (see
// specs/adr/0004-update-application-and-boot-selection.md). The RN/Capacitor divergence
// lives in how this state is *read* (this package's CodemagicPatch.swift resolves a
// boot selection for the plugin's load(), not a bundle URL for CodemagicPatchModule),
// not in the schema itself.
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
    var current: CodemagicPatchPackagePointer?
    var previous: CodemagicPatchPackagePointer?
    var pending: CodemagicPatchPackagePointer?
    var failedInstall: CodemagicPatchFailedInstall?
    var pendingStarted: String?
    // Optional so state written by an SDK older than the launch-attempt budget still
    // decodes: the synthesized decoder would throw on a missing key for a
    // non-optional, and a throw here resets every lifecycle pointer.
    var pendingStartCount: Int?

    enum CodingKeys: String, CodingKey {
        case current
        case previous
        case pending
        case failedInstall = "failed_install"
        case pendingStarted = "pending_started"
        case pendingStartCount = "pending_start_count"
    }

    init(
        current: CodemagicPatchPackagePointer? = nil,
        previous: CodemagicPatchPackagePointer? = nil,
        pending: CodemagicPatchPackagePointer? = nil,
        failedInstall: CodemagicPatchFailedInstall? = nil,
        pendingStarted: String? = nil,
        pendingStartCount: Int? = nil
    ) {
        self.current = current
        self.previous = previous
        self.pending = pending
        self.failedInstall = failedInstall
        self.pendingStarted = pendingStarted
        self.pendingStartCount = pendingStartCount
    }

    /// Code-review finding: the synthesized `Decodable` initializer this replaces only
    /// tolerates a *missing* key per optional field (every field here already is one,
    /// specifically so an older SDK's state.json still decodes — see
    /// `pendingStartCount`'s own comment). A key that is *present* with the wrong type
    /// — genuine on-disk corruption, not just an older schema — still throws for the
    /// whole struct, and `readState()`'s `try?` around the entire decode then discards
    /// every pointer (current/previous/pending/failedInstall) at once over one bad
    /// field. Android's equivalent (`CodemagicPatchState.fromJson`) already degrades
    /// field-by-field via org.json's `opt*()` accessors; this now does the same by
    /// decoding each field independently and falling back to `nil` on its own error,
    /// so one corrupted field no longer costs every other pointer too.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        current = try? container.decodeIfPresent(CodemagicPatchPackagePointer.self, forKey: .current)
        previous = try? container.decodeIfPresent(CodemagicPatchPackagePointer.self, forKey: .previous)
        pending = try? container.decodeIfPresent(CodemagicPatchPackagePointer.self, forKey: .pending)
        failedInstall = try? container.decodeIfPresent(CodemagicPatchFailedInstall.self, forKey: .failedInstall)
        pendingStarted = try? container.decodeIfPresent(String.self, forKey: .pendingStarted)
        pendingStartCount = try? container.decodeIfPresent(Int.self, forKey: .pendingStartCount)
    }

    var packageHashes: [String] {
        [pending, current, previous].compactMap { $0?.packageHash }
    }

    /// Launches already charged against the pending package's attempt budget.
    var pendingLaunchAttempts: Int {
        max(pendingStartCount ?? 0, 0)
    }

    /// Charges one launch against `hash`'s attempt budget. A different pending hash
    /// restarts the budget, so a freshly installed package always gets the full
    /// allowance.
    mutating func chargePendingLaunch(_ hash: String) {
        pendingStartCount = pendingStarted == hash ? pendingLaunchAttempts + 1 : 1
        pendingStarted = hash
    }

    /// Clears the launch-attempt tracking pair. The marker and its counter are only
    /// ever meaningful together, so they are always cleared together.
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
