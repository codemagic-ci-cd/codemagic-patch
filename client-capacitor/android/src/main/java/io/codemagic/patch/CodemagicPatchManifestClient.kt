// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/CodemagicPatchModule.kt's fetchManifest()
// (Apache-2.0) — same URL construction, parallel meta.json fetch, and primary/fallback
// 404 handling. One deliberate divergence, documented in specs/UPSTREAM-DIVERGENCE.md:
// upstream uses OkHttp for this call (and plain HttpURLConnection for downloadUpdate());
// this port uses HttpURLConnection for both, so the project doesn't need a new external
// HTTP dependency just for a small JSON GET — manifest.json/meta.json have no need for
// OkHttp's connection pooling or interceptor machinery. The parallel meta.json fetch
// uses java.util.concurrent.CompletableFuture (API 24+, matching this project's own
// minSdkVersion) instead of OkHttp's async dispatcher.
package io.codemagic.patch

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal class CodemagicPatchManifestClient(
    private val config: CodemagicPatchConfig,
) {
    /** Mirrors `ManifestFetchResult` (src/definitions.ts) field-for-field. */
    data class Result(
        val status: String,
        val source: String,
        val manifestJson: String?,
        val metaJson: String?,
    )

    private data class HttpBody(
        val status: Int,
        val body: String?,
    )

    /**
     * `PROTOCOL.md` § Manifest Path Rule: try the primary path
     * (`{deploymentKey}/{binaryVersion}/{runningPackageHash}/manifest.json`) when a
     * package is currently running; on a 404 there (or when there is no running
     * package to try a primary path for at all), fall back to
     * `{deploymentKey}/{binaryVersion}/manifest.json`. `meta.json` is fetched in
     * parallel and is informational only — any failure there yields `null` and never
     * fails or delays this call (`PROTOCOL-CONFORMANCE.md` M5).
     */
    fun fetchManifest(
        binaryVersion: String,
        runningPackageHash: String?,
    ): Result {
        val base = config.downloadBaseUrl.trimEnd('/')
        val deploymentKey = config.deploymentKey
        val fallbackPath = "/$deploymentKey/$binaryVersion/manifest.json"
        val primaryPath = runningPackageHash?.let { "/$deploymentKey/$binaryVersion/$it/manifest.json" }
        val metaUrl = "$base/$deploymentKey/meta.json"
        val candidateUrl = "$base${primaryPath ?: fallbackPath}"

        val metaFuture =
            CompletableFuture.supplyAsync {
                runCatching { getWithStatus(metaUrl) }.getOrNull()
            }

        val candidate = getWithStatus(candidateUrl)

        val (selected, source) =
            when {
                primaryPath != null && candidate.status == 404 -> getWithStatus("$base$fallbackPath") to "binary-version"
                primaryPath != null -> candidate to "running-package"
                else -> candidate to "binary-version"
            }

        // Code-review finding (critical): this used to wait up to 10 real seconds
        // *after* the manifest request had already resolved, so a stalled meta.json
        // origin delayed every OTA check — directly contradicting this method's own
        // doc comment and PROTOCOL-CONFORMANCE.md's M5 row (both already claimed
        // "never delays this call", which the code didn't actually do). meta.json is
        // informational-only and fetched in parallel specifically so a slow origin can
        // never hold up the manifest path — so this now polls with a zero timeout: use
        // the result only if it is *already* available the instant the manifest
        // request completes, otherwise fall back to null immediately, exactly as an
        // outright meta.json failure already does.
        val metaJson =
            try {
                metaFuture.get(0, TimeUnit.SECONDS)
            } catch (_: Exception) {
                null
            }?.takeIf { it.status == 200 }?.body

        if (selected.status == 404) {
            return Result(status = "not-found", source = "binary-version", manifestJson = null, metaJson = metaJson)
        }
        if (selected.status !in 200..299) {
            throw CodemagicPatchHttpException(selected.status, "manifest fetch failed with HTTP ${selected.status}")
        }
        return Result(status = "ok", source = source, manifestJson = selected.body, metaJson = metaJson)
    }

    private fun getWithStatus(urlString: String): HttpBody {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        try {
            val status = connection.responseCode
            if (status == 404) {
                return HttpBody(status, null)
            }
            if (status !in 200..299) {
                val errorBody = CodemagicPatchFailure.readErrorBody(connection.errorStream)
                throw CodemagicPatchHttpException(status, CodemagicPatchFailure.storageErrorMessage(errorBody))
            }
            val body = connection.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            return HttpBody(status, body)
        } catch (error: IOException) {
            throw error
        } finally {
            connection.disconnect()
        }
    }
}
