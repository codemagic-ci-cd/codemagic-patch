// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/CodemagicPatchDownloader.kt
// (Apache-2.0). Same HttpURLConnection-based streaming download, byte-count check (not
// a hash check — package_hash verification happens later, over the *extracted* contents
// tree, in CodemagicPatchPackageInstaller.install(); see specs/PROTOCOL-CONFORMANCE.md
// H10/A9), and download.json record shape. One deliberate divergence, documented in
// specs/UPSTREAM-DIVERGENCE.md: `deployment_key` is written into the download record from
// this package's own resolved CodemagicPatchConfig (Phase 4), since InstallUpdateRequest
// (src/definitions.ts) has no field to carry one through to installUpdate() — see the
// divergence note already on CodemagicPatchPackageInstaller.kt from Phase 3.
package io.codemagic.patch

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

internal class CodemagicPatchDownloader(
    private val storage: CodemagicPatchStorage,
) {
    data class Request(
        val packageHash: String,
        val artifactType: String,
        val url: String,
        val expectedBytes: Long?,
        val deploymentKey: String,
        val label: String,
        val isMandatory: Boolean,
        val releaseNotes: String?,
        val signatureVerified: Boolean,
        /** Required when [artifactType] is `"patch"`; the package the patch applies against. */
        val basePackageHash: String?,
    )

    fun download(
        request: Request,
        onProgress: ((Long) -> Unit)? = null,
    ) {
        require(storage.isSafePackageHash(request.packageHash)) { "unsafe packageHash" }
        require(request.artifactType == "patch" || request.artifactType == "full_bundle") {
            "artifactType must be \"patch\" or \"full_bundle\""
        }
        val payloadName = if (request.artifactType == "patch") "payload.patch.zst" else "payload.tar.zst"

        if (request.artifactType == "patch") {
            val base = request.basePackageHash
            require(!base.isNullOrBlank() && storage.packageContentsDir(base).isDirectory) {
                "patch download requires an existing base package on disk"
            }
        }

        val relativePath = "downloads/${request.packageHash}/$payloadName"
        val downloadedBytes = streamToStorage(request.url, relativePath, onProgress)

        if (request.expectedBytes != null && downloadedBytes != request.expectedBytes) {
            storage.delete("downloads/${request.packageHash}")
            error(
                "downloaded byte count ($downloadedBytes) does not match expected " +
                    "(${request.expectedBytes})",
            )
        }

        writeDownloadRecord(request, payloadName)
    }

    private fun streamToStorage(
        urlString: String,
        relativePath: String,
        onProgress: ((Long) -> Unit)?,
    ): Long {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 10_000
        connection.readTimeout = 180_000
        try {
            // Read the status before touching a stream: HttpURLConnection turns a
            // non-2xx into a bare IOException the moment getInputStream() is called,
            // discarding the status — it must be captured here, while it's still known.
            val status = connection.responseCode
            if (status !in 200..299) {
                val errorBody = CodemagicPatchFailure.readErrorBody(connection.errorStream)
                throw CodemagicPatchHttpException(status, CodemagicPatchFailure.storageErrorMessage(errorBody))
            }
            return connection.inputStream.use { input -> storage.writeStream(relativePath, input, onProgress) }
        } catch (error: IOException) {
            throw error
        } finally {
            connection.disconnect()
        }
    }

    private fun writeDownloadRecord(
        request: Request,
        payloadName: String,
    ) {
        val record =
            JSONObject()
                .put("package_hash", request.packageHash)
                .put("deployment_key", request.deploymentKey)
                .put("artifact_type", request.artifactType)
                .put("payload", payloadName)
                .put(
                    "metadata",
                    JSONObject()
                        .put("label", request.label)
                        .put("isMandatory", request.isMandatory)
                        .put("releaseNotes", request.releaseNotes ?: JSONObject.NULL)
                        .put("signatureVerified", request.signatureVerified),
                ).put("downloaded_at", CodemagicPatchUtil.currentIsoTimestamp())
        if (request.basePackageHash != null) {
            record.put("base_package_hash", request.basePackageHash)
        }
        storage.writeJson("downloads/${request.packageHash}/download.json", record)
    }
}
