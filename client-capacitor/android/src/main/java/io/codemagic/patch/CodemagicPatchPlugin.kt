package io.codemagic.patch

import android.content.Context
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.Logger
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor bridge for [CodemagicPatch]. Thin by design: this class only translates
 * between [PluginCall] and the framework-agnostic [CodemagicPatch] implementation
 * above. See the Capacitor Android Plugin Development Guide:
 * https://capacitorjs.com/docs/plugins/android
 *
 * Every method not yet implemented (see each method's `@phase` tag, matching
 * `src/definitions.ts`) rejects with code `UNIMPLEMENTED` rather than silently
 * no-opping or returning fabricated data.
 */
@CapacitorPlugin(name = "CodemagicPatch")
class CodemagicPatchPlugin : Plugin() {
    private lateinit var implementation: CodemagicPatch

    private companion object {
        const val CAP_WEBVIEW_SETTINGS_PREFS_NAME = "CapWebViewSettings"
        const val CAP_SERVER_PATH_PREF_KEY = "serverBasePath"
        const val APP_STATE_CHANGE_EVENT = "CodemagicPatchAppStateChange"
        const val APP_STATE_ACTIVE = "active"
        const val APP_STATE_BACKGROUND = "background"
    }

    /**
     * Resolved once at `load()` and cached — never re-resolved per call, so a
     * transient config read hiccup can't turn a working session flaky. `Result`
     * (rather than a nullable) keeps the *reason* a config was invalid available for
     * the `CONFIGURATION_INVALID` rejection message, per ADR-0003's "fail fast and
     * loudly" decision — every config-dependent method rejects immediately and
     * clearly rather than silently no-opping, but nothing here brings the whole host
     * app down over an OTA misconfiguration.
     */
    private var config: Result<CodemagicPatchConfig> = Result.failure(IllegalStateException("CodemagicPatch not loaded yet"))
    private var manifestClient: CodemagicPatchManifestClient? = null
    private var downloader: CodemagicPatchDownloader? = null

    /**
     * Constructed unconditionally in `load()`, independent of [config]'s validity:
     * metrics are best-effort observability and "must not alter SDK control-plane
     * behavior" (client/specs/metrics/Spec.md § Native Queue Bridge Contract) — a
     * misconfigured deploymentKey/apiUrl must not also disable the WAL. `flushAsync`
     * itself no-ops when `apiUrl` resolves blank.
     */
    private lateinit var metricsDelivery: CodemagicPatchMetricsDelivery

