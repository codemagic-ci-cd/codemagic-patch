import Capacitor
import Foundation

/// Extracted out of `CodemagicPatchPlugin` itself purely to stay under SwiftLint's
/// `file_length`/`type_body_length` limits (the same reason
/// `CodemagicPatchPlugin+NetworkError.swift`/`+Signature.swift` exist) — this is still
/// plugin-bridging glue for one coherent concern (installing, activating and reverting
/// an OTA package), not a separate domain, so it stays an extension of the plugin class
/// rather than moving to its own type.
extension CodemagicPatchPlugin {
    /// State-only — see `CodemagicPatch.installUpdate`'s own doc comment for why this
    /// must never touch the WebView, for any install mode including `IMMEDIATE`.
    /// Activation happens exclusively in `reloadBundle`, below.
    @objc func installUpdate(_ call: CAPPluginCall) {
        guard let packageHash = call.getString("packageHash"), !packageHash.isEmpty else {
            call.reject("packageHash is required", "INVALID_ARGUMENT")
            return
        }
        do {
            try implementation.installUpdate(packageHash: packageHash)
        } catch {
            call.reject("installUpdate failed: \(error.localizedDescription)", "INTEGRITY_ERROR")
            return
        }
        call.resolve()
    }

    @objc func confirmPendingUpdate(_ call: CAPPluginCall) {
        do {
            try implementation.confirmPendingUpdate()
        } catch {
            call.reject("confirmPendingUpdate failed: \(error.localizedDescription)", "INTEGRITY_ERROR")
            return
        }
        call.resolve()
    }

    @objc func stageEmbeddedRevert(_ call: CAPPluginCall) {
        do {
            try implementation.stageEmbeddedRevert()
        } catch {
            call.reject("stageEmbeddedRevert failed: \(error.localizedDescription)", "INTEGRITY_ERROR")
            return
        }
        call.resolve()
    }

    @objc func clearUpdatesForTests(_ call: CAPPluginCall) {
        implementation.clearUpdatesForTests()
        call.resolve()
    }

    /// The real activation path — the only place the WebView is ever switched to a
    /// different package, or back to the embedded bundle. Called by JS for `IMMEDIATE`
    /// installs (right after `installUpdate()`), for a manual `restartApp()`, and on the
    /// app-state transitions `observeAppStateChanges()` reports, for `ON_NEXT_RESUME`/
    /// `ON_NEXT_SUSPEND`. Re-resolves the boot selection fresh against whatever
    /// `state.json` says *right now* — never trusts a value computed earlier — so it
    /// correctly picks up a package installed after this process's first resolution.
    ///
    /// `CapacitorBridge.reload()` (`self.getWebView()?.reload()`) is internal to the
    /// Capacitor module and not callable from here; `webView` itself is exposed
    /// publicly via `CAPBridgeProtocol`, so the same effect is reached directly through
    /// WebKit's own standard `reload()` — needed explicitly here because, unlike
    /// Android, iOS's `setServerBasePath` does not reload on its own (see
    /// `applyBootSelection`'s doc comment).
    @objc func reloadBundle(_ call: CAPPluginCall) {
        guard let binaryVersion = implementation.binaryVersion() else {
            reloadWebView()
            call.resolve()
            return
        }
        let selection = implementation.resolveBootSelection(binaryVersion: binaryVersion) { packageHash, failedAt in
            self.enqueueCrashRollbackEvent(binaryVersion: binaryVersion, packageHash: packageHash, failedAt: failedAt)
        }
        switch selection {
        case .pending(let hash), .current(let hash):
            applyBootSelection(hash)
        case .embedded:
            applyEmbeddedBootSelection()
        }
        reloadWebView()
        // Whatever was running before this activation (if anything) is no longer
        // protected by `currentRunningPackageHash()` now that `resolveBootSelection`
        // above has moved `bootSelection` on — safe to reclaim it.
        implementation.garbageCollectAfterActivation()
        call.resolve()
    }

    /// `WKWebView` is main-thread-only, and plugin methods run on Capacitor's bridge
    /// queue — so only the reload hops, the same split Capacitor's own
    /// `CAPBridgeViewController.setServerBasePath(path:)` makes (base path on the
    /// calling queue, the WebView load on main). Queued ahead of `call.resolve()`'s own
    /// main-queue delivery to JS, so the reload is still issued first.
    private func reloadWebView() {
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.reload()
        }
    }

    /// `setServerBasePath` fails silently on a missing path (Capacitor's own behaviour,
    /// not ours to fix) — `resolveContentsDir` re-stats the directory rather than
    /// trusting the selection is still valid, per the ADR's explicit instruction. Called
    /// from `load()` (cold boot) and `reloadBundle()` (mid-session activation) — never
    /// from `installUpdate()`, which must stay state-only for every install mode; see
    /// `CodemagicPatch.installUpdate`'s own doc comment. Unlike Android's
    /// `Bridge.setServerBasePath` (verified against the real source: it always posts its
    /// own `webView.loadUrl`), iOS's does not reload on its own — `reloadBundle()` does
    /// that explicitly afterward.
    func applyBootSelection(_ packageHash: String) {
        guard let contentsDir = implementation.resolveContentsDir(packageHash) else {
            return
        }
        bridge?.setServerBasePath(contentsDir.path)
    }

    /// `applyBootSelection`'s counterpart for switching back to the embedded bundle
    /// mid-session (a `stageEmbeddedRevert()` that has now been activated) — `load()`'s
    /// own embedded case needs no equivalent because Capacitor already defaults to this
    /// at cold start (see `load()`'s `.embedded -> break`). `embeddedAppLocation` is
    /// captured once at `load()`, before any OTA path could ever overwrite it — see that
    /// property's own doc comment for why there is no other way to recover it later.
    func applyEmbeddedBootSelection() {
        guard let embeddedAppLocation else {
            return
        }
        bridge?.setServerBasePath(embeddedAppLocation.path)
    }
}
