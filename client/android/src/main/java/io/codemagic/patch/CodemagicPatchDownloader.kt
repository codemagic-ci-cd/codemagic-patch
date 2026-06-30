package io.codemagic.patch

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

internal class CodemagicPatchDownloader(private val storage: CodemagicPatchStorage) {
  data class Request(
    val packageHash: String,
    val artifactType: String,           // "patch" or "full_bundle"
    val url: String,
    val expectedBytes: Long?,
    val metadata: Map<String, Any?>,
    val patchBaseHash: String?,
  )

  fun download(request: Request, onProgress: (receivedBytes: Long) -> Unit) {
    if (request.artifactType == "patch" &&
        request.patchBaseHash?.let { storage.packageContentsDir(it).isDirectory } != true) {
      error("patch download requires a current OTA base")
    }
    val downloadDir = File(storage.root, "downloads/${request.packageHash}")
    storage.delete("downloads/${request.packageHash}")
    downloadDir.mkdirs()

    val payloadName = if (request.artifactType == "patch") "payload.patch.zst" else "payload.tar.zst"
    val expectedBytes = if (request.expectedBytes != null) {
      require(request.expectedBytes >= 0) { "invalid expected byte count" }
      request.expectedBytes.takeIf { it > 0 }
    } else {
      null
    }

    val connection = URL(request.url).openConnection() as HttpURLConnection
    connection.connectTimeout = 10_000
    connection.readTimeout = 180_000
    var downloadedBytes = 0L
    try {
      connection.inputStream.use { input ->
        downloadedBytes = storage.writeStream(
          "downloads/${request.packageHash}/$payloadName",
          input,
        ) { received ->
          onProgress(received)
        }
      }
    } finally {
      connection.disconnect()
    }

    if (expectedBytes != null && downloadedBytes != expectedBytes) {
      downloadDir.deleteRecursively()
      error("downloaded byte count mismatch")
    }

    val record = JSONObject()
      .put("package_hash", request.packageHash)
      .put("artifact_type", request.artifactType)
      .put("payload", payloadName)
      .put("metadata", JSONObject(request.metadata))
      .put("downloaded_at", CodemagicPatchUtil.currentIsoTimestamp())
    if (request.artifactType == "patch") {
      record.put("base_package_hash", request.patchBaseHash)
    }
    storage.writeJson("downloads/${request.packageHash}/download.json", record)
  }
}