    /**
     * Resolves this process's boot source and, for a non-embedded one, applies it — see
     * specs/adr/0004-update-application-and-boot-selection.md's "Spike resolution".
     * `Plugin.load()` does run synchronously from `Bridge`'s own constructor
     * (`registerAllPlugins()`), strictly before `loadWebView()`, with `bridge`/`context`
     * already set (`PluginHandle.loadInstance` calls `setBridge` before `load()`) — but
     * calling `bridge.setServerBasePath()` directly, here, still doesn't work: Bridge's
     * `WebViewLocalServer` (`localServer`) isn't constructed until `loadWebView()`
     * itself (after `registerAllPlugins()` returns), so `setServerBasePath()` throws a
     * NullPointerException this early — caught below, silently, which is how this went
     * unnoticed until Phase 4's example app hit it on a real cold boot (see
     * `applyBootSelectionAtLoad`, which is what to call from here instead).
     */
    override fun load() {
        val storage = CodemagicPatchStorage(context)
        val maxLaunchAttempts =
            runCatching { CodemagicPatchConfigResolver.resolveMaxLaunchAttempts(context, getConfig()) }
                .getOrDefault(CodemagicPatchFailure.DEFAULT_MAX_LAUNCH_ATTEMPTS)
        implementation = CodemagicPatch(context, storage, maxLaunchAttempts)
        metricsDelivery = CodemagicPatchMetricsDelivery(CodemagicPatchMetricsQueue(storage))

        // Config resolution is independent of boot selection below: a misconfigured
        // deploymentKey/apiUrl must not stop a previously-installed package from
        // booting — it only ever blocks the *network* methods (fetchManifest,
        // downloadUpdate) that actually need it.
        config = runCatching { CodemagicPatchConfigResolver.resolve(context, getConfig()) }
        config.getOrNull()?.let { resolved ->
            manifestClient = CodemagicPatchManifestClient(resolved)
            downloader = CodemagicPatchDownloader(storage)
        }
        config.exceptionOrNull()?.let {
            Logger.error("CodemagicPatch", "Configuration is invalid: ${it.message}", it)
        }

        // An uncaught exception here would crash every subsequent cold boot (this runs
        // from Bridge's own constructor — see the class doc comment) rather than fall
        // back to the embedded bundle, which is strictly worse than the failure this
        // method exists to prevent. Disk-full or a permission error while charging a
        // launch attempt must degrade to "boot embedded", never to "the app no longer
        // starts" — see specs/IMPLEMENTATION-PLAN.md Phase 3's acceptance criteria.
        try {
            val binaryVersion = implementation.binaryVersion() ?: return
            when (
                val selection =
                    implementation.resolveBootSelection(binaryVersion) { packageHash, failedAt ->
                        enqueueCrashRollbackEvent(binaryVersion, packageHash, failedAt)
                    }
            ) {
                is CodemagicPatchBootSelection.Pending -> applyBootSelectionAtLoad(selection.packageHash)
                is CodemagicPatchBootSelection.Current -> applyBootSelectionAtLoad(selection.packageHash)
                is CodemagicPatchBootSelection.Embedded -> {
                    // Leave Capacitor's own bundled-asset default in place — but first
                    // clear any path a *previous* boot's applyBootSelectionAtLoad left
                    // in CapWebViewSettings/serverBasePath. Bridge.loadWebView() reads
                    // that key itself, moments after this method returns, regardless of
                    // what we do here — a stale entry from before an embedded revert
                    // (state.json no longer has a current/pending package, but the
                    // SharedPreferences key persists independently of it) would make
                    // Bridge silently re-apply the old path, undoing the revert.
                    clearPersistedServerBasePath()
                }
            }
        } catch (_: Exception) {
            // Fall through silently — the WebView already defaults to the embedded
            // bundle unless setServerBasePath was called, so doing nothing here *is*
            // the fallback.
        }
    }

    /**
     * "Flush only on native-observed foreground entry, including first foreground entry
     * after process launch and later background → foreground resume transitions"
     * (client/specs/metrics/Spec.md § Native Queue Bridge Contract). `handleOnResume()`
     * fires for both cases on Android — a fresh launch's first `onResume()` and every
     * later resume from the background — so no separate first-launch hook is needed.
     */
    override fun handleOnResume() {
        config.getOrNull()?.apiUrl?.let(metricsDelivery::flushAsync)
        notifyAppStateChange(APP_STATE_ACTIVE)
    }

    /**
     * The other half of the app-state signal JS's lifecycle activation and `start()`'s
     * `ON_APP_RESUME` re-check run on — see [notifyAppStateChange].
     */
    override fun handleOnPause() {
        notifyAppStateChange(APP_STATE_BACKGROUND)
    }

    /**
     * Emits React Native's own `AppState` value names so upstream's JS lifecycle state
     * machine ports unchanged (specs/adr/0013-native-app-state-events.md). Mirrors RN's
     * Android mapping: `onResume` → `active`, `onPause` → `background`; Android never
     * reports `inactive`. Not retained: a transition JS was not yet listening for is not
     * one it needs — JS starts from `active`, which a cold start's first `onResume()`
     * merely confirms.
     */
    private fun notifyAppStateChange(appState: String) {
        notifyListeners(APP_STATE_CHANGE_EVENT, JSObject().put("appState", appState))
    }

