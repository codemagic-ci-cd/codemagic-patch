import Foundation

/// What `resolveBootSelection` currently resolves to — like upstream's
/// `LaunchSelection`, re-resolved fresh from `state.json` on every call rather than
/// decided once and reused, so a package installed after this process's first
/// resolution (and later activated in-process, e.g. by `IMMEDIATE` or a manual
/// `restartApp()`) is correctly picked up. The one thing that does *not* re-run per
/// call is the crash-loop launch-attempt budget charge — see
/// `resolveBootSelection`'s own doc comment for why it is keyed off "does this
/// resolution's pending hash differ from the previous one," not "has this ever
/// resolved before."
enum CodemagicPatchBootSelection: Equatable {
    case pending(String)
    case current(String)
    case embedded
}

/// Core boot/package logic, deliberately decoupled from Capacitor (`CAPPlugin`,
/// `CAPPluginCall`) so it stays testable without a bridge and so its shape mirrors the
/// upstream RN client's native module — see `specs/ARCHITECTURE.md` § 2 (reuse map) and
/// § 4 (native contract).
///
/// Boot-source resolution and the crash-loop rollback logic (`prepareBootState`, the
/// launch-attempt budget) are adapted from upstream
/// `codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a`
/// `client/ios/CodemagicPatch.swift` (Apache-2.0) — see
/// `specs/adr/0004-update-application-and-boot-selection.md`. What changed: upstream
/// resolves a **bundle URL** for `CodemagicPatchModule`'s RN bridge reload; this
/// resolves a **contents directory** for `Bridge.setServerBasePath()`, because
/// Capacitor serves a directory as the WebView's web root. Upstream also has two entry
/// points into this logic (a static pre-module path with no view controller, and the
/// native module) that must not drift from each other; this package has exactly one
/// *implementation* — `resolveBootSelection` — so there is no second copy of the logic
/// to keep in sync, even though it now has two call sites: the plugin's own `load()`
/// (cold boot) and `reloadBundle()` (mid-session activation, once installing an update
/// no longer applies it immediately — see this class's own `installUpdate`) — see the
/// ADR's "Spike resolution".
@objc public class CodemagicPatch: NSObject {
    private let storage: CodemagicPatchStorage
    private let installer: CodemagicPatchPackageInstaller
    private let maxLaunchAttempts: Int

    private var bootSelection: CodemagicPatchBootSelection?

    init(
        storage: CodemagicPatchStorage,
        maxLaunchAttempts: Int = CodemagicPatchFailure.defaultMaxLaunchAttempts
    ) {
        self.storage = storage
        self.installer = CodemagicPatchPackageInstaller(storage: storage)
        self.maxLaunchAttempts = maxLaunchAttempts
        super.init()
    }

    @objc override public convenience init() {
        self.init(storage: .inDocumentsDirectory())
    }

