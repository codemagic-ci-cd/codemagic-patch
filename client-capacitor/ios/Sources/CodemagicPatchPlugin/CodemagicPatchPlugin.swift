import Foundation
import Capacitor

/// Capacitor bridge for `CodemagicPatch`. Thin by design: this class only translates
/// between `CAPPluginCall` and the framework-agnostic `CodemagicPatch` implementation
/// above. See the Capacitor iOS Plugin Development Guide:
/// https://capacitorjs.com/docs/plugins/ios
///
/// Every method not yet implemented (see each method's `@phase` tag, matching
/// `src/definitions.ts`) rejects with code `UNIMPLEMENTED` rather than silently
/// no-opping or returning fabricated data.
@objc(CodemagicPatchPlugin)
public class CodemagicPatchPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CodemagicPatchPlugin"
    public let jsName = "CodemagicPatch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getBootState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchManifest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceId", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPackageMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueueMetricEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmPendingUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stageEmbeddedRevert", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearUpdatesForTests", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reloadBundle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyJwtSignature", returnType: CAPPluginReturnPromise)
    ]

    /// Not `private`: `CodemagicPatchPlugin+PackageLifecycle.swift` (a separate file,
    /// purely to stay under SwiftLint's `type_body_length` limit — same reason as
    /// `CodemagicPatchPlugin+NetworkError.swift`/`+Signature.swift`) needs it too.
    /// Replaced once at the top of `load()`, before any use, with an instance carrying
    /// the configured launch-attempt budget.
    private(set) var implementation = CodemagicPatch()

    /// Resolved once at `load()` and cached — never re-resolved per call, so a
    /// transient config read hiccup can't turn a working session flaky. `Result`
    /// (rather than an optional) keeps the *reason* a config was invalid available for
    /// the `CONFIGURATION_INVALID` rejection message, per ADR-0003's "fail fast and
    /// loudly" decision — every config-dependent method rejects immediately and
    /// clearly rather than silently no-opping, but nothing here brings the whole host
    /// app down over an OTA misconfiguration.
    private var config: Result<CodemagicPatchConfig, Error> = .failure(
        CodemagicPatchConfigError(message: "CodemagicPatch not loaded yet")
    )

    /// The one `config` field `CodemagicPatchPlugin+Signature.swift` needs — a small,
    /// derived accessor rather than broadening `config` itself past `private`.
    func resolvedPublicKeyPem() -> String {
        (try? config.get())?.publicKey ?? ""
    }

    private var manifestClient: CodemagicPatchManifestClient?
    private var downloader: CodemagicPatchDownloader?

    /// Captured once, at the very top of `load()`, before anything here could ever call
    /// `setServerBasePath()` and overwrite it: `CapacitorBridge.setServerBasePath` sets
    /// `config = config.updatingAppLocation(url)` in place (verified against the real
    /// Capacitor source), so `bridge.config.appLocation` stops being the embedded
    /// bundle's own path the first time an OTA package is ever applied. This is what
    /// `reloadBundle()`'s mid-session revert-to-embedded case applies — there is no
    /// other way to recover this path once an OTA package has overwritten it, and no
    /// public Capacitor API recomputes it from scratch. Not `private` — see
    /// `implementation`'s own doc comment for why.
    var embeddedAppLocation: URL?

    /// Constructed unconditionally, independent of `config`'s validity: metrics are
    /// best-effort observability and "must not alter SDK control-plane behavior"
    /// (client/specs/metrics/Spec.md § Native Queue Bridge Contract) — a misconfigured
    /// deploymentKey/apiUrl must not also disable the WAL. `flushAsync` itself no-ops
    /// when `apiUrl` resolves blank. A separate `CodemagicPatchStorage` instance,
    /// matching `downloader`'s own — both already point at the same on-disk root.
    private let metricsDelivery = CodemagicPatchMetricsDelivery(queue: CodemagicPatchMetricsQueue(storage: .inDocumentsDirectory()))

    /// Resolves this process's boot source and, for a non-embedded one, applies it via
    /// `bridge.setServerBasePath()` before the bridge loads its first URL — see
    /// specs/adr/0004-update-application-and-boot-selection.md's "Spike resolution".
    /// `CAPPlugin.load()` runs synchronously from `CapacitorBridge`'s own `init()`
    /// (`registerPlugins()`), called from `CAPBridgeViewController.loadView()` — always
    /// before `viewDidLoad()`'s `loadWebView()` (UIKit-guaranteed). `bridge` is already
    /// set by the time this runs (`CAPBridgedPlugin.load(on:)` sets it before calling
    /// this method).
    ///
    /// Wrapped entirely in its own scope with no `try!`/force-unwrap: an uncaught error
    /// here would leave every subsequent cold boot unable to construct the view
    /// controller at all, which is strictly worse than falling back to the embedded
    /// bundle — see specs/IMPLEMENTATION-PLAN.md Phase 3's acceptance criteria (disk-full
    /// / corrupted state must never crash, only ever degrade to embedded).
    override public func load() {
        // See embeddedAppLocation's own doc comment — must run before anything below
        // could ever call setServerBasePath(), which is why it's the very first thing
        // this method does.
        embeddedAppLocation = bridge?.config.appLocation

        implementation = CodemagicPatch(
            storage: .inDocumentsDirectory(),
            maxLaunchAttempts: CodemagicPatchConfigResolver.resolveMaxLaunchAttempts(pluginConfig: getConfig())
        )

        // Config resolution is independent of boot selection below: a misconfigured
        // deploymentKey/apiUrl must not stop a previously-installed package from
        // booting — it only ever blocks the *network* methods (fetchManifest,
        // downloadUpdate) that actually need it.
        config = Result(catching: { try CodemagicPatchConfigResolver.resolve(pluginConfig: self.getConfig()) })
        if case .success(let resolved) = config {
            manifestClient = CodemagicPatchManifestClient(config: resolved)
            downloader = CodemagicPatchDownloader(storage: .inDocumentsDirectory())
        }
        if case .failure(let error) = config {
            CAPLog.print("⚡️ ❌ CodemagicPatch configuration is invalid:", error.localizedDescription)
        }

        metricsDelivery.observeForegroundEntry { try? self.config.get().apiUrl }
        observeAppStateChanges()

        guard let binaryVersion = implementation.binaryVersion() else {
            return
        }
        let selection = implementation.resolveBootSelection(binaryVersion: binaryVersion) { packageHash, failedAt in
            self.enqueueCrashRollbackEvent(binaryVersion: binaryVersion, packageHash: packageHash, failedAt: failedAt)
        }
        switch selection {
        case .pending(let hash), .current(let hash):
            applyBootSelection(hash)
        case .embedded:
            // Leave Capacitor's own bundled-asset default in place.
            break
        }
    }

    /// Builds (via `CodemagicPatchCrashRollbackEvent`) and enqueues the native-owned
    /// crash-rollback `Failed` event. `deploymentKey` reads whatever `config` resolved
    /// to at `load()` time, even if invalid (an empty string) — metrics are best-effort
    /// and must never depend on OTA configuration being correct, only the
    /// boot-selection/rollback logic itself does. Not `private`:
    /// `CodemagicPatchPlugin+PackageLifecycle.swift`'s `reloadBundle()` needs it too —
    /// see `implementation`'s own doc comment for why that split exists.
    func enqueueCrashRollbackEvent(binaryVersion: String, packageHash: String, failedAt: String) {
        let envelope = CodemagicPatchCrashRollbackEvent.envelope(
            binaryVersion: binaryVersion,
            deviceId: implementation.getDeviceId(),
            deploymentKey: (try? config.get())?.deploymentKey ?? "",
            packageHash: packageHash,
            failedAt: failedAt
        )
        if let envelope {
            metricsDelivery.enqueue(envelope)
        }
    }

    /// Shared rejection for methods whose implementation has not landed yet.
    /// `method` and `phase` are used verbatim in the message so a caller can find the
    /// exact plan item in `specs/IMPLEMENTATION-PLAN.md`.
    private func rejectUnimplemented(_ call: CAPPluginCall, method: String, phase: Int) {
        call.reject(
            "CodemagicPatch.\(method)() is not implemented yet (planned for Phase \(phase); " +
                "see specs/IMPLEMENTATION-PLAN.md).",
            "UNIMPLEMENTED"
        )
    }

    @objc func getBootState(_ call: CAPPluginCall) {
        // A crash rollback can, in principle, first resolve here rather than in
        // load() — resolveBootSelection() only memoizes *after* binaryVersion() is
        // known, and load() bails out before that if binaryVersion() is briefly
        // unavailable. Passing the same callback here, not just in load(), is what
        // keeps that edge case from silently dropping the one Failed event a genuine
        // rollback must emit.
        let bootState = implementation.getBootState { packageHash, failedAt in
            self.enqueueCrashRollbackEvent(
                binaryVersion: self.implementation.binaryVersion() ?? "",
                packageHash: packageHash,
                failedAt: failedAt
            )
        }
        call.resolve(bootState)
    }

    @objc func fetchManifest(_ call: CAPPluginCall) {
        guard case .success(let cfg) = config else {
            if case .failure(let error) = config {
                call.reject("CodemagicPatch configuration is invalid: \(error.localizedDescription)", "CONFIGURATION_INVALID")
            }
            return
        }

        let binaryVersion = implementation.binaryVersion()
        let runningHash = implementation.currentRunningPackageHash()

        let context: [String: Any] = [
            "deploymentKey": cfg.deploymentKey,
            "binaryVersion": binaryVersion ?? NSNull(),
            "runningPackageHash": runningHash ?? NSNull(),
            // Blank, not the hydrated device id: a missing binary version means no
            // fetch happens below, and applyNativeManifestContext() (src/protocol/
            // checkForUpdate.ts) deliberately never lets an empty native deviceId
            // clobber whatever ensureHydrated() already hydrated from a real
            // getDeviceId() call earlier in this same round.
            "deviceId": binaryVersion == nil ? "" : implementation.getDeviceId(),
            "publicKeyConfigured": cfg.publicKey != nil
        ]

        guard let binaryVersion = binaryVersion else {
            call.resolve([
                "status": "not-found",
                "source": "binary-version",
                "manifestJson": NSNull(),
                "metaJson": NSNull(),
                "context": context
            ])
            return
        }

        guard let manifestClient = manifestClient else {
            call.reject("CodemagicPatch configuration is invalid", "CONFIGURATION_INVALID")
            return
        }

        do {
            let result = try manifestClient.fetchManifest(binaryVersion: binaryVersion, runningPackageHash: runningHash)
            call.resolve([
                "status": result.status,
                "source": result.source,
                "manifestJson": result.manifestJson ?? NSNull(),
                "metaJson": result.metaJson ?? NSNull(),
                "context": context
            ])
        } catch {
            // Carried on the rejection too, not just a resolved call: JS has no other
            // way to learn deploymentKey/binaryVersion for the Failed(reason=network)
            // event it records for this exact failure (src/protocol/checkForUpdate.ts)
            // — state.deploymentKey has no source until a manifest fetch actually
            // succeeds once, so without this every failure before that first success
            // (which, for a sustained outage, may be every failure in the session)
            // would otherwise report an empty deployment_key.
            rejectNetworkError(
                call,
                method: "fetchManifest",
                error: error,
                context: ["deployment_key": cfg.deploymentKey, "binary_version": binaryVersion]
            )
        }
    }

    @objc func getDeviceId(_ call: CAPPluginCall) {
        call.resolve(["deviceId": implementation.getDeviceId()])
    }

    @objc func getPackageMetadata(_ call: CAPPluginCall) {
        guard let packageHash = call.getString("packageHash"), !packageHash.isEmpty else {
            call.reject("packageHash is required", "INVALID_ARGUMENT")
            return
        }
        call.resolve(["metadata": implementation.getPackageMetadata(packageHash) ?? NSNull()])
    }

    @objc func enqueueMetricEvent(_ call: CAPPluginCall) {
        // Never routed through a rejection: "a failed enqueue may drop that metric
        // event, but it must not surface as INTEGRITY_ERROR and must not alter SDK
        // control-plane behavior" (client/specs/metrics/Spec.md § Native Queue Bridge
        // Contract) — this always resolves, even when the envelope is
        // missing/malformed and CodemagicPatchMetricsQueue.enqueue() drops it.
        if let eventJson = call.getString("eventJson"), !eventJson.isEmpty {
            metricsDelivery.enqueue(eventJson)
        }
        call.resolve()
    }

    @objc func downloadUpdate(_ call: CAPPluginCall) {
        guard let packageHash = call.getString("packageHash"), !packageHash.isEmpty,
              let artifactType = call.getString("artifactType"), !artifactType.isEmpty,
              let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("packageHash, artifactType and url are required", "INVALID_ARGUMENT")
            return
        }
        guard case .success(let cfg) = config else {
            if case .failure(let error) = config {
                call.reject("CodemagicPatch configuration is invalid: \(error.localizedDescription)", "CONFIGURATION_INVALID")
            }
            return
        }
        guard let downloader = downloader else {
            call.reject("CodemagicPatch configuration is invalid", "CONFIGURATION_INVALID")
            return
        }

        let metadata = call.getObject("metadata") ?? [:]
        let expectedBytes = call.getInt("expectedBytes").map { Int64($0) }

        do {
            try downloader.download(
                CodemagicPatchDownloader.Request(
                    packageHash: packageHash,
                    artifactType: artifactType,
                    url: urlString,
                    expectedBytes: expectedBytes,
                    deploymentKey: cfg.deploymentKey,
                    label: metadata["label"] as? String ?? packageHash,
                    isMandatory: metadata["isMandatory"] as? Bool ?? false,
                    releaseNotes: metadata["releaseNotes"] as? String,
                    signatureVerified: metadata["signatureVerified"] as? Bool ?? false,
                    basePackageHash: artifactType == "patch" ? implementation.currentRunningPackageHash() : nil
                ),
                onProgress: { [weak self] receivedBytes in
                    self?.emitDownloadProgress(
                        packageHash: packageHash,
                        artifactType: artifactType,
                        expectedBytes: expectedBytes,
                        receivedBytes: receivedBytes
                    )
                }
            )
        } catch {
            rejectNetworkError(call, method: "downloadUpdate", error: error)
            return
        }
        call.resolve()
    }

    /// Matches `NativeDownloadProgressEvent` (src/protocol/downloadUpdate.ts) exactly.
    private func emitDownloadProgress(packageHash: String, artifactType: String, expectedBytes: Int64?, receivedBytes: Int64) {
        notifyListeners("CodemagicPatchDownloadProgress", data: [
            "packageHash": packageHash,
            "artifactType": artifactType,
            "receivedBytes": max(receivedBytes, 0),
            "totalBytes": max(expectedBytes ?? 0, 0)
        ])
    }

    // installUpdate, confirmPendingUpdate, stageEmbeddedRevert, clearUpdatesForTests
    // and reloadBundle live in CodemagicPatchPlugin+PackageLifecycle.swift — see
    // `implementation`'s own doc comment for why.
}
