# Ported verbatim from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
# client/android/CMakeLists.txt (Apache-2.0). The only change is the relative path to
# the vendored libraries (../native/libs, not ../libs — see specs/NATIVE-LIBS-UPSTREAM.md for
# why this repo's layout differs). Every source list, include path, compile definition,
# the zstd symbol-prefix force-include, and the static/shared library link graph are
# unchanged.
cmake_minimum_required(VERSION 3.13)
project(codemagic_patch_client_sdk)

add_library(codemagic_patch_hashing STATIC
  ../native/libs/hashing/package_hash_v1.c
  ../native/libs/hashing/sha256.c
)

target_include_directories(codemagic_patch_hashing PUBLIC
  ../native/libs/hashing
)

add_library(codemagic_patch_zstd STATIC
  ../native/libs/zstd/lib/common/entropy_common.c
  ../native/libs/zstd/lib/common/error_private.c
  ../native/libs/zstd/lib/common/fse_decompress.c
  ../native/libs/zstd/lib/common/xxhash.c
  ../native/libs/zstd/lib/common/zstd_common.c
  ../native/libs/zstd/lib/decompress/huf_decompress.c
  ../native/libs/zstd/lib/decompress/zstd_ddict.c
  ../native/libs/zstd/lib/decompress/zstd_decompress.c
  ../native/libs/zstd/lib/decompress/zstd_decompress_block.c
)

target_include_directories(codemagic_patch_zstd PUBLIC
  ../native/libs/zstd/lib
  ../native/libs/zstd/lib/common
  ../native/libs/zstd/lib/decompress
)

target_compile_definitions(codemagic_patch_zstd PRIVATE
  ZSTD_DISABLE_ASM
  ZSTD_LIB_DEPRECATED=0
)

add_library(codemagic_patch_hdiffpatch STATIC
  ../native/libs/hdiffpatch/codemagic_patch_hpatch.c
  ../native/libs/hdiffpatch/file_for_patch.c
  ../native/libs/hdiffpatch/libHDiffPatch/HPatch/patch.c
  ../native/libs/hdiffpatch/libHDiffPatch/HDiff/private_diff/limit_mem_diff/adler_roll.c
  ../native/libs/hdiffpatch/dirDiffPatch/dir_patch/dir_patch.c
  ../native/libs/hdiffpatch/dirDiffPatch/dir_patch/dir_patch_tools.c
  ../native/libs/hdiffpatch/dirDiffPatch/dir_patch/new_dir_output.c
  ../native/libs/hdiffpatch/dirDiffPatch/dir_patch/new_stream.c
  ../native/libs/hdiffpatch/dirDiffPatch/dir_patch/ref_stream.c
  ../native/libs/hdiffpatch/dirDiffPatch/dir_patch/res_handle_limit.c
)

target_include_directories(codemagic_patch_hdiffpatch PUBLIC
  ../native/libs/hdiffpatch
  ../native/libs/hdiffpatch/libHDiffPatch/HPatch
  ../native/libs/zstd/lib
  ../native/libs/zstd/lib/common
  ../native/libs/zstd/lib/decompress
)

target_compile_definitions(codemagic_patch_hdiffpatch PRIVATE
  _IS_USED_MULTITHREAD=0
)

target_link_libraries(codemagic_patch_hdiffpatch
  codemagic_patch_zstd
)

add_library(codemagic_patch_artifacts STATIC
  ../native/libs/artifacts/codemagic_patch_artifacts.c
)

target_include_directories(codemagic_patch_artifacts PUBLIC
  ../native/libs/artifacts
  ../native/libs/hdiffpatch
  ../native/libs/zstd/lib
  ../native/libs/zstd/lib/common
  ../native/libs/zstd/lib/decompress
)

target_link_libraries(codemagic_patch_artifacts
  codemagic_patch_zstd
  codemagic_patch_hdiffpatch
)

# Isolate the vendored zstd's C symbols (ZSTD_*/HUF_*/FSE_*/XXH*) behind a CMPATCH_
# prefix so they cannot collide with another copy of zstd/xxhash linked into the
# host app (same class of bug as the SSZipArchive/MediaPipe minizip clash — see
# specs/NATIVE-LIBS-UPSTREAM.md). Force-include the (unmodified, vendored) rename header
# into every TU that defines or calls zstd.
set(CODEMAGIC_PATCH_ZSTD_PREFIX_HEADER
  "${CMAKE_CURRENT_SOURCE_DIR}/../native/libs/zstd/codemagic_patch_zstd_prefix.h")
foreach(_cmpatch_zstd_target codemagic_patch_zstd codemagic_patch_hdiffpatch codemagic_patch_artifacts)
  target_compile_options(${_cmpatch_zstd_target} PRIVATE
    "-include" "${CODEMAGIC_PATCH_ZSTD_PREFIX_HEADER}")
endforeach()

add_library(codemagic_patch_jni SHARED
  src/main/cpp/codemagic_patch_jni.cpp
)

target_link_options(codemagic_patch_jni PRIVATE
  "-Wl,-z,max-page-size=16384"
)

target_link_libraries(codemagic_patch_jni
  codemagic_patch_hashing
  codemagic_patch_artifacts
  android
  log
)