    /// Resolves what should be running *right now*, re-reading `state.json` fresh on
    /// every call — like upstream's `selectJSBundleFile()`, not a return-the-first-
    /// answer memo. Callers: `load()` (cold boot), `getBootState()` (JS's own query,
    /// which in practice only ever runs once per process — see `ensureHydrated()`'s own
    /// memoization), and `reloadBundle()`'s activation path, which is exactly why this
    /// can no longer stop at the first resolution: an install that landed after the
    /// first call (e.g. a deferred `ON_NEXT_RESTART` install, later activated
    /// in-process by `IMMEDIATE` or a manual `restartApp()`) must be seen.
    ///
    /// The launch-attempt budget still charges at most once per *boot of a given
    /// package* — comparing this call's resolved pending hash against the *previous*
    /// resolution's, not a boolean "have we ever resolved" — matching upstream's own
    /// comment on why neither "once per call" nor "once per process" is right: charging
    /// every call would let JS's repeated queries drain the budget; charging only the
    /// first-ever process resolution would let a package installed and activated
    /// in-process (already past `.embedded` by then) boot for free and never accumulate
    /// enough spent attempts to ever roll back. `onCrashRollback` is still only invoked
    /// from `prepareBootState`, which now guards itself against re-running past the
    /// first call — see its own doc comment.
    func resolveBootSelection(
        binaryVersion: String,
        onCrashRollback: (String, String) -> Void = { _, _ in }
    ) -> CodemagicPatchBootSelection {
        prepareBootState(binaryVersion: binaryVersion, onCrashRollback: onCrashRollback)

        let state = storage.readState()
        let failed = state.failedInstall?.packageHash
        let selection: CodemagicPatchBootSelection
        if let pending = state.pending?.packageHash,
           pending != failed,
           isBootEligible(pending, binaryVersion) {
            selection = .pending(pending)
        } else if let current = state.current?.packageHash, isBootEligible(current, binaryVersion) {
            selection = .current(current)
        } else {
            selection = .embedded
        }

        var previousPendingHash: String?
        if case .pending(let hash)? = bootSelection {
            previousPendingHash = hash
        }
        // Recorded before the charge write is even attempted, not after — see the
        // Android port's identical comment (CodemagicPatch.kt) for why: a swallowed
        // write failure below must not leave the stale previous selection in place,
        // or a later call would double-charge for what is still the same boot of the
        // same package.
        bootSelection = selection

        if case .pending(let hash) = selection, hash != previousPendingHash {
            // Charge once per *boot of this package*, not once per call — see this
            // method's own doc comment for why per-call and per-process are both wrong.
            try? storage.mutateState { $0.chargePendingLaunch(hash) }
        }

        return selection
    }

    /// Decides, once per process, whether an unconfirmed pending package has run out of
    /// launch attempts and must be rolled back. See
    /// specs/adr/0004-update-application-and-boot-selection.md. `onCrashRollback` is
    /// invoked, with the rolled-back package's hash and the failure timestamp, exactly
    /// when a rollback is actually applied here — never on a mere unconfirmed-launch
    /// budget charge (client/specs/sdk-native/Spec.md § Crash Rollback Detection:
    /// "Exactly one event is enqueued per rollback: the unconfirmed launches that merely
    /// spent budget emit nothing").
    ///
    /// Explicitly guarded against running more than once per process — matching
    /// upstream's own `hasCompletedLaunchSelection()` check — now that
    /// `resolveBootSelection` itself re-resolves on every call instead of memoizing:
    /// without this, a later same-process re-resolution (the whole reason it no longer
    /// memoizes) would re-run this rollback decision against whatever `state.json`
    /// looks like *then*, which is not the boot-time snapshot this decision is about.
    private func prepareBootState(binaryVersion: String, onCrashRollback: (String, String) -> Void) {
        if bootSelection != nil {
            return
        }

        let state = storage.readState()
        let hashes = state.packageHashes
        if hashes.contains(where: { !storage.metadataMatchesBinary(packageHash: $0, binaryVersion: binaryVersion) }) {
            // A new app-store binary invalidates every on-disk pointer: none of them
            // can be trusted to still match this build.
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

        // The previous launch booted this package and never confirmed it. That alone
        // does not prove a crash — the OS can reclaim a healthy process first — so
        // spend an attempt and boot it again until the budget runs out.
        // Compared against the count already spent, so a binary that lowers the budget
        // below it rolls back on this very launch.
        if state.pendingLaunchAttempts < maxLaunchAttempts {
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
            // Only emit once the rollback is actually durable — a write failure (disk
            // full, before-first-unlock file protection) must leave state.json
            // reporting the same unresolved budget-exhausted pending package, not a
            // rollback that never happened, and must not emit an event for it. The
            // next launch will retry this same mutateState call, not skip it — see
            // the class doc comment's "exactly one event is enqueued per rollback".
            onCrashRollback(pending, failedAt)
        } catch {
            // Fall through silently, matching this function's own degrade-to-embedded
            // contract (see load()'s doc comment) — the budget stays exhausted and
            // this same rollback attempt is retried on the next launch instead.
        }
    }

    private func isBootEligible(_ hash: String, _ binaryVersion: String) -> Bool {
        guard storage.metadataMatchesBinary(packageHash: hash, binaryVersion: binaryVersion) else {
            return false
        }
        return resolveContentsDir(hash) != nil
    }

    /// Nil unless `hash` is a safe hash with a real, non-empty contents directory on
    /// disk.
    func resolveContentsDir(_ hash: String) -> URL? {
        guard CodemagicPatchStorage.isSafePackageHash(hash) else {
            return nil
        }
        let dir = storage.packageContentsDir(hash)
        var isDirectory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDirectory)
        return exists && isDirectory.boolValue ? dir : nil
    }

