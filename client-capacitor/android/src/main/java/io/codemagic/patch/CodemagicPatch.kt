package io.codemagic.patch

import android.content.Context
import java.io.File

/**
 * What [CodemagicPatch.resolveBootSelection] currently resolves to — like upstream's
 * `LaunchSelection`, re-resolved fresh from `state.json` on every call rather than
 * decided once and reused, so a package installed after this process's first
 * resolution (and later activated in-process, e.g. by `IMMEDIATE` or a manual
 * `restartApp()`) is correctly picked up. The one thing that does *not* re-run per
 * call is the crash-loop launch-attempt budget charge — see
 * [CodemagicPatch.resolveBootSelection]'s own doc comment for why it is keyed off
 * "does this resolution's pending hash differ from the previous one," not "has this
 * ever resolved before."
 */
internal sealed class CodemagicPatchBootSelection {
    data class Pending(
        val packageHash: String,
    ) : CodemagicPatchBootSelection()

    data class Current(
        val packageHash: String,
    ) : CodemagicPatchBootSelection()

    object Embedded : CodemagicPatchBootSelection()
}

/**
 * Boot-source resolution and on-device package lifecycle, adapted from upstream
 * `codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a`
 * `client/android/src/main/java/io/codemagic/patch/CodemagicPatch.kt` (Apache-2.0).
 *
 * The crash-loop rollback logic (`prepareBootState`, the launch-attempt budget) is
 * ported near-verbatim — see specs/adr/0004-update-application-and-boot-selection.md.
 * What changed: upstream resolves a **JS bundle file path** for `ReactNativeHost`,
 * because RN reloads by pointing at a single file. This package resolves a **contents
 * directory** for `Bridge.setServerBasePath()`, because Capacitor serves a directory as
 * the WebView's web root. Upstream also has two entry points into this logic (a static
 * pre-module path with no Activity, and the native module) that must not drift from each
 * other; this package has exactly one *implementation* — [resolveBootSelection] — so
 * there is no second copy of the logic to keep in sync, even though it now has two call
 * sites: the plugin's own `load()` (cold boot) and `reloadBundle()` (mid-session
 * activation, once installing an update no longer applies it immediately — see this
 * class's own `installUpdate`) — see the ADR's "Spike resolution".
 */
