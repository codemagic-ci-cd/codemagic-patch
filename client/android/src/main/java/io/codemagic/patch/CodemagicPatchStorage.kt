package io.codemagic.patch

import android.system.Os
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.UUID

internal class CodemagicPatchStorage(
    private val context: android.content.Context
) {
  val root: File = File(context.filesDir, "codemagic-patch")

  private val stateDir = File(root, "state")

  init {
    root.mkdirs()
    stateDir.mkdirs()
  }

  fun readJson(relativePath: String): JSONObject? {
    val file = File(root, relativePath)
    if (!file.isFile) return null
    return try {
      JSONObject(file.readText(Charsets.UTF_8))
    } catch (_: Exception) {
      null
    }
  }

  fun readText(relativePath: String): String? {
    val file = File(root, relativePath)
    return if (file.isFile) file.readText(Charsets.UTF_8) else null
  }

  fun listFiles(relativePath: String): List<File> {
    val dir = File(root, relativePath)
    return dir.listFiles()?.filter { it.isFile }?.toList() ?: emptyList()
  }

  fun writeJson(relativePath: String, json: JSONObject) {
    durableWrite(relativePath, json.toString().toByteArray(Charsets.UTF_8))
  }

  fun writeText(relativePath: String, value: String) {
    durableWrite(relativePath, value.toByteArray(Charsets.UTF_8))
  }

  fun writeBytes(relativePath: String, bytes: ByteArray) {
    durableWrite(relativePath, bytes)
  }

  fun writeStream(relativePath: String, input: InputStream, onProgress: ((Long) -> Unit)? = null): Long {
    val target = File(root, relativePath)
    return durableWrite(target) { output ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      var written = 0L
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        output.write(buffer, 0, read)
        written += read.toLong()
        onProgress?.invoke(written)
      }
      written
    }
  }

  fun readState(): CodemagicPatchState =
      CodemagicPatchState.fromJson(readJson("state/state.json") ?: JSONObject(), ::isSafePackageHash)

  fun writeState(state: CodemagicPatchState) {
    writeJson("state/state.json", state.toJson())
  }

  fun mutateState(mutator: (CodemagicPatchState) -> Unit) {
    val state = readState()
    mutator(state)
    writeState(state)
  }

  private fun durableWrite(relativePath: String, bytes: ByteArray) {
    val target = File(root, relativePath)
    durableWrite(target) { output ->
      output.write(bytes)
      Unit
    }
  }

  private fun <T> durableWrite(target: File, write: (FileOutputStream) -> T): T {
    val parent = target.parentFile ?: error("target has no parent")
    parent.mkdirs()
    val tmp = File(parent, ".${target.name}.${UUID.randomUUID()}.tmp")
    val result =
      try {
        FileOutputStream(tmp).use { output ->
          val value = write(output)
          output.fd.sync()
          value
        }
      } catch (error: Exception) {
        tmp.delete()
        throw error
      }
    try {
      Os.rename(tmp.absolutePath, target.absolutePath)
    } catch (error: Exception) {
      tmp.delete()
      throw error
    }
    fsyncDirectory(parent)
    return result
  }

  fun delete(relativePath: String) {
    val target = File(root, relativePath)
    val parent = target.parentFile
    target.deleteRecursively()
    if (parent != null) {
      fsyncDirectory(parent)
    }
  }

  fun fsyncDirectory(directory: File) {
    try {
      FileInputStream(directory).use { input ->
        input.fd.sync()
      }
    } catch (_: Exception) {
      // Directory fsync is best-effort across Android API levels/filesystems.
    }
  }

  fun fsyncTree(file: File) {
    if (file.isDirectory) {
      file.listFiles()?.forEach { fsyncTree(it) }
      fsyncDirectory(file)
      return
    }
    if (file.isFile) {
      FileInputStream(file).use { input ->
        input.fd.sync()
      }
    }
  }

  fun packageMetadata(packageHash: String): JSONObject? =
      if (isSafePackageHash(packageHash)) readJson("packages/$packageHash/update.json") else null

  fun packageContentsDir(packageHash: String): File =
      File(root, "packages/$packageHash/contents")

  fun metadataMatchesBinary(packageHash: String, binaryVersion: String): Boolean {
    if (!isSafePackageHash(packageHash)) return false
    val metadata = readJson("packages/$packageHash/update.json") ?: return false
    return metadata.optString("package_hash") == packageHash &&
        metadata.optString("binary_version") == binaryVersion
  }

  fun enforceEventQueueCap(maxEvents: Int = 100) {
    val committed = listFiles("events")
      .filter { it.name.endsWith(".json") }
      .sortedBy { it.lastModified() }
    val overflow = committed.size - maxEvents
    if (overflow > 0) {
      committed.take(overflow).forEach { it.delete() }
    }
  }

  fun isSafePackageHash(packageHash: String): Boolean =
      packageHash.isNotBlank() &&
          Regex("^[a-f0-9]{64}$").matches(packageHash)

  fun getDeviceId(): String {
    val prefs = context.getSharedPreferences("codemagic-patch", android.content.Context.MODE_PRIVATE)
    val existing = prefs.getString("device_id", null)
    if (!existing.isNullOrBlank()) return existing
    val generated = UUID.randomUUID().toString()
    prefs.edit().putString("device_id", generated).apply()
    return generated
  }

}