    /**
     * Builds and enqueues the native-owned crash-rollback `Failed` event
     * (client/specs/sdk-native/Spec.md § Crash Rollback Detection step 5) — JS may not
     * run before rollback is applied, so this can't wait for `src/protocol/events.ts`.
     * `deploymentKey` reads whatever `config` resolved to at `load()` time, even if
     * invalid (an empty string) — metrics are best-effort and must never depend on OTA
     * configuration being correct, only the boot-selection/rollback logic itself does.
     */
    private fun enqueueCrashRollbackEvent(
        binaryVersion: String,
        packageHash: String,
        failedAt: String,
    ) {
        val envelope =
            CodemagicPatchCrashRollbackEvent.envelope(
                binaryVersion = binaryVersion,
                deviceId = implementation.getDeviceId(),
                deploymentKey = config.getOrNull()?.deploymentKey ?: "",
                packageHash = packageHash,
                failedAt = failedAt,
                previousProcessExit = implementation.previousProcessExit(),
            )
        metricsDelivery.enqueue(envelope)
    }

    /**
     * `setServerBasePath` fails silently on a missing path (Capacitor's own behaviour,
     * not ours to fix) — `resolveContentsDir` re-stats the directory rather than
     * trusting the selection is still valid, per the ADR's explicit instruction. Only
     * safe once the bridge's WebView (and its `WebViewLocalServer`) actually exists —
     * i.e. from [reloadBundle], never from `load()`; see [applyBootSelectionAtLoad].
     * Self-reloads (`Bridge.setServerBasePath`'s own behavior on Android — verified
     * against the real Capacitor source, unlike iOS's equivalent) — [reloadBundle]
     * deliberately does not also call `bridge.reload()` after this.
     */
    private fun applyBootSelection(packageHash: String) {
        val contentsDir = implementation.resolveContentsDir(packageHash) ?: return
        bridge.setServerBasePath(contentsDir.absolutePath)
    }

    /**
     * [applyBootSelection]'s counterpart for switching back to the embedded bundle
     * mid-session (a `stageEmbeddedRevert()` that has now been activated) — `load()`'s
     * own embedded case needs no equivalent because Capacitor already defaults to this
     * at cold start (see `load()`'s `Embedded -> break`). Also clears the persisted
     * path key so a later cold restart doesn't resurrect a stale OTA path via the same
     * `Bridge.loadWebView()` restore mechanism [applyBootSelectionAtLoad] documents.
     * Self-reloads, same as [applyBootSelection] — verified against the real
     * `Bridge.setServerAssetPath` source, which ends in the identical
     * `webView.post { webView.loadUrl(appUrl) }`.
     */
    private fun applyEmbeddedBootSelection() {
        clearPersistedServerBasePath()
        bridge.setServerAssetPath(Bridge.DEFAULT_WEB_ASSET_DIR)
    }

    /**
     * [applyBootSelection]'s equivalent for `load()`, where `bridge.setServerBasePath()`
     * itself isn't safe to call yet (see `load()`'s doc comment). `Bridge.loadWebView()`
     * — which runs moments later, after `registerAllPlugins()` (and so this) returns,
     * still within the same synchronous Bridge-construction call — already has its own
     * mechanism for exactly this: it reads a persisted path from the same
     * `CapWebViewSettings`/`serverBasePath` `SharedPreferences` entry the built-in
     * `com.getcapacitor.plugin.WebView` plugin's `persistServerBasePath()` writes, and
     * calls the (by-then-safe) `setServerBasePath()` with it — *before* the WebView's
     * first `loadUrl()`. Writing that same entry here piggybacks on that existing,
     * already-correct path instead of racing Bridge's own construction.
     *
     * This is a deliberate, narrow exception to ADR-0004's "never write Capacitor's own
     * persisted-path key" decision — that decision predates discovering that
     * `setServerBasePath()` itself isn't callable from `load()` at all. The key is only
     * ever written here, recomputed fresh from `state.json` on every single `load()`
     * call, so it never carries a value `state.json` didn't just produce — see
     * [clearPersistedServerBasePath] for the other half (the embedded case must clear
     * it, or a stale entry from a *previous* boot would resurface via the same
     * Bridge-side restore mechanism this piggybacks on).
     */
    private fun applyBootSelectionAtLoad(packageHash: String) {
        val contentsDir = implementation.resolveContentsDir(packageHash) ?: return
        webViewSettingsPrefs().edit().putString(CAP_SERVER_PATH_PREF_KEY, contentsDir.absolutePath).apply()
    }

