require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # Must be exactly "CodemagicCapacitorPatch" — the Capacitor CLI's own SPM/CocoaPods
  # auto-wiring derives the expected pod/product name algorithmically from the npm
  # package name (`@codemagic/capacitor-patch` -> strip the scope, PascalCase the rest,
  # prefix with the scope PascalCased: "Codemagic" + "CapacitorPatch"), never from
  # whatever this file or Package.swift declare — verified against
  # @capacitor/cli's util/spm.js (fixName()) and ios/update.js (`pod '${p.ios.name}'`).
  # A name chosen only to avoid colliding with the upstream RN client's own
  # "CodemagicPatchClient" pod (this project's original reasoning) is not sufficient by
  # itself; it has to be this exact derived string, or `cap add`/`cap sync` cannot
  # resolve this plugin at all. See specs/adr/0007-package-and-identifier-naming.md.
  s.name = 'CodemagicCapacitorPatch'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = package['homepage']
  s.author = package['author']
  # package.json's repository.url carries npm's own "git+https://" convention, which
  # `git clone` (and so CocoaPods' :git source) does not understand as a URL scheme —
  # strip it back to a plain https:// URL.
  s.source = { :git => package['repository']['url'].sub(/\Agit\+/, ''), :tag => s.version.to_s }
  # Native libs globs mirror upstream's own CodemagicPatchClient.podspec (source_files +
  # pod_target_xcconfig) almost verbatim — just the `libs/` -> `native/libs/` path prefix
  # — and android/CMakeLists.txt's source list. All three must be kept in sync by hand if
  # the vendored set ever changes; see specs/NATIVE-LIBS-UPSTREAM.md.
  #
  # hpatchz.c is deliberately NOT matched by any glob below (same as upstream): it is
  # never its own translation unit, only #include-d directly by
  # codemagic_patch_hpatch.c, and this pod is always consumed via a local `:path` (an
  # npm-installed Capacitor plugin), so the file is present on disk for that #include
  # regardless of source_files — see specs/NATIVE-LIBS-UPSTREAM.md.
  s.source_files = [
    'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}',
    'native/libs/hashing/*.{h,c}',
    'native/libs/artifacts/*.{h,c}',
    'native/libs/hdiffpatch/codemagic_patch_hpatch.{h,c}',
    'native/libs/hdiffpatch/file_for_patch.{h,c}',
    'native/libs/hdiffpatch/libHDiffPatch/HPatch/*.{h,c}',
    'native/libs/hdiffpatch/libHDiffPatch/HDiff/private_diff/limit_mem_diff/adler_roll.{h,c}',
    'native/libs/hdiffpatch/dirDiffPatch/dir_patch/*.{h,c}',
    'native/libs/zstd/lib/zstd.h',
    'native/libs/zstd/lib/common/*.{h,c}',
    'native/libs/zstd/lib/decompress/*.{h,c}'
  ]
  s.ios.deployment_target = '15.0'
  # Matches Package.swift's explicit range and the support policy stated in
  # README.md/package.json's peerDependencies (Capacitor 7 or 8) — an unconstrained
  # dependency here would silently resolve against a Capacitor 6 app or a future 9,
  # neither of which this plugin has been verified against.
  s.dependency 'Capacitor', '>= 7.0.0', '< 9.0.0'
  s.swift_version = '5.1'
  s.requires_arc = true
  # CocoaPods derives the Swift module name from `s.name` (CodemagicCapacitorPatch) by
  # default. The existing SPM test target is named `CodemagicPatchPlugin` (Package.swift)
  # and every test file does `@testable import CodemagicPatchPlugin` — overriding the
  # module name here means the same test files compile unmodified under the test_spec
  # below, rather than forking the test sources per build system.
  s.module_name = 'CodemagicPatchPlugin'
  # Without this, CocoaPods treats every header matched by source_files as public and
  # force-imports them all into an auto-generated umbrella header, in an order that does
  # not honor the vendored zstd/hdiffpatch headers' own #include ordering (several rely
  # on their .c file having included zstd.h/etc first, not on standing alone) — this
  # broke the framework build ("unknown type name 'ZSTD_customMem'" and similar) until
  # this line was added. Matches upstream's own podspec, which whitelists only its two
  # bridge headers the same way.
  s.public_header_files = [
    'ios/Sources/CodemagicPatchObjCBridge/CodemagicPatchHashing.h',
    'ios/Sources/CodemagicPatchObjCBridge/CodemagicPatchBundleOps.h'
  ]
  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => [
      '"$(PODS_TARGET_SRCROOT)/native/libs/hashing"',
      '"$(PODS_TARGET_SRCROOT)/native/libs/artifacts"',
      '"$(PODS_TARGET_SRCROOT)/native/libs/zstd/lib"',
      '"$(PODS_TARGET_SRCROOT)/native/libs/zstd/lib/common"',
      '"$(PODS_TARGET_SRCROOT)/native/libs/zstd/lib/decompress"',
      '"$(PODS_TARGET_SRCROOT)/native/libs/hdiffpatch"',
      '"$(PODS_TARGET_SRCROOT)/native/libs/hdiffpatch/libHDiffPatch/HPatch"'
    ].join(' '),
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) ZSTD_DISABLE_ASM=1 ZSTD_LIB_DEPRECATED=0 _IS_USED_MULTITHREAD=0',
    # Isolates the vendored zstd's C symbols behind a CMPATCH_ prefix so they cannot
    # collide with another copy of zstd/xxhash linked into the host app — see
    # specs/NATIVE-LIBS-UPSTREAM.md. Mirrors Package.swift's `-include` unsafeFlag and
    # android/CMakeLists.txt's target_compile_options, both force-including the same file.
    'OTHER_CFLAGS' => '$(inherited) -include "$(PODS_TARGET_SRCROOT)/native/libs/zstd/codemagic_patch_zstd_prefix.h"'
  }
  # The same XCTest suite SPM's `CodemagicPatchPluginTests` target runs, exposed to
  # CocoaPods too: a plain `pod lib lint` builds and runs any declared test_spec
  # automatically (CocoaPods 1.3+), no separate host app or Podfile needed. CI runs the
  # suite once, through SPM, and lints this podspec build-only (`--skip-tests`) — see
  # specs/adr/0011-ci-in-the-patch-monorepo.md.
  #
  # Declared only where the XCTest sources exist — same reason as Package.swift's
  # conditional test target: a source distribution without test trees must still lint,
  # and a test_spec whose source_files match nothing fails validation.
  tests_dir = 'ios/Tests/CodemagicPatchPluginTests'
  if Dir.exist?(File.join(__dir__, tests_dir))
    s.test_spec 'Tests' do |test_spec|
      test_spec.source_files = "#{tests_dir}/**/*.swift"
    end
  end
end
