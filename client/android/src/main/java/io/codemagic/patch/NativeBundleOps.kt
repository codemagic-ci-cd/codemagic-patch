package io.codemagic.patch

internal object NativeBundleOps {
  init {
    runCatching { System.loadLibrary("codemagic_patch_jni") }
  }

  external fun extractBundle(archivePath: String, outDir: String): Boolean

  external fun applyDirectoryPatch(baseDir: String, patchPath: String, outDir: String): Boolean

  external fun validateContentsTree(rootDir: String): Boolean
}