internal class CodemagicPatch(
    private val context: Context,
    private val storage: CodemagicPatchStorage = CodemagicPatchStorage(context),
    private val maxLaunchAttempts: Int = CodemagicPatchFailure.DEFAULT_MAX_LAUNCH_ATTEMPTS,
) {
    private val installer = CodemagicPatchPackageInstaller(storage)

    private var bootSelection: CodemagicPatchBootSelection? = null
    private var cachedPreviousProcessExit: String? = null
    private var previousProcessExitCached = false

    /**
     * Resolves what should be running *right now*, re-reading `state.json` fresh on
     * every call — like upstream's `selectJSBundleFile()`, not a return-the-first-answer
     * memo. Callers: `load()` (cold boot), `getBootState()` (JS's own query, which in
     * practice only ever runs once per process — see `ensureHydrated()`'s own
     * memoization), and `reloadBundle()`'s activation path, which is exactly why this
     * can no longer stop at the first resolution: an install that landed after the first
     * call (e.g. a deferred `ON_NEXT_RESTART` install, later activated in-process by
     * `IMMEDIATE` or a manual `restartApp()`) must be seen.
     *
     * The launch-attempt budget still charges at most once per *boot of a given
     * package* — comparing this call's resolved pending hash against the *previous*
     * resolution's, not a boolean "have we ever resolved" — matching upstream's own
     * comment on why neither "once per call" nor "once per process" is right: charging
     * every call would let JS's repeated queries drain the budget; charging only the
     * first-ever process resolution would let a package installed and activated
     * in-process (already past `Embedded` by then) boot for free and never accumulate
     * enough spent attempts to ever roll back. [onCrashRollback] is still only invoked
     * from [prepareBootState], which now guards itself against re-running past the
     * first call — see its own doc comment.
     */
    fun resolveBootSelection(
        binaryVersion: String,
        onCrashRollback: (packageHash: String, failedAt: String) -> Unit = { _, _ -> },
    ): CodemagicPatchBootSelection {
        prepareBootState(binaryVersion, onCrashRollback)

        val state = storage.readState()
        val failed = state.failedInstall?.packageHash
        val pending = state.pending?.packageHash
        val selection: CodemagicPatchBootSelection =
            if (pending != null && pending != failed && isBootEligible(pending, binaryVersion)) {
                CodemagicPatchBootSelection.Pending(pending)
            } else {
                val current = state.current?.packageHash
                if (current != null && isBootEligible(current, binaryVersion)) {
                    CodemagicPatchBootSelection.Current(current)
                } else {
                    CodemagicPatchBootSelection.Embedded
                }
            }

        val previousPendingHash = (bootSelection as? CodemagicPatchBootSelection.Pending)?.packageHash
        // Recorded before the charge write is even attempted, not after: if the write
        // below fails (disk full, a permission issue), that failure must not leave the
        // stale previous selection in place — a later call would then see the same
        // "previousPendingHash differs from pending" condition again and double-charge
        // for what is still the same boot of the same package. (Code-review finding —
        // the mirror image of the crash-rollback event's own write-then-callback
        // ordering fix, same reasoning, opposite direction: there the callback had to
        // wait for the write to succeed, here the memo must not.)
        bootSelection = selection

        if (selection is CodemagicPatchBootSelection.Pending && selection.packageHash != previousPendingHash) {
            // Charge once per *boot of this package*, not once per call — see this
            // method's own doc comment for why per-call and per-process are both wrong.
            //
            // Code-review finding: this write used to propagate a storage failure
            // straight out of resolveBootSelection, same as prepareBootState's writes
            // (see that method's own doc comment) — a disk-full launch-attempt charge
            // must degrade the same way every other write here does, not throw. The
            // memo above already being set means a swallowed failure here just means
            // this one attempt's charge isn't durably recorded; it is not retried on
            // this same resolved selection, only on the next one that differs from it.
            try {
                storage.mutateState { it.chargePendingLaunch(selection.packageHash) }
            } catch (_: Exception) {
                // Fall through silently — see above.
            }
        }

        return selection
    }

    /**
     * Decides, once per process, whether an unconfirmed pending package has run out of
     * launch attempts and must be rolled back. See
     * specs/adr/0004-update-application-and-boot-selection.md. [onCrashRollback] is
     * invoked, with the rolled-back package's hash and the failure timestamp, exactly
     * when a rollback is actually applied here — never on a mere unconfirmed-launch
     * budget charge (client/specs/sdk-native/Spec.md § Crash Rollback Detection: "Exactly
     * one event is enqueued per rollback: the unconfirmed launches that merely spent
     * budget emit nothing").
     *
     * Explicitly guarded against running more than once per process — matching
     * upstream's own `hasCompletedLaunchSelection()` check — now that
     * [resolveBootSelection] itself re-resolves on every call instead of memoizing:
     * without this, a later same-process re-resolution (the whole reason it no longer
     * memoizes) would re-run this rollback decision against whatever `state.json` looks
     * like *then*, which is not the boot-time snapshot this decision is about.
     *
     * Code-review finding: every write below used to propagate a storage-write failure
     * (disk full, a permission issue) straight out of this method, and from there out of
     * `resolveBootSelection` — `load()` happens to catch that, but a later same-process
     * `getBootState()` call does not, so it surfaced as a rejected promise instead of the
     * "disk-full or corrupted state must never crash, only ever degrade" contract
     * (specs/IMPLEMENTATION-PLAN.md Phase 3) that iOS's identical writes already honor
     * (`CodemagicPatch.swift`'s `try?`/`do`-`catch` here). Each write below now swallows
     * its own failure the same way: the read-then-resolve logic just above and below
     * this method proceeds against whatever state was actually readable, same as if the
     * write had never been attempted.
     */
    private fun prepareBootState(
        binaryVersion: String,
        onCrashRollback: (packageHash: String, failedAt: String) -> Unit,
    ) {
        if (bootSelection != null) return

        val state = storage.readState()
        val hashes = state.packageHashes
        if (hashes.any { !storage.metadataMatchesBinary(it, binaryVersion) }) {
            // A new app-store binary invalidates every on-disk pointer: none of them
            // can be trusted to still match this build.
            try {
                storage.writeState(CodemagicPatchState())
            } catch (_: Exception) {
                // Fall through silently — see this method's doc comment.
            }
            return
        }

        val started = state.pendingStarted ?: return
        val pending =
            state.pending?.packageHash ?: run {
                try {
                    storage.mutateState { it.clearPendingLaunchTracking() }
                } catch (_: Exception) {
                    // Fall through silently — see this method's doc comment.
                }
                return
            }
        if (started != pending) {
            try {
                storage.mutateState { it.clearPendingLaunchTracking() }
            } catch (_: Exception) {
                // Fall through silently — see this method's doc comment.
            }
            return
        }

        // The previous launch booted this package and never confirmed it. That alone
        // does not prove a crash — the OS can reclaim a healthy process first — so
        // spend an attempt and boot it again until the budget runs out.
        // Compared against the count already spent, so a binary that lowers the budget
        // below it rolls back on this very launch.
        if (state.pendingStartCount < maxLaunchAttempts) {
            return
        }

        val failedAt = CodemagicPatchUtil.currentIsoTimestamp()
        try {
            storage.mutateState {
                it.failedInstall =
                    CodemagicPatchFailedInstall(
                        packageHash = pending,
                        reason = "crash_rollback",
                        failedAt = failedAt,
                    )
                it.pending = null
                it.clearPendingLaunchTracking()
            }
            // Only emit once the rollback is actually durable — a write failure must
            // leave state.json reporting the same unresolved budget-exhausted pending
            // package, not a rollback that never happened, and must not emit an event
            // for it. The next launch will retry this same mutateState call, not skip
            // it — see this method's own "exactly one event is enqueued per rollback".
            onCrashRollback(pending, failedAt)
        } catch (_: Exception) {
            // Fall through silently, matching this method's own degrade-to-embedded
            // contract — the budget stays exhausted and this same rollback attempt is
            // retried on the next launch instead.
        }
    }

    private fun isBootEligible(
        hash: String,
        binaryVersion: String,
    ): Boolean {
        if (!storage.metadataMatchesBinary(hash, binaryVersion)) return false
        return resolveContentsDir(hash) != null
    }

    /** Null unless [hash] is a safe hash with a real, non-empty contents directory on disk. */
    fun resolveContentsDir(hash: String): File? {
        if (!storage.isSafePackageHash(hash)) return null
        val dir = storage.packageContentsDir(hash)
        return if (dir.isDirectory) dir else null
    }

    /**
     * The package hash currently rendering the WebView (pending or current — whichever
     * [resolveBootSelection] landed on), or null on the embedded bundle. Two uses: the
     * only valid base for a patch download (a patch is always relative to what's
     * already materialized on the device, never to an arbitrary hash a manifest names),
     * and the hash garbage collection must never delete out from under the still-live
     * WebView — see [stageEmbeddedRevert]/`installUpdate()` and
     * [garbageCollectAfterActivation].
     */
    fun currentRunningPackageHash(): String? =
        when (val selection = bootSelection) {
            is CodemagicPatchBootSelection.Pending -> selection.packageHash
            is CodemagicPatchBootSelection.Current -> selection.packageHash
            else -> null
        }

    /**
     * Why the previous process ended (Android 11+ only), cached for the life of the
     * process — see the class doc comment on [CodemagicPatchBootSelection] for why
     * memoizing matters here (the value is fixed once the process exists; re-querying
     * it costs a binder call for no benefit).
     */
    fun previousProcessExit(): String? {
        if (!previousProcessExitCached) {
            cachedPreviousProcessExit = CodemagicPatchFailure.previousProcessExitReason(context)
            previousProcessExitCached = true
        }
        return cachedPreviousProcessExit
    }

    fun getDeviceId(): String = storage.getDeviceId()

    fun binaryVersion(): String? =
        try {
            context.packageManager
                .getPackageInfo(context.packageName, 0)
                .versionName
                ?.trim()
                ?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }

    fun getBootState(onCrashRollback: (packageHash: String, failedAt: String) -> Unit = { _, _ -> }): Map<String, Any?> {
        // Resolve first, *then* read state: resolveBootSelection can itself mutate
        // storage (the crash-loop rollback and the binary-version-mismatch reset both
        // write through prepareBootState), so reading state first would report the
        // pre-mutation snapshot instead of what's actually on disk afterward.
        val binaryVersion = binaryVersion()
        val selection =
            binaryVersion?.let { resolveBootSelection(it, onCrashRollback) } ?: CodemagicPatchBootSelection.Embedded
        val state = storage.readState()

        val bootSource: String
        val runningPackageHash: String?
        when (selection) {
            is CodemagicPatchBootSelection.Pending -> {
                bootSource = "pending"
                runningPackageHash = selection.packageHash
            }
            is CodemagicPatchBootSelection.Current -> {
                bootSource = "current"
                runningPackageHash = selection.packageHash
            }
            is CodemagicPatchBootSelection.Embedded -> {
                bootSource = "embedded"
                runningPackageHash = null
            }
        }

        return mapOf(
            "bootSource" to bootSource,
            "runningPackageHash" to runningPackageHash,
            "confirmedPackageHash" to state.current?.packageHash,
            "pendingPackageHash" to state.pending?.packageHash,
            "previousPackageHash" to state.previous?.packageHash,
            "failedInstall" to
                state.failedInstall?.let {
                    mapOf(
                        "packageHash" to it.packageHash,
                        "reason" to it.reason,
                        "failedAt" to it.failedAt,
                    )
                },
            "androidPreviousProcessExit" to previousProcessExit(),
        )
    }

    /**
     * Code-review finding (critical): this projection omitted `successReportedAt`/
     * `lastActiveReportedAt` even though `CodemagicPatchMetricsQueue` writes
     * `success_reported_at`/`last_active_reported_at` into this same `update.json` —
     * `src/definitions.ts`'s `PackageMetadata` already declared both fields, but native
     * never populated them, so every cold-start rehydration (`runtime.ts`'s
     * `createRuntimePackageFromNativeMetadata`) saw both as `null` regardless of what
     * was actually on disk. `emitActiveIfDue()`'s 24-hour dedupe window
     * (`src/protocol/events.ts`) reads `lastActiveReportedAt` on every `notifyAppReady()`
     * call, not just the first confirm, so this meant every restart of an
     * already-confirmed, already-reported package re-emitted `Active` — inflating event
     * counts and violating the metrics spec's once-per-window guarantee.
     */
    fun getPackageMetadata(packageHash: String): Map<String, Any?>? {
        val metadata = storage.packageMetadata(packageHash) ?: return null
        return mapOf(
            "packageHash" to metadata.optString("package_hash"),
            "binaryVersion" to metadata.optString("binary_version"),
            "deploymentKey" to metadata.optString("deployment_key"),
            "label" to metadata.optString("label"),
            "isMandatory" to metadata.optBoolean("is_mandatory", false),
            "releaseNotes" to (if (metadata.isNull("release_notes")) null else metadata.optString("release_notes")),
            "installedAt" to metadata.optString("installed_at"),
            "source" to metadata.optString("source"),
            "signatureVerified" to metadata.optBoolean("signature_verified", false),
            "successReportedAt" to (if (metadata.isNull("success_reported_at")) null else metadata.optString("success_reported_at")),
            "lastActiveReportedAt" to
                (if (metadata.isNull("last_active_reported_at")) null else metadata.optString("last_active_reported_at")),
        )
    }

    /**
     * State-only, like upstream's `CodemagicPatchModule.installUpdate` — this never
     * touches `bootSelection` or the WebView. [runningPackageHash] (the only valid base
     * for a patch, and what garbage collection must not delete out from under the still-
     * rendering WebView) is whatever is *currently* cached, deliberately read before
     * this call does anything — activating the freshly installed package, for any
     * install mode including `IMMEDIATE`, is `reloadBundle()`'s job alone, so that a
     * plugin-layer bug can never again apply the switch before the JS activation state
     * machine (restart suppression, install-mode gating) has had a say. See
     * specs/adr/0004-update-application-and-boot-selection.md.
     */
    fun installUpdate(packageHash: String) {
        val binaryVersion = binaryVersion() ?: error("binary version unavailable")
        installer.install(
            CodemagicPatchPackageInstaller.InstallContext(
                packageHash = packageHash,
                binaryVersion = binaryVersion,
                runningPackageHash = currentRunningPackageHash(),
            ),
        )
    }

    fun confirmPendingUpdate() {
        installer.confirmPending()
        // The confirmed package is still whatever was already rendering — only its
        // state.json bookkeeping changed (pending -> current) — so the cache is
        // updated to match, not reset.
        (bootSelection as? CodemagicPatchBootSelection.Pending)?.let {
            bootSelection = CodemagicPatchBootSelection.Current(it.packageHash)
        }
    }

    /**
     * State-only: what's actually rendered does not change here (see
     * specs/adr/0004-update-application-and-boot-selection.md), so — deliberately —
     * this does not touch the cached `bootSelection`. [currentRunningPackageHash] (read
     * *before* the installer clears every pointer) is passed through so garbage
     * collection protects the package the WebView is still serving under the default
     * `ON_NEXT_RESTART` until `reloadBundle()`'s activation actually switches away from
     * it — see [garbageCollectAfterActivation] and
     * `CodemagicPatchPackageInstaller.garbageCollectSupersededPackages`.
     */
    fun stageEmbeddedRevert() = installer.stageEmbeddedRevert(currentRunningPackageHash())

    /**
     * Reclaims whatever package was running before the activation this call follows.
     * Call only *after* `bootSelection` has already been updated to the newly active
     * selection (i.e. after a fresh [resolveBootSelection] call) — otherwise this would
     * protect the package the activation just switched away from instead of releasing
     * it, which is the one thing [stageEmbeddedRevert]/`installUpdate()`'s own
     * in-installer garbage collection already exists to avoid doing prematurely.
     */
    fun garbageCollectAfterActivation() = installer.garbageCollectSupersededPackages(currentRunningPackageHash())

    fun clearUpdatesForTests() {
        installer.clearForTests()
        bootSelection = null
    }
}
