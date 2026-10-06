// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchPackageInstaller.swift (Apache-2.0). One deliberate
// divergence from upstream, documented in specs/UPSTREAM-DIVERGENCE.md: upstream's
// InstallContext carries a deploymentKey resolved by the caller from native config
// resources. This package's InstallUpdateRequest (src/definitions.ts) has no such
// field, and capacitor.config.ts reading (ADR-0003) is not implemented yet — that is
// Phase 4's job, once downloadUpdate() actually needs a deployment key to know what to
// fetch. Until then, the deployment key travels with the download record itself
// (downloads/{hash}/download.json's own "deployment_key" field, written by whatever
// created that record) and this installer simply relays it into update.json, rather
// than requiring a config lookup it has no way to perform correctly yet. Uses this
// package's own vendored bridge (CodemagicPatchBundleOps/CodemagicPatchHashing,
// native/libs/UPSTREAM.md) in place of upstream's identically-named RN bridge classes.
import Foundation
// SPM builds CodemagicPatchHashing/CodemagicPatchBundleOps into their own module
// (CodemagicPatchObjCBridge — see Package.swift's 3-target split, specs/UPSTREAM-
// DIVERGENCE.md); this Swift file needs an explicit import to see them there. The
// podspec (CocoaPods) compiles everything into one pod target, so no such module
// exists — the same classes are simply visible without an import, same-module. This
// conditional import is what makes the one source file work under both.
#if canImport(CodemagicPatchObjCBridge)
import CodemagicPatchObjCBridge
#endif

final class CodemagicPatchPackageInstaller {
    struct InstallContext {
        let packageHash: String
        let binaryVersion: String
        let runningPackageHash: String?
    }

    private let storage: CodemagicPatchStorage

    init(storage: CodemagicPatchStorage) {
        self.storage = storage
    }

    /// Fields read from `downloads/{hash}/download.json`, validated once by
    /// `loadDownloadRecord` and threaded through the rest of `install()`.
    private struct DownloadRecord {
        let metadata: [String: Any]
        let deploymentKey: String
        let artifactType: String
        let expectedPayload: String
        let basePackageHash: String?
    }

    func install(_ context: InstallContext) throws {
        let record = try loadDownloadRecord(packageHash: context.packageHash)
        let tmpContents = try materializeContents(context: context, record: record)

        guard CodemagicPatchHashing.packageHash(atPath: tmpContents.path) == context.packageHash else {
            try? FileManager.default.removeItem(at: tmpContents.deletingLastPathComponent())
            throw makeError("package hash mismatch")
        }

        try finalizeInstall(context: context, record: record, tmpContents: tmpContents)
    }

    private func loadDownloadRecord(packageHash: String) throws -> DownloadRecord {
        guard CodemagicPatchStorage.isSafePackageHash(packageHash),
              let record = storage.readJson("downloads/\(packageHash)/download.json") else {
            throw makeError("download record missing")
        }
        guard record["package_hash"] as? String == packageHash else {
            throw makeError("download record package hash mismatch")
        }
        guard let deploymentKey = record["deployment_key"] as? String, !deploymentKey.isEmpty else {
            throw makeError("download record deployment key is missing")
        }
        guard let artifactType = record["artifact_type"] as? String,
              artifactType == "patch" || artifactType == "full_bundle" else {
            throw makeError("download record artifact type is invalid")
        }
        let expectedPayload = artifactType == "patch" ? "payload.patch.zst" : "payload.tar.zst"
        guard record["payload"] as? String == expectedPayload else {
            throw makeError("download payload path is invalid")
        }
        return DownloadRecord(
            metadata: record["metadata"] as? [String: Any] ?? [:],
            deploymentKey: deploymentKey,
            artifactType: artifactType,
            expectedPayload: expectedPayload,
            basePackageHash: record["base_package_hash"] as? String
        )
    }

    /// Extracts (or patches) the download payload into a fresh `tmp/{hash}/contents`
    /// directory and validates its tree — everything up to, but not including, the
    /// package-hash check and the on-disk promotion `install()` does afterward.
    private func materializeContents(context: InstallContext, record: DownloadRecord) throws -> URL {
        let tmpRoot = storage.url("tmp/\(context.packageHash)")
        let tmpContents = tmpRoot.appendingPathComponent("contents", isDirectory: true)
        try? FileManager.default.removeItem(at: tmpRoot)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)