    /// The package hash currently rendering the WebView (pending or current —
    /// whichever `resolveBootSelection` landed on), or nil on the embedded bundle. Two
    /// uses: the only valid base for a patch download (a patch is always relative to
    /// what's already materialized on the device, never to an arbitrary hash a
    /// manifest names), and the hash garbage collection must never delete out from
    /// under the still-live WebView — see `stageEmbeddedRevert()`/`installUpdate()`
    /// and `garbageCollectAfterActivation()`.
    func currentRunningPackageHash() -> String? {
        switch bootSelection {
        case .pending(let hash), .current(let hash):
            return hash
        default:
            return nil
        }
    }

    func getDeviceId() -> String {
        storage.getOrCreateDeviceId()
    }

    func binaryVersion() -> String? {
        guard let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else {
            return nil
        }
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// @phase 0/3. Returns embedded/current/pending state plus confirmed, pending,
    /// previous and running package hashes, and the last failed install if any.
    /// `onCrashRollback` mirrors `resolveBootSelection`'s — see that doc comment.
    public func getBootState(onCrashRollback: (String, String) -> Void = { _, _ in }) -> [String: Any] {
        // Resolve first, *then* read state: resolveBootSelection can itself mutate
        // storage (the crash-loop rollback and the binary-version-mismatch reset both
        // write through `prepareBootState`), so reading state first would report the
        // pre-mutation snapshot instead of what's actually on disk afterward.
        let selection = binaryVersion().map { resolveBootSelection(binaryVersion: $0, onCrashRollback: onCrashRollback) } ?? .embedded
        let state = storage.readState()

        let bootSource: String
        let runningPackageHash: Any
        switch selection {
        case .pending(let hash):
            bootSource = "pending"
            runningPackageHash = hash
        case .current(let hash):
            bootSource = "current"
            runningPackageHash = hash
        case .embedded:
            bootSource = "embedded"
            runningPackageHash = NSNull()
        }

        return [
            "bootSource": bootSource,
            "runningPackageHash": runningPackageHash,
            "confirmedPackageHash": state.current?.packageHash ?? NSNull(),
            "pendingPackageHash": state.pending?.packageHash ?? NSNull(),
            "previousPackageHash": state.previous?.packageHash ?? NSNull(),
            "failedInstall": state.failedInstall.map {
                [
                    "packageHash": $0.packageHash,
                    "reason": $0.reason,
                    "failedAt": $0.failedAt
                ] as [String: Any]
            } ?? NSNull(),
            // Android-only field (ApplicationExitInfo). Always null on iOS — see the
            // doc comment on BootState.androidPreviousProcessExit in src/definitions.ts.
            "androidPreviousProcessExit": NSNull()
        ]
    }

    /// Code-review finding (critical): this projection omitted `successReportedAt`/
    /// `lastActiveReportedAt` even though `CodemagicPatchMetricsQueue` writes
    /// `success_reported_at`/`last_active_reported_at` into this same `update.json` —
    /// `src/definitions.ts`'s `PackageMetadata` already declared both fields, but native
    /// never populated them, so every cold-start rehydration (`runtime.ts`'s
    /// `createRuntimePackageFromNativeMetadata`) saw both as `null` regardless of what
    /// was actually on disk. `emitActiveIfDue()`'s 24-hour dedupe window
    /// (`src/protocol/events.ts`) reads `lastActiveReportedAt` on every `notifyAppReady()`
    /// call, not just the first confirm, so this meant every restart of an
    /// already-confirmed, already-reported package re-emitted `Active` — inflating event
    /// counts and violating the metrics spec's once-per-window guarantee.
    func getPackageMetadata(_ packageHash: String) -> [String: Any]? {
        guard let metadata = storage.packageMetadata(packageHash) else {
            return nil
        }
        return [
            "packageHash": metadata["package_hash"] as? String ?? "",
            "binaryVersion": metadata["binary_version"] as? String ?? "",
            "deploymentKey": metadata["deployment_key"] as? String ?? "",
            "label": metadata["label"] as? String ?? "",
            "isMandatory": metadata["is_mandatory"] as? Bool ?? false,
            "releaseNotes": metadata["release_notes"] ?? NSNull(),
            "installedAt": metadata["installed_at"] as? String ?? "",
            "source": metadata["source"] as? String ?? "",
            "signatureVerified": metadata["signature_verified"] as? Bool ?? false,
            "successReportedAt": metadata["success_reported_at"] ?? NSNull(),
            "lastActiveReportedAt": metadata["last_active_reported_at"] ?? NSNull()
        ]
    }

    /// State-only, like upstream's `CodemagicPatchModule.installUpdate` — this never
    /// touches `bootSelection` or the WebView. `runningPackageHash` (the only valid
    /// base for a patch, and what garbage collection must not delete out from under the
    /// still-rendering WebView) is whatever is *currently* cached, deliberately read
    /// before this call does anything — activating the freshly installed package, for
    /// any install mode including `IMMEDIATE`, is `reloadBundle()`'s job alone, so that
    /// a plugin-layer bug can never again apply the switch before the JS activation
    /// state machine (restart suppression, install-mode gating) has had a say. See
    /// specs/adr/0004-update-application-and-boot-selection.md.
    func installUpdate(packageHash: String) throws {
        guard let binaryVersion = binaryVersion() else {
            throw NSError(
                domain: "CodemagicPatch",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "binary version unavailable"]
            )
        }
        try installer.install(CodemagicPatchPackageInstaller.InstallContext(
            packageHash: packageHash,
            binaryVersion: binaryVersion,
            runningPackageHash: currentRunningPackageHash()
        ))
    }

