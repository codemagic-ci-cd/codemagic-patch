package io.codemagic.patch

internal object NativeHashing {
  init {
    runCatching { System.loadLibrary("codemagic_patch_jni") }
  }

  external fun computePackageHash(contentsDir: String): String
}
