// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/CodemagicPatchPackageInstaller.kt
// (Apache-2.0). One deliberate divergence from upstream, documented in
// specs/UPSTREAM-DIVERGENCE.md: upstream's InstallContext carries a deploymentKey
// resolved by the caller from native config resources. This package's
// InstallUpdateRequest (src/definitions.ts) has no such field, and capacitor.config.ts
// reading (ADR-0003) is not implemented yet — that is Phase 4's job, once
// downloadUpdate() actually needs a deployment key to know what to fetch. Until then,
// the deployment key travels with the download record itself
// (downloads/{hash}/download.json's own "deployment_key" field, written by whatever
// created that record) and this installer simply relays it into update.json, rather
// than requiring a config lookup it has no way to perform correctly yet.
package io.codemagic.patch

import android.system.Os
import org.json.JSONObject
import java.io.File

internal class CodemagicPatchPackageInstaller(
    private val storage: CodemagicPatchStorage,
) {
    data class InstallContext(
        val packageHash: String,
        val binaryVersion: String,
        val runningPackageHash: String?,
    )

    fun install(context: InstallContext) {
        require(storage.isSafePackageHash(context.packageHash)) { "unsafe packageHash" }
        val record =
            storage.readJson("downloads/${context.packageHash}/download.json")
                ?: error("download record missing")
        val metadata = record.optJSONObject("metadata") ?: JSONObject()
        val current = storage.readState().current?.packageHash
        require(record.optString("package_hash") == context.packageHash) {
            "download record package hash mismatch"
        }
        val deploymentKey = record.optString("deployment_key")
        require(deploymentKey.isNotBlank()) { "download record deployment key is missing" }
        val artifactType = record.optString("artifact_type")
        require(artifactType == "patch" || artifactType == "full_bundle") {
            "download record artifact type is invalid"
        }
        val expectedPayload = if (artifactType == "patch") "payload.patch.zst" else "payload.tar.zst"
        require(record.optString("payload") == expectedPayload) { "download payload path is invalid" }

        val tmpRoot = File(storage.root, "tmp/${context.packageHash}")
        val tmpContents = File(tmpRoot, "contents")
        tmpRoot.deleteRecursively()
        tmpRoot.mkdirs()

        val payload = File(storage.root, "downloads/${context.packageHash}/$expectedPayload")
        if (!payload.isFile) error("download payload missing")
        if (artifactType == "patch") {
            val base = record.optString("base_package_hash")
            val baseEligible =
                base.isNotBlank() &&
                    base == context.runningPackageHash &&
                    storage.metadataMatchesBinary(base, context.binaryVersion)
            val baseContents = storage.packageContentsDir(base)
            if (!baseEligible || !baseContents.isDirectory) {
                error("patch base package missing")
            }
            if (!NativeBundleOps.applyDirectoryPatch(baseContents.absolutePath, payload.absolutePath, tmpContents.absolutePath)) {
                error("patch application failed")
            }
        } else {
            if (!NativeBundleOps.extractBundle(payload.absolutePath, tmpContents.absolutePath)) {
                error("bundle extraction failed")
            }
        }

        if (!NativeBundleOps.validateContentsTree(tmpContents.absolutePath)) {
            tmpRoot.deleteRecursively()
            error("unsafe package contents")
        }

        val computedHash = NativeHashing.computePackageHash(tmpContents.absolutePath)
        if (computedHash != context.packageHash) {
            tmpRoot.deleteRecursively()
            error("package hash mismatch")
        }

        promotePackageContents(context.packageHash, tmpContents)
        tmpRoot.deleteRecursively()

        val updateJson =
            codemagicPatchUpdateJson(
                packageHash = context.packageHash,
                binaryVersion = context.binaryVersion,
                deploymentKey = deploymentKey,
                artifactType = artifactType,
                metadata = metadata,
                installedAt = CodemagicPatchUtil.currentIsoTimestamp(),
            )
        storage.writeJson("packages/${context.packageHash}/update.json", updateJson)
        storage.mutateState { state ->
            if (current != null && current != context.packageHash) {
                state.previous = CodemagicPatchPackagePointer(current)
            }
            state.pending = CodemagicPatchPackagePointer(context.packageHash)
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
            state.failedInstall = null
        }
        // A new install can push the *previous* previous package out of
        // current/previous/pending entirely (e.g. a third install while a second is
        // still pending) — reclaim it rather than let packages/ grow unbounded.
        // context.runningPackageHash protects whatever the WebView is still serving
        // (relevant when this install's own mode defers activation) from being
        // reclaimed in the same sweep — see garbageCollectSupersededPackages.
        garbageCollectSupersededPackages(context.runningPackageHash)
    }

    fun confirmPending() {
        storage.mutateState { state ->
            val pending = state.pending?.packageHash
            if (pending != null) {
                state.current = CodemagicPatchPackagePointer(pending)
                state.pending = null
                state.clearPendingLaunchTracking()
            }
        }
    }

    /**
     * [runningPackageHash] is read by the caller *before* the pointers below are
     * cleared, and passed through to garbage collection so the package the WebView is
     * still serving under the default `ON_NEXT_RESTART` (every pointer that would
     * otherwise reach it is being cleared right here) survives until `reloadBundle()`'s
     * activation actually switches away from it. Without this, an immediately-following
     * garbage-collection sweep would delete the live running package's own contents
     * directory out from under the still-rendering WebView — see
     * CodemagicPatchPlugin.kt's `reloadBundle()` and `garbageCollectSupersededPackages`.
     */
    fun stageEmbeddedRevert(runningPackageHash: String?) {
        storage.mutateState { state ->
            state.current = null
            state.previous = null
            state.pending = null
            state.clearPendingLaunchTracking()
        }
        // Every installed package other than the one still running is orphaned by a
        // revert to embedded.
        garbageCollectSupersededPackages(runningPackageHash)
    }

    /**
     * Deletes every `packages/{hash}/` directory not referenced by `current`,
     * `previous` or `pending` — the three pointers that `state.json` (and therefore
     * this SDK) can ever reach a package through — *and* not equal to
     * [runningPackageHash], the package the WebView is still actually serving right
     * now, which can differ from all three pointers while an install's activation is
     * deferred (`ON_NEXT_RESTART` and friends). Never touches any of those, so the
     * previous package always survives for rollback, per this phase's own deliverable
     * ("garbage-collect superseded packages, keeping the previous one for rollback" —
     * specs/IMPLEMENTATION-PLAN.md Phase 3) — and the live one always survives until
     * activation has actually moved off it (code-review finding: it previously did not,
     * and got deleted out from under a still-running WebView on every
     * `stageEmbeddedRevert()`).
     */
    fun garbageCollectSupersededPackages(runningPackageHash: String?) {
        val reachable = storage.readState().packageHashes.toSet() + setOfNotNull(runningPackageHash)
        val packagesDir = File(storage.root, "packages")
        packagesDir.listFiles()?.forEach { packageDir ->
            if (packageDir.isDirectory && packageDir.name !in reachable) {
                packageDir.deleteRecursively()
            }
        }
    }

    fun clearForTests() {
        storage.delete("packages")
        storage.delete("downloads")
        storage.delete("tmp")
        storage.delete("state")
    }

    private fun promotePackageContents(
        packageHash: String,
        tmpContents: File,
    ) {
        val packageRoot = File(storage.root, "packages/$packageHash")
        val contentsDir = File(packageRoot, "contents")
        packageRoot.mkdirs()

        if (contentsDir.exists()) {
            val existingValid =
                contentsDir.isDirectory &&
                    NativeBundleOps.validateContentsTree(contentsDir.absolutePath) &&
                    NativeHashing.computePackageHash(contentsDir.absolutePath) == packageHash
            require(existingValid) { "existing package contents are invalid" }
            return
        }

        storage.fsyncTree(tmpContents)
        Os.rename(tmpContents.absolutePath, contentsDir.absolutePath)
        storage.fsyncDirectory(packageRoot)
    }
}

internal fun codemagicPatchUpdateJson(
    packageHash: String,
    binaryVersion: String,
    deploymentKey: String,
    artifactType: String,
    metadata: JSONObject,
    installedAt: String,
): JSONObject =
    JSONObject()
        .put("package_hash", packageHash)
        .put("binary_version", binaryVersion)
        .put("deployment_key", deploymentKey)
        .put("label", metadata.optString("label", packageHash))
        .put("is_mandatory", metadata.optBoolean("isMandatory", false))
        .put("release_notes", nullableMetadataString(metadata, "releaseNotes"))
        .put("installed_at", installedAt)
        .put("source", artifactType)
        .put("signature_verified", metadata.optBoolean("signatureVerified", false))

private fun nullableMetadataString(
    metadata: JSONObject,
    key: String,
): Any = if (metadata.isNull(key)) JSONObject.NULL else metadata.optString(key)
