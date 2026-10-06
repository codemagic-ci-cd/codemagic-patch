// swift-tools-version: 5.9
import Foundation
import PackageDescription

// `-include`'s argument is resolved by the compiler at its own working directory, not
// relative to this manifest — a package-root-relative string here silently fails to
// resolve at actual compile time (verified: "file not found" with the relative form).
// #filePath is this manifest's own absolute path, recomputed fresh on every machine/CI
// run that evaluates it, so building the absolute path from it is portable.
let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let zstdPrefixHeaderPath = "\(packageDirectory)/native/libs/zstd/codemagic_patch_zstd_prefix.h"

let package = Package(
    name: "CodemagicCapacitorPatch",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CodemagicCapacitorPatch",
            targets: ["CodemagicPatchPlugin"])
    ],
    dependencies: [
        // An explicit closed-open range, not `from:` (SPM's "up to next major" operator,
        // i.e. .upToNextMajor) — `from: "8.5.1"` resolves to >=8.5.1 <9.0.0, which makes
        // this package unresolvable for any real Capacitor 7 app's generated CapApp-SPM
        // (it depends on capacitor-swift-pm 7.x). The support policy is Capacitor 7 or
        // 8 (README.md, package.json's peerDependencies) — state that floor/ceiling
        // directly rather than relying on an operator that only expresses one bound.
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", "7.0.0"..<"9.0.0")
    ],
    targets: [
        // Vendored C libraries (specs/NATIVE-LIBS-UPSTREAM.md) — a separate SPM target
        // because a target's sources must live under its own `path`, and this repo
        // deliberately keeps native/libs/ as a single copy shared by both platforms'
        // build systems (mirrored by android/CMakeLists.txt) rather than duplicating it
        // under ios/. Source list, include paths and preprocessor defines mirror
        // android/CMakeLists.txt and CodemagicCapacitorPatch.podspec exactly — all
        // three must be kept in sync by hand if the vendored set ever changes.
        .target(
            name: "CodemagicPatchNativeLibs",
            path: "native/libs",
            exclude: [
                "zstd/LICENSE",
                "zstd/README.md",
                "zstd/gen_zstd_prefix.sh",
                "hdiffpatch/LICENSE",
                "hdiffpatch/README.md"
            ],
            sources: [
                "hashing/package_hash_v1.c",
                "hashing/sha256.c",
                "artifacts/codemagic_patch_artifacts.c",
                "zstd/lib/common/entropy_common.c",
                "zstd/lib/common/error_private.c",
                "zstd/lib/common/fse_decompress.c",
                "zstd/lib/common/xxhash.c",
                "zstd/lib/common/zstd_common.c",
                "zstd/lib/decompress/huf_decompress.c",
                "zstd/lib/decompress/zstd_ddict.c",
                "zstd/lib/decompress/zstd_decompress.c",
                "zstd/lib/decompress/zstd_decompress_block.c",
                "hdiffpatch/codemagic_patch_hpatch.c",
                "hdiffpatch/file_for_patch.c",
                "hdiffpatch/libHDiffPatch/HPatch/patch.c",
                "hdiffpatch/libHDiffPatch/HDiff/private_diff/limit_mem_diff/adler_roll.c",
                "hdiffpatch/dirDiffPatch/dir_patch/dir_patch.c",
                "hdiffpatch/dirDiffPatch/dir_patch/dir_patch_tools.c",
                "hdiffpatch/dirDiffPatch/dir_patch/new_dir_output.c",
                "hdiffpatch/dirDiffPatch/dir_patch/new_stream.c",
                "hdiffpatch/dirDiffPatch/dir_patch/ref_stream.c",
                "hdiffpatch/dirDiffPatch/dir_patch/res_handle_limit.c"
                // hpatchz.c is NOT listed here — it is never compiled as its own
                // translation unit, only #include-d directly by
                // codemagic_patch_hpatch.c. See specs/NATIVE-LIBS-UPSTREAM.md.
            ],
            publicHeadersPath: ".",
            cSettings: [
                .headerSearchPath("hashing"),
                .headerSearchPath("artifacts"),
                .headerSearchPath("zstd/lib"),
                .headerSearchPath("zstd/lib/common"),
                .headerSearchPath("zstd/lib/decompress"),
                .headerSearchPath("hdiffpatch"),
                .headerSearchPath("hdiffpatch/libHDiffPatch/HPatch"),
                .define("ZSTD_DISABLE_ASM", to: "1"),
                .define("ZSTD_LIB_DEPRECATED", to: "0"),
                .define("_IS_USED_MULTITHREAD", to: "0"),
                // Isolates the vendored zstd's C symbols behind a CMPATCH_ prefix so
                // they cannot collide with another copy of zstd/xxhash linked into the
                // host app — see specs/NATIVE-LIBS-UPSTREAM.md and the header's own comment.
                // Mirrors podspec's OTHER_CFLAGS and CMakeLists.txt's
                // target_compile_options, both force-including the same file.
                .unsafeFlags(["-include", zstdPrefixHeaderPath])
            ]),
        // Objective-C++ bridge (CodemagicPatchHashing/CodemagicPatchBundleOps) to the
        // vendored C libraries — its own target because SPM does not support mixing
        // Swift and Objective-C/C++ source files in one target (unlike CocoaPods,
        // which upstream's own single-podspec setup relies on). No React Native
        // dependency either way — see specs/NATIVE-LIBS-UPSTREAM.md.
        .target(
            name: "CodemagicPatchObjCBridge",
            dependencies: ["CodemagicPatchNativeLibs"],
            path: "ios/Sources/CodemagicPatchObjCBridge",
            publicHeadersPath: ".",
            cSettings: [
                // Depending on a target does not put its headers on this target's
                // plain-quoted #include search path (verified: "file not found"
                // without these) — CodemagicPatchHashing.mm/CodemagicPatchBundleOps.mm
                // use `#include "package_hash_v1.h"` / `"codemagic_patch_artifacts.h"`
                // verbatim from upstream, so this target needs those two directories
                // explicitly, the same way CodemagicPatchNativeLibs' own cSettings do.
                // Unlike `-include`'s unsafeFlags argument above, headerSearchPath
                // specifically requires a relative path (an absolute one is rejected
                // at manifest-resolution time) — relative to this target's own `path`,
                // ios/Sources/CodemagicPatchObjCBridge, three levels up is the repo root.
                .headerSearchPath("../../../native/libs/hashing"),
                .headerSearchPath("../../../native/libs/artifacts")
            ]),
        .target(
            name: "CodemagicPatchPlugin",
            dependencies: [
                "CodemagicPatchObjCBridge",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CodemagicPatchPlugin")
    ]
)

// Declared only where the XCTest sources exist. Source distributions of this package
// that ship without test trees would otherwise fail to load at all: SwiftPM rejects a
// root package whose test target points at a missing directory, which would take
// `xcodebuild -scheme CodemagicCapacitorPatch` down with it for no test-related reason.
// SwiftPM caches an evaluated manifest by its text, not by the filesystem it looked at —
// after adding or removing the directory in an existing checkout, pass
// `--manifest-cache none` once (or clear the cache) to see the change.
let testsPath = "ios/Tests/CodemagicPatchPluginTests"
if FileManager.default.fileExists(atPath: "\(packageDirectory)/\(testsPath)") {
    package.targets.append(
        .testTarget(
            name: "CodemagicPatchPluginTests",
            dependencies: ["CodemagicPatchPlugin", "CodemagicPatchObjCBridge"],
            path: testsPath))
}
