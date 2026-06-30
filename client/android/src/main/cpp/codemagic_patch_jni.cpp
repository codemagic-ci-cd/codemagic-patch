#include <jni.h>

#include "codemagic_patch_artifacts.h"
#include "package_hash_v1.h"

extern "C" JNIEXPORT jstring JNICALL
Java_io_codemagic_patch_NativeHashing_computePackageHash(
    JNIEnv *env,
    jobject /* thiz */,
    jstring contents_dir) {
  if (contents_dir == nullptr) {
    return nullptr;
  }

  const char *path = env->GetStringUTFChars(contents_dir, nullptr);
  if (path == nullptr) {
    return nullptr;
  }

  char hash[65];
  int result = codemagic_patch_compute_package_hash(path, hash);
  env->ReleaseStringUTFChars(contents_dir, path);

  if (result != 0) {
    return nullptr;
  }

  return env->NewStringUTF(hash);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_io_codemagic_patch_NativeBundleOps_extractBundle(
    JNIEnv *env,
    jobject /* thiz */,
    jstring archive_path,
    jstring out_dir) {
  if (archive_path == nullptr || out_dir == nullptr) {
    return JNI_FALSE;
  }

  const char *archive = env->GetStringUTFChars(archive_path, nullptr);
  const char *out = env->GetStringUTFChars(out_dir, nullptr);
  if (archive == nullptr || out == nullptr) {
    if (archive != nullptr) {
      env->ReleaseStringUTFChars(archive_path, archive);
    }
    if (out != nullptr) {
      env->ReleaseStringUTFChars(out_dir, out);
    }
    return JNI_FALSE;
  }

  int result = codemagic_patch_extract_tar_zstd(archive, out);
  env->ReleaseStringUTFChars(archive_path, archive);
  env->ReleaseStringUTFChars(out_dir, out);
  return result == 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_io_codemagic_patch_NativeBundleOps_applyDirectoryPatch(
    JNIEnv *env,
    jobject /* thiz */,
    jstring base_dir,
    jstring patch_path,
    jstring out_dir) {
  if (base_dir == nullptr || patch_path == nullptr || out_dir == nullptr) {
    return JNI_FALSE;
  }

  const char *base = env->GetStringUTFChars(base_dir, nullptr);
  const char *patch = env->GetStringUTFChars(patch_path, nullptr);
  const char *out = env->GetStringUTFChars(out_dir, nullptr);
  if (base == nullptr || patch == nullptr || out == nullptr) {
    if (base != nullptr) {
      env->ReleaseStringUTFChars(base_dir, base);
    }
    if (patch != nullptr) {
      env->ReleaseStringUTFChars(patch_path, patch);
    }
    if (out != nullptr) {
      env->ReleaseStringUTFChars(out_dir, out);
    }
    return JNI_FALSE;
  }

  int result = codemagic_patch_apply_hdiffpatch(base, patch, out);
  env->ReleaseStringUTFChars(base_dir, base);
  env->ReleaseStringUTFChars(patch_path, patch);
  env->ReleaseStringUTFChars(out_dir, out);
  return result == 0 ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_io_codemagic_patch_NativeBundleOps_validateContentsTree(
    JNIEnv *env,
    jobject /* thiz */,
    jstring root_dir) {
  if (root_dir == nullptr) {
    return JNI_FALSE;
  }

  const char *root = env->GetStringUTFChars(root_dir, nullptr);
  if (root == nullptr) {
    return JNI_FALSE;
  }

  int result = codemagic_patch_validate_contents_tree(root);
  env->ReleaseStringUTFChars(root_dir, root);
  return result == 0 ? JNI_TRUE : JNI_FALSE;
}