    /** See [applyBootSelectionAtLoad]'s doc comment for why this is needed. */
    private fun clearPersistedServerBasePath() {
        webViewSettingsPrefs().edit().remove(CAP_SERVER_PATH_PREF_KEY).apply()
    }

    /**
     * Matches `com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME`/`CAP_SERVER_PATH`
     * (not importable directly — package-private in that class) exactly, since
     * `Bridge.loadWebView()` reads this same file/key by those literal names.
     */
    private fun webViewSettingsPrefs() = context.getSharedPreferences(CAP_WEBVIEW_SETTINGS_PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Shared rejection for methods whose implementation has not landed yet. [method] and
     * [phase] are used verbatim in the message so a caller can find the exact plan item
     * in `specs/IMPLEMENTATION-PLAN.md`.
     */
    private fun rejectUnimplemented(
        call: PluginCall,
        method: String,
        phase: Int,
    ) {
        call.reject(
            "CodemagicPatch.$method() is not implemented yet (planned for Phase $phase; " +
                "see specs/IMPLEMENTATION-PLAN.md).",
            "UNIMPLEMENTED",
        )
    }

    /**
     * Every storage-touching method runs through this. Capacitor's own
     * `Bridge.callPluginMethod` re-throws an uncaught `Exception` from a plugin method as
     * a `RuntimeException` on its background handler thread (`Bridge.java:854-856`,
     * verified against `@capacitor/android` 8.5.1) — uncaught, that crashes the app
     * rather than gracefully rejecting the JS call. Every method below can throw
     * (`java.io.IOException` from an interrupted atomic write, `IllegalStateException`
     * from a malformed download record, disk-full, ...), so every one of them is
     * wrapped here rather than trusted to stay exception-free.
     *
     * [errorCode] defaults to `"INTEGRITY_ERROR"` for storage/install-related methods;
     * `fetchManifest`/`downloadUpdate` pass `"NETWORK_ERROR"` explicitly (matching iOS's
     * `rejectNetworkError` and `CodemagicPatchErrorCode.NetworkError` in
     * `src/definitions.ts`) — a connection failure surfacing to a caught app-level
     * exception as `INTEGRITY_ERROR` was a real, previously-undetected bug, found by
     * actually triggering a mid-download network failure on the Android emulator
     * (specs/IMPLEMENTATION-PLAN.md Phase 4). The `Failed` metric event's own `reason`
     * field is unaffected either way — it's set by which stage failed, not by parsing
     * this code — but a real app catching this error natively deserves the correct one.
     */
    private fun runOrReject(
        call: PluginCall,
        method: String,
        errorCode: String = "INTEGRITY_ERROR",
        block: () -> Unit,
    ) {
        try {
            block()
        } catch (error: Exception) {
            call.reject("CodemagicPatch.$method() failed: ${error.message}", errorCode)
        }
    }

    /**
     * Rejects with `NETWORK_ERROR` and attaches `data.detail_code`/`data.detail_message`
     * — PROTOCOL.md § Metric Event `Failed` Payload's `network` reason, read by
     * `src/protocol/failurePayload.ts`'s `networkFailurePayload()` off `error.data.
     * detail_code` — matching iOS's `rejectNetworkError` exactly. Used instead of
     * `runOrReject`'s generic data-less rejection for `fetchManifest`/`downloadUpdate`,
     * whose failures must carry the origin's own status/message rather than a
     * client-composed one (PROTOCOL.md: "the client never composes it").
     * `CodemagicPatchFailure.httpStatusCode` already degrades to the `"0"` no-response
     * sentinel for anything that isn't a `CodemagicPatchHttpException` — a plain
     * transport-level `IOException`, say — so this one path covers both a real HTTP
     * failure and a connection failure uniformly, rather than needing a second
     * exception-type-specific branch that a plain `IOException` could fall through.
     */
    private fun rejectNetworkError(
        call: PluginCall,
        method: String,
        error: Exception,
        context: Map<String, String> = emptyMap(),
    ) {
        val data = JSObject()
        data.put(CodemagicPatchFailure.DETAIL_CODE_KEY, CodemagicPatchFailure.httpStatusCode(error))
        data.put(CodemagicPatchFailure.DETAIL_MESSAGE_KEY, error.message ?: "")
        for ((key, value) in context) {
            data.put(key, value)
        }
        call.reject("CodemagicPatch.$method() failed: ${error.message}", "NETWORK_ERROR", data)
    }

    @PluginMethod
    fun getBootState(call: PluginCall) =
        runOrReject(call, "getBootState") {
            // A crash rollback can, in principle, first resolve here rather than in
            // load() — resolveBootSelection() only memoizes *after* binaryVersion() is
            // known, and load() bails out before that if binaryVersion() is briefly
            // unavailable (see CodemagicPatch.getBootState()'s own doc comment). Passing
            // the same callback here, not just in load(), is what keeps that edge case
            // from silently dropping the one Failed event a genuine rollback must emit.
            val bootState =
                implementation.getBootState { packageHash, failedAt ->
                    enqueueCrashRollbackEvent(implementation.binaryVersion() ?: "", packageHash, failedAt)
                }
            call.resolve(jsObjectOf(bootState))
        }

    @PluginMethod
    fun fetchManifest(call: PluginCall) =
        runOrReject(call, "fetchManifest", errorCode = "NETWORK_ERROR") {
            val cfg =
                config.getOrElse {
                    call.reject("CodemagicPatch configuration is invalid: ${it.message}", "CONFIGURATION_INVALID")
                    return@runOrReject
                }
            val binaryVersion = implementation.binaryVersion()
            val runningHash = implementation.currentRunningPackageHash()

            val context = JSObject()
            context.put("deploymentKey", cfg.deploymentKey)
            context.putNullable("binaryVersion", binaryVersion)
            context.putNullable("runningPackageHash", runningHash)
            // Blank, not the hydrated device id: a missing binary version means no
            // fetch happens below, and applyNativeManifestContext() (src/protocol/
            // checkForUpdate.ts) deliberately never lets an empty native deviceId
            // clobber whatever ensureHydrated() already hydrated from a real
            // getDeviceId() call earlier in this same round.
            context.put("deviceId", if (binaryVersion == null) "" else implementation.getDeviceId())
            context.put("publicKeyConfigured", cfg.publicKey != null)

            val ret = JSObject()
            ret.put("context", context)
            if (binaryVersion == null) {
                ret.put("status", "not-found")
                ret.put("source", "binary-version")
                ret.putNullable("manifestJson", null)
                ret.putNullable("metaJson", null)
                call.resolve(ret)
                return@runOrReject
            }

            val manifestClient = manifestClient ?: error("manifest client unavailable despite valid config")
            val result =
                try {
                    manifestClient.fetchManifest(binaryVersion, runningHash)
                } catch (error: Exception) {
                    // Carried on the rejection too, not just a resolved call: JS has no
                    // other way to learn deploymentKey/binaryVersion for the
                    // Failed(reason=network) event it records for this exact failure
                    // (src/protocol/checkForUpdate.ts) — state.deploymentKey has no
                    // source until a manifest fetch actually succeeds once, so without
                    // this every failure before that first success (which, for a
                    // sustained outage, may be every failure in the session) would
                    // otherwise report an empty deployment_key.
                    rejectNetworkError(
                        call,
                        "fetchManifest",
                        error,
                        context = mapOf("deployment_key" to cfg.deploymentKey, "binary_version" to binaryVersion),
                    )
                    return@runOrReject
                }
            ret.put("status", result.status)
            ret.put("source", result.source)
            ret.putNullable("manifestJson", result.manifestJson)
            ret.putNullable("metaJson", result.metaJson)
            call.resolve(ret)
        }

    @PluginMethod
    fun getDeviceId(call: PluginCall) =
        runOrReject(call, "getDeviceId") {
            val ret = JSObject()
            ret.put("deviceId", implementation.getDeviceId())
            call.resolve(ret)
        }

    @PluginMethod
    fun getPackageMetadata(call: PluginCall) =
        runOrReject(call, "getPackageMetadata") {
            val packageHash = call.getString("packageHash")
            if (packageHash.isNullOrBlank()) {
                call.reject("packageHash is required", "INVALID_ARGUMENT")
                return@runOrReject
            }
            val metadata = implementation.getPackageMetadata(packageHash)
            val ret = JSObject()
            ret.put("metadata", metadata?.let { jsObjectOf(it) } ?: JSObject.NULL)
            call.resolve(ret)
        }

    @PluginMethod
    fun enqueueMetricEvent(call: PluginCall) {
        // Never routed through runOrReject's error-coded rejection: "a failed enqueue
        // may drop that metric event, but it must not surface as INTEGRITY_ERROR and
        // must not alter SDK control-plane behavior" (client/specs/metrics/Spec.md §
        // Native Queue Bridge Contract) — this always resolves, even when the envelope
        // is missing/malformed and CodemagicPatchMetricsQueue.enqueue() drops it.
        val eventJson = call.getString("eventJson")
        if (!eventJson.isNullOrBlank()) {
            metricsDelivery.enqueue(eventJson)
        }
        call.resolve()
    }

    @PluginMethod
    fun downloadUpdate(call: PluginCall) =
        runOrReject(call, "downloadUpdate", errorCode = "NETWORK_ERROR") {
            val packageHash = call.getString("packageHash")
            val artifactType = call.getString("artifactType")
            val url = call.getString("url")
            if (packageHash.isNullOrBlank() || artifactType.isNullOrBlank() || url.isNullOrBlank()) {
                call.reject("packageHash, artifactType and url are required", "INVALID_ARGUMENT")
                return@runOrReject
            }
            val cfg =
                config.getOrElse {
                    call.reject("CodemagicPatch configuration is invalid: ${it.message}", "CONFIGURATION_INVALID")
                    return@runOrReject
                }
            val downloader = downloader ?: error("downloader unavailable despite valid config")
            val metadata = call.getObject("metadata") ?: JSObject()
            val expectedBytes = call.getInt("expectedBytes")?.toLong()

            try {
                downloader.download(
                    CodemagicPatchDownloader.Request(
                        packageHash = packageHash,
                        artifactType = artifactType,
                        url = url,
                        expectedBytes = expectedBytes,
                        deploymentKey = cfg.deploymentKey,
                        label = metadata.getString("label") ?: packageHash,
                        isMandatory = metadata.getBool("isMandatory") ?: false,
                        releaseNotes = metadata.getString("releaseNotes"),
                        signatureVerified = metadata.getBool("signatureVerified") ?: false,
                        basePackageHash = if (artifactType == "patch") implementation.currentRunningPackageHash() else null,
                    ),
                ) { receivedBytes ->
                    emitDownloadProgress(packageHash, artifactType, expectedBytes, receivedBytes)
                }
            } catch (error: Exception) {
                // Not just CodemagicPatchHttpException: a transport-level failure
                // (connection refused, DNS failure, timeout) is a plain IOException
                // with no HTTP status at all, and must carry data.detail_code = "0"
                // (PROTOCOL.md's no-response sentinel) rather than falling through to
                // runOrReject's data-less rejection.
                rejectNetworkError(call, "downloadUpdate", error)
                return@runOrReject
            }
            call.resolve()
        }

    /** Matches `NativeDownloadProgressEvent` (src/protocol/downloadUpdate.ts) exactly. */
    private fun emitDownloadProgress(
        packageHash: String,
        artifactType: String,
        expectedBytes: Long?,
        receivedBytes: Long,
    ) {
        val event = JSObject()
        event.put("packageHash", packageHash)
        event.put("artifactType", artifactType)
        event.put("receivedBytes", receivedBytes.coerceAtLeast(0))
        event.put("totalBytes", (expectedBytes ?: 0).coerceAtLeast(0))
        notifyListeners("CodemagicPatchDownloadProgress", event)
    }

    /**
     * State-only — see [CodemagicPatch.installUpdate]'s own doc comment for why this
     * must never touch the WebView, for any install mode including `IMMEDIATE`.
     * Activation happens exclusively in [reloadBundle], below.
     */
    @PluginMethod
    fun installUpdate(call: PluginCall) =
        runOrReject(call, "installUpdate") {
            val packageHash = call.getString("packageHash")
            if (packageHash.isNullOrBlank()) {
                call.reject("packageHash is required", "INVALID_ARGUMENT")
                return@runOrReject
            }
            implementation.installUpdate(packageHash)
            call.resolve()
        }

    @PluginMethod
    fun confirmPendingUpdate(call: PluginCall) =
        runOrReject(call, "confirmPendingUpdate") {
            implementation.confirmPendingUpdate()
            call.resolve()
        }

    @PluginMethod
    fun stageEmbeddedRevert(call: PluginCall) =
        runOrReject(call, "stageEmbeddedRevert") {
            implementation.stageEmbeddedRevert()
            call.resolve()
        }

    @PluginMethod
    fun clearUpdatesForTests(call: PluginCall) =
        runOrReject(call, "clearUpdatesForTests") {
            implementation.clearUpdatesForTests()
            call.resolve()
        }

    /**
     * The real activation path — the only place the WebView is ever switched to a
     * different package, or back to the embedded bundle. Called by JS for `IMMEDIATE`
     * installs (right after `installUpdate()`), for a manual `restartApp()`, and on the
     * app-state transitions [notifyAppStateChange] reports, for `ON_NEXT_RESUME`/
     * `ON_NEXT_SUSPEND`. Re-resolves the boot selection fresh against whatever
     * `state.json` says *right now* — never trusts a value computed earlier — so it
     * correctly picks up a package installed after this process's first resolution.
     */
    @PluginMethod
    fun reloadBundle(call: PluginCall) =
        runOrReject(call, "reloadBundle") {
            val binaryVersion = implementation.binaryVersion()
            if (binaryVersion == null) {
                bridge.reload()
                call.resolve()
                return@runOrReject
            }
            when (
                val selection =
                    implementation.resolveBootSelection(binaryVersion) { packageHash, failedAt ->
                        enqueueCrashRollbackEvent(binaryVersion, packageHash, failedAt)
                    }
            ) {
                is CodemagicPatchBootSelection.Pending -> applyBootSelection(selection.packageHash)
                is CodemagicPatchBootSelection.Current -> applyBootSelection(selection.packageHash)
                is CodemagicPatchBootSelection.Embedded -> applyEmbeddedBootSelection()
            }
            // Whatever was running before this activation (if anything) is no longer
            // protected by `currentRunningPackageHash()` now that `bootSelection` above
            // has moved on — safe to reclaim it.
            implementation.garbageCollectAfterActivation()
            call.resolve()
        }

    @PluginMethod
    fun verifyJwtSignature(call: PluginCall) =
        runOrReject(call, "verifyJwtSignature") {
            val jwt = call.getString("jwt")
            if (jwt.isNullOrEmpty()) {
                call.reject("jwt is required", "INVALID_ARGUMENT")
                return@runOrReject
            }
            val contentHash = call.getString("contentHash")
            if (contentHash.isNullOrEmpty()) {
                call.reject("contentHash is required", "INVALID_ARGUMENT")
                return@runOrReject
            }
            val publicKeyPem = config.getOrNull()?.publicKey ?: ""
            val valid = CodemagicPatchUtil.verifyJwtSignature(jwt, contentHash, publicKeyPem)
            val ret = JSObject()
            ret.put("valid", valid)
            call.resolve(ret)
        }
}