    func confirmPendingUpdate() throws {
        try installer.confirmPending()
        // The confirmed package is still whatever was already rendering — only its
        // state.json bookkeeping changed (pending -> current) — so the cache is
        // updated to match, not reset.
        if case .pending(let hash) = bootSelection {
            bootSelection = .current(hash)
        }
    }

    /// State-only: what's actually rendered does not change here (see
    /// specs/adr/0004-update-application-and-boot-selection.md), so — deliberately —
    /// this does not touch the cached `bootSelection`. `currentRunningPackageHash()`
    /// (read *before* the installer clears every pointer) is passed through so garbage
    /// collection protects the package the WebView is still serving under the default
    /// `ON_NEXT_RESTART` until `reloadBundle()`'s activation actually switches away
    /// from it — see `garbageCollectAfterActivation()` and
    /// `CodemagicPatchPackageInstaller.garbageCollectSupersededPackages`.
    func stageEmbeddedRevert() throws {
        try installer.stageEmbeddedRevert(runningPackageHash: currentRunningPackageHash())
    }

    /// Reclaims whatever package was running before the activation this call follows.
    /// Call only *after* `bootSelection` has already been updated to the newly active
    /// selection (i.e. after a fresh `resolveBootSelection` call) — otherwise this would
    /// protect the package the activation just switched away from instead of releasing
    /// it, which is the one thing `stageEmbeddedRevert()`/`installUpdate()`'s own
    /// in-installer garbage collection already exists to avoid doing prematurely.
    func garbageCollectAfterActivation() {
        installer.garbageCollectSupersededPackages(runningPackageHash: currentRunningPackageHash())
    }

    func clearUpdatesForTests() {
        installer.clearForTests()
        bootSelection = nil
    }
}
