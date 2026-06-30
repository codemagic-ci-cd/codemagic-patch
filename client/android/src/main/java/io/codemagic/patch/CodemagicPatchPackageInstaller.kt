package io.codemagic.patch

import android.system.Os
import org.json.JSONObject
import java.io.File

internal class CodemagicPatchPackageInstaller(private val storage: CodemagicPatchStorage) {
  data class InstallContext(
    val packageHash: String,
    val binaryVersion: String,
    val deploymentKey: String,
    val runningPackageHash: String?,
  )

  fun install(context: InstallContext) {
    require(storage.isSafePackageHash(context.packageHash)) { "unsafe packageHash" }
    val record = storage.readJson("downloads/${context.packageHash}/download.json")
      ?: error("download record missing")
    val metadata = record.optJSONObject("metadata") ?: JSONObject()
    val current = storage.readState().current?.packageHash
    require(record.optString("package_hash") == context.packageHash) {
      "download record package hash mismatch"
    }
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
      val baseEligible = base.isNotBlank() &&
          base == context.runningPackageHash &&
          storage.metadataMatchesBinary(base, context.binaryVersion)
      val baseContents = storage.packageContentsDir(base)
      if (!baseEligible || !baseContents.isDirectory) {
        error("patch base package missing")
      }
      if (!NativeBundleOps.applyDirectoryPatch(
          baseContents.absolutePath,
          payload.absolutePath,
          tmpContents.absolutePath
      )) {
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

    val updateJson = codemagicPatchUpdateJson(
      packageHash = context.packageHash,
      binaryVersion = context.binaryVersion,
      deploymentKey = context.deploymentKey,
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
      state.pendingStarted = null
    }
  }

  fun confirmPending() {
    storage.mutateState { state ->
      val pending = state.pending?.packageHash
      if (pending != null) {
        state.current = CodemagicPatchPackagePointer(pending)
        state.pending = null
        state.pendingStarted = null
      }
    }
  }

  fun stageEmbeddedRevert() {
    storage.mutateState { state ->
      state.current = null
      state.previous = null
      state.pending = null
      state.pendingStarted = null
    }
  }

  fun clearForTests() {
    storage.delete("packages")
    storage.delete("downloads")
    storage.delete("tmp")
    storage.delete("state")
  }

  private fun promotePackageContents(packageHash: String, tmpContents: File) {
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

private fun nullableMetadataString(metadata: JSONObject, key: String): Any =
    if (metadata.isNull(key)) JSONObject.NULL else metadata.optString(key)
