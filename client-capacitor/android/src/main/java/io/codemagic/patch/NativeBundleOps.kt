// Ported from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/android/src/main/java/io/codemagic/patch/NativeBundleOps.kt (Apache-2.0). No
// logic changes — already in this project's own package, no RN dependency — reformatted
// (4-space indent, one param per line) to satisfy this project's ktlint config.
package io.codemagic.patch

internal object NativeBundleOps {
    init {
        runCatching { System.loadLibrary("codemagic_patch_jni") }
    }

    external fun extractBundle(
        archivePath: String,
        outDir: String,
    ): Boolean

    external fun applyDirectoryPatch(
        baseDir: String,
        patchPath: String,
        outDir: String,
    ): Boolean

    external fun validateContentsTree(rootDir: String): Boolean
}
