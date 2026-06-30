require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "CodemagicPatchClient"
  s.version      = package["version"] || "0.0.0"
  s.summary      = "React Native Codemagic Patch client"
  s.homepage     = "https://github.com/codemagic-ci-cd/codemagic-patch"
  s.license      = { :type => "Apache-2.0" }
  s.authors      = { "Codemagic" => "codemagic-patch@example.invalid" }
  s.platforms    = { :ios => "13.4" }
  s.source       = { :path => "." }
  s.source_files = [
    "ios/**/*.{h,m,mm,swift}",
    "libs/hashing/*.{h,c}",
    "libs/artifacts/*.{h,c}",
    "libs/hdiffpatch/codemagic_patch_hpatch.{h,c}",
    "libs/hdiffpatch/file_for_patch.{h,c}",
    "libs/hdiffpatch/libHDiffPatch/HPatch/*.{h,c}",
    "libs/hdiffpatch/libHDiffPatch/HDiff/private_diff/limit_mem_diff/adler_roll.{h,c}",
    "libs/hdiffpatch/dirDiffPatch/dir_patch/*.{h,c}",
    "libs/zstd/lib/zstd.h",
    "libs/zstd/lib/common/*.{h,c}",
    "libs/zstd/lib/decompress/*.{h,c}"
  ]
  s.public_header_files = "ios/CodemagicPatchHashing.h", "ios/CodemagicPatchBundleOps.h"
  s.requires_arc = true
  s.dependency "React-Core"
  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => [
      "\"$(PODS_TARGET_SRCROOT)/libs/artifacts\"",
      "\"$(PODS_TARGET_SRCROOT)/libs/hdiffpatch\"",
      "\"$(PODS_TARGET_SRCROOT)/libs/hdiffpatch/libHDiffPatch/HPatch\"",
      "\"$(PODS_TARGET_SRCROOT)/libs/zstd/lib\"",
      "\"$(PODS_TARGET_SRCROOT)/libs/zstd/lib/common\"",
      "\"$(PODS_TARGET_SRCROOT)/libs/zstd/lib/decompress\""
    ].join(" "),
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) ZSTD_DISABLE_ASM=1 ZSTD_LIB_DEPRECATED=0 _IS_USED_MULTITHREAD=0",
    # Isolate the vendored zstd's C symbols (ZSTD_*/HUF_*/FSE_*/XXH*) behind a CMPATCH_
    # prefix so they cannot collide with another copy of zstd/xxhash linked into the
    # host app (same class of bug as the SSZipArchive/MediaPipe minizip clash).
    # Header is auto-generated — see libs/zstd/gen_zstd_prefix.sh.
    "OTHER_CFLAGS" => "$(inherited) -include \"$(PODS_TARGET_SRCROOT)/libs/zstd/codemagic_patch_zstd_prefix.h\""
  }

  install_modules_dependencies(s) if defined?(install_modules_dependencies)
end