        let payload = storage.url("downloads/\(context.packageHash)/\(record.expectedPayload)")
        guard FileManager.default.fileExists(atPath: payload.path) else {
            throw makeError("download payload missing")
        }
        if record.artifactType == "patch" {
            guard let base = record.basePackageHash,
                  base == context.runningPackageHash,
                  storage.metadataMatchesBinary(packageHash: base, binaryVersion: context.binaryVersion),
                  FileManager.default.fileExists(atPath: storage.packageContentsDir(base).path) else {
                throw makeError("patch base package missing")
            }
            try runArtifactOperation("patch application failed") {
                CodemagicPatchBundleOps.applyDirectoryPatch(
                    withBaseDir: storage.packageContentsDir(base).path,
                    patchPath: payload.path,
                    outDir: tmpContents.path
                )
            }
        } else {
            try runArtifactOperation("bundle extraction failed") {
                CodemagicPatchBundleOps.extractBundle(payload.path, toOutDir: tmpContents.path)
            }
        }

        // Code-review finding: Android already cleans up tmp/{hash} on this exact
        // failure (its own validateContentsTree check); this didn't, only the later
        // hash-mismatch check in install() did. Bounded either way — the next install
        // attempt of the same hash clears tmp/{hash} again before it starts (see the
        // removeItem above) — but no reason to leave the asymmetry.
        do {
            try runArtifactOperation("unsafe package contents") {
                CodemagicPatchBundleOps.validateContentsTree(tmpContents.path)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmpRoot)
            throw error
        }
        return tmpContents
    }

    /// Promotes the validated `tmp/{hash}/contents` into `packages/{hash}/`, writes
    /// `update.json`, and updates `state.json`'s current/previous/pending pointers.
    private func finalizeInstall(context: InstallContext, record: DownloadRecord, tmpContents: URL) throws {
        let packageRoot = storage.url("packages/\(context.packageHash)")
        try promotePackageContents(hash: context.packageHash, tmpContents: tmpContents, packageRoot: packageRoot)
        try? FileManager.default.removeItem(at: tmpContents.deletingLastPathComponent())

        try storage.writeJson("packages/\(context.packageHash)/update.json", [
            "package_hash": context.packageHash,
            "binary_version": context.binaryVersion,
            "deployment_key": record.deploymentKey,
            "label": record.metadata["label"] as? String ?? context.packageHash,
            "is_mandatory": record.metadata["isMandatory"] as? Bool ?? false,
            "release_notes": record.metadata["releaseNotes"] ?? NSNull(),
            "installed_at": CodemagicPatchUtil.currentIsoTimestamp(),
            "source": record.artifactType,
            "signature_verified": record.metadata["signatureVerified"] as? Bool ?? false
        ])
        let current = storage.readState().current?.packageHash
        try storage.mutateState { state in
            if let current = current, current != context.packageHash {
                state.previous = CodemagicPatchPackagePointer(packageHash: current)
            }
            state.pending = CodemagicPatchPackagePointer(packageHash: context.packageHash)
            state.clearPendingLaunchTracking()
            // A fresh install supersedes any earlier crash-rollback record — the JS
            // layer already assumes this (installUpdate.ts sets `state.failedInstall =
            // null` on every successful install), but that in-memory belief is
            // meaningless unless native's own persisted state agrees, since
            // getBootState() re-hydrates JS from here on every launch. Without this,
            // re-installing the same package hash that once rolled back (e.g. after a
            // false-positive crash-loop trigger like a low-memory kill) would boot
            // eligibility-check it against its own stale failure record forever
            // (`pending != failed` in resolveBootSelection) — permanently stuck on the
            // previous package with no error surfaced anywhere.
            state.failedInstall = nil
        }
        // A new install can push the *previous* previous package out of
        // current/previous/pending entirely (e.g. a third install while a second is
        // still pending) — reclaim it rather than let packages/ grow unbounded.
        // context.runningPackageHash protects whatever the WebView is still serving
        // (relevant when this install's own mode defers activation) from being
        // reclaimed in the same sweep — see garbageCollectSupersededPackages.
        garbageCollectSupersededPackages(runningPackageHash: context.runningPackageHash)
    }

    func confirmPending() throws {
        try storage.mutateState { state in
            if let pending = state.pending?.packageHash {
                state.current = CodemagicPatchPackagePointer(packageHash: pending)
                state.pending = nil
                state.clearPendingLaunchTracking()
            }
        }
    }

    /// `runningPackageHash` is read by the caller *before* the pointers below are
    /// cleared, and passed through to garbage collection so the package the WebView is
    /// still serving under the default `ON_NEXT_RESTART` (every pointer that would
    /// otherwise reach it is being cleared right here) survives until `reloadBundle()`'s
    /// activation actually switches away from it. Without this, an immediately-following
    /// garbage-collection sweep would delete the live running package's own contents
    /// directory out from under the still-rendering WebView — see
    /// CodemagicPatchPlugin.swift's `reloadBundle()` and
    /// `garbageCollectSupersededPackages`.
    func stageEmbeddedRevert(runningPackageHash: String?) throws {
        try storage.mutateState { state in
            state.current = nil
            state.previous = nil
            state.pending = nil
            state.clearPendingLaunchTracking()
        }
        // Every installed package other than the one still running is orphaned by a
        // revert to embedded.
        garbageCollectSupersededPackages(runningPackageHash: runningPackageHash)
    }

    /// Deletes every `packages/{hash}/` directory not referenced by `current`,
    /// `previous` or `pending` — the three pointers that `state.json` (and therefore
    /// this SDK) can ever reach a package through — *and* not equal to
    /// `runningPackageHash`, the package the WebView is still actually serving right
    /// now, which can differ from all three pointers while an install's activation is
    /// deferred (`ON_NEXT_RESTART` and friends). Never touches any of those, so the
    /// previous package always survives for rollback, per this phase's own deliverable
    /// ("garbage-collect superseded packages, keeping the previous one for rollback" —
    /// specs/IMPLEMENTATION-PLAN.md Phase 3) — and the live one always survives until
    /// activation has actually moved off it (code-review finding: it previously did
    /// not, and got deleted out from under a still-running WebView on every
    /// `stageEmbeddedRevert()`).
    func garbageCollectSupersededPackages(runningPackageHash: String?) {
        var reachable = Set(storage.readState().packageHashes)
        if let runningPackageHash {
            reachable.insert(runningPackageHash)
        }
        let packagesDir = storage.url("packages")
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: packagesDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        for entry in entries {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: entry.path, isDirectory: &isDirectory),
                  isDirectory.boolValue,
                  !reachable.contains(entry.lastPathComponent) else {
                continue
            }
            try? FileManager.default.removeItem(at: entry)
        }
    }

    func clearForTests() {
        ["packages", "downloads", "tmp", "state"].forEach {
            storage.removeRelative($0)
        }
    }

    private func promotePackageContents(
        hash: String,
        tmpContents: URL,
        packageRoot: URL
    ) throws {
        let contents = packageRoot.appendingPathComponent("contents", isDirectory: true)
        try FileManager.default.createDirectory(at: packageRoot, withIntermediateDirectories: true)

        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: contents.path, isDirectory: &isDirectory) {
            let existingValid = isDirectory.boolValue &&
                CodemagicPatchBundleOps.validateContentsTree(contents.path) &&
                CodemagicPatchHashing.packageHash(atPath: contents.path) == hash
            guard existingValid else {
                throw makeError("existing package contents are invalid")
            }
            return
        }

        storage.fsyncTree(tmpContents)
        try FileManager.default.moveItem(at: tmpContents, to: contents)
        storage.fsyncDirectory(packageRoot)
    }

    private func runArtifactOperation(_ message: String, _ operation: () -> Bool) throws {
        if !operation() {
            throw makeError(message)
        }
    }

    private func makeError(_ message: String) -> NSError {
        NSError(domain: "CodemagicPatch", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
