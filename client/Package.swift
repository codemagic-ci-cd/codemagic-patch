// swift-tools-version: 6.0
import Foundation
import PackageDescription

// The SDK's manifest for React Native's Swift Package Manager mode
// (`npx react-native spm`, RN 0.88+, New Architecture). CocoaPods apps keep using
// CodemagicPatchClient.podspec; both build the same sources.
//
// This follows React Native's hand-authored library contract as published on
// react-native `main` on 2026-11-03 (scripts/spm/__docs__/spm-header-paths-contract.md):
// React Native reaches this file through `ios/build/generated/autolinking/libs/<SwiftName>`
// in the app, and the two `.package(path:)` entries below are relative to that link
// folder. The manifest therefore resolves only inside an app's autolinking tree;
// `swift build` in this directory is not expected to work.
//
// The Swift name React Native uses for this package is set by `swiftpmConfig.name` in
// package.json (read by RN 0.88+; SwiftPM mode is supported from RN 0.88). The
// package, its library product and the name React Native resolves must all be
// "CodemagicPatchClient": the autolinker refers to `.product(name: <SwiftName>,
// package: <SwiftName>)`.

// `-include`'s argument is resolved from the compiler's working directory, not from
// this manifest, so the prefix header needs an absolute path. #filePath is this
// manifest's own path on the machine evaluating it.
let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let zstdPrefixHeaderPath = "\(packageDirectory)/libs/zstd/codemagic_patch_zstd_prefix.h"

// The React Native header products every target that includes React headers depends
// on (contract rule 1). Nothing else from React Native is linked here: the app links
// the React Native frameworks itself.
let reactNativeHeaders: [Target.Dependency] = [
    .product(name: "ReactHeaders", package: "ReactNative"),
    .product(name: "ReactNativeHeaders", package: "ReactNative"),
    .product(name: "ReactNativeDependenciesHeaders", package: "ReactNative"),
    .product(name: "ReactAppHeaders", package: "React-GeneratedCode"),
]

let package = Package(
    name: "CodemagicPatchClient",
    // React-GeneratedCode declares iOS 15, so this package cannot declare less. The
    // podspec keeps its own, lower minimum for CocoaPods apps.
    platforms: [.iOS(.v15)],
    products: [
        // CodemagicPatchClient is the Swift module apps import (`import
        // CodemagicPatchClient` for `CodemagicPatch.bundleURL()`);
        // CodemagicPatchModuleBridge registers the TurboModule.
        .library(
            name: "CodemagicPatchClient",
            targets: ["CodemagicPatchClient", "CodemagicPatchModuleBridge"])
    ],
    dependencies: [
        .package(name: "ReactNative", path: "../../../../xcframeworks"),
        .package(name: "React-GeneratedCode", path: "../../../ios"),
    ],
    targets: [
        // Vendored C libraries. Each target has its own directory because SwiftPM
        // does not mix Swift and C-family sources in one target, and two C-family
        // targets cannot share a public-headers directory.
        //
        // The source list is explicit and must match the podspec's `libs/` entries
        // and android/CMakeLists.txt (the consumer check compares it with the
        // podspec). Files under `libs/` that are not listed (HDiff's diff side,
        // zstd's compression, licenses, build scripts) are simply not compiled;
        // there are no `exclude:` entries, because an exclude naming a file the npm
        // tarball drops makes SwiftPM warn. hpatchz.c is not listed because
        // codemagic_patch_hpatch.c #includes it.
        .target(
            name: "CodemagicPatchNativeLibs",
            path: "libs",
            sources: [
                "artifacts/codemagic_patch_artifacts.c",
                "hashing/package_hash_v1.c",
                "hashing/sha256.c",
                "hdiffpatch/codemagic_patch_hpatch.c",
                "hdiffpatch/file_for_patch.c",
                "hdiffpatch/libHDiffPatch/HPatch/patch.c",
                "hdiffpatch/libHDiffPatch/HDiff/private_diff/limit_mem_diff/adler_roll.c",
                "hdiffpatch/dirDiffPatch/dir_patch/dir_patch.c",
                "hdiffpatch/dirDiffPatch/dir_patch/dir_patch_tools.c",
                "hdiffpatch/dirDiffPatch/dir_patch/new_dir_output.c",
                "hdiffpatch/dirDiffPatch/dir_patch/new_stream.c",
                "hdiffpatch/dirDiffPatch/dir_patch/ref_stream.c",
                "hdiffpatch/dirDiffPatch/dir_patch/res_handle_limit.c",
                "zstd/lib/common/entropy_common.c",
                "zstd/lib/common/error_private.c",
                "zstd/lib/common/fse_decompress.c",
                "zstd/lib/common/xxhash.c",
                "zstd/lib/common/zstd_common.c",
                "zstd/lib/decompress/huf_decompress.c",
                "zstd/lib/decompress/zstd_ddict.c",
                "zstd/lib/decompress/zstd_decompress.c",
                "zstd/lib/decompress/zstd_decompress_block.c",
            ],
            // Must be an existing directory holding only C headers. "." would turn
            // every header under libs/, including HDiff's C++ headers, into this
            // module's public interface. The Objective-C bridge reaches the headers
            // it needs through its own header search paths instead.
            publicHeadersPath: "hashing",
            cSettings: [
                // The podspec's HEADER_SEARCH_PATHS, plus hashing/.
                .headerSearchPath("hashing"),
                .headerSearchPath("artifacts"),
                .headerSearchPath("hdiffpatch"),
                .headerSearchPath("hdiffpatch/libHDiffPatch/HPatch"),
                .headerSearchPath("zstd/lib"),
                .headerSearchPath("zstd/lib/common"),
                .headerSearchPath("zstd/lib/decompress"),
                .define("ZSTD_DISABLE_ASM", to: "1"),
                .define("ZSTD_LIB_DEPRECATED", to: "0"),
                .define("_IS_USED_MULTITHREAD", to: "0"),
                // What React Native's CocoaPods setup gives every pod (RN 0.76+):
                // DEBUG in Debug, NDEBUG in Release (react_native_post_install adds
                // -DNDEBUG), so assert() behaves the same in both builds.
                .define("DEBUG", to: "1", .when(configuration: .debug)),
                .define("NDEBUG", .when(configuration: .release)),
                // Renames the vendored zstd's symbols to CMPATCH_* so they cannot
                // collide with another zstd copy in the host app. Same header the
                // podspec and android/CMakeLists.txt force-include.
                .unsafeFlags(["-include", zstdPrefixHeaderPath]),
            ]),
        // Objective-C++ bridge from Swift to the C libraries. No React Native headers.
        .target(
            name: "CodemagicPatchObjCBridge",
            dependencies: ["CodemagicPatchNativeLibs"],
            path: "ios/CodemagicPatchObjCBridge",
            publicHeadersPath: ".",
            cSettings: [
                // Same per-configuration defines as CocoaPods gives this code (see above).
                .define("DEBUG", to: "1", .when(configuration: .debug)),
                .define("NDEBUG", .when(configuration: .release)),
                // CodemagicPatchHashing.mm and CodemagicPatchBundleOps.mm use quoted
                // #includes of these C headers; depending on the target does not put
                // them on the quoted search path. Relative to this target's path.
                .headerSearchPath("../../libs/hashing"),
                .headerSearchPath("../../libs/artifacts"),
            ]),
        // The SDK runtime in Swift. Its module name is what apps import.
        .target(
            name: "CodemagicPatchClient",
            dependencies: ["CodemagicPatchObjCBridge"] + reactNativeHeaders,
            path: "ios/CodemagicPatchClient",
            // Contract rule 2: nothing else defines this for a hand-authored
            // package, and CocoaPods sets it through OTHER_SWIFT_FLAGS.
            swiftSettings: [.define("RCT_NEW_ARCH_ENABLED")]),
        // CodemagicPatchModule.mm: the TurboModule conformance and the legacy-bridge
        // registration of the Swift CodemagicPatchModule class.
        .target(
            name: "CodemagicPatchModuleBridge",
            dependencies: ["CodemagicPatchClient"] + reactNativeHeaders,
            path: "ios/CodemagicPatchModuleBridge",
            // The directory holds no headers; it only has to exist.
            publicHeadersPath: ".",
            // Contract rule 2. Without RCT_NEW_ARCH_ENABLED the TurboModule code in
            // CodemagicPatchModule.mm compiles out; without NDEBUG in Release the C++
            // layout differs from the prebuilt React framework and the link fails.
            cSettings: [.define("RCT_NEW_ARCH_ENABLED", to: "1")],
            cxxSettings: [
                .define("RCT_NEW_ARCH_ENABLED", to: "1"),
                .define("DEBUG", .when(configuration: .debug)),
                .define("NDEBUG", .when(configuration: .release)),
            ]),
    ],
    // The sources do not compile in Swift 6 language mode (mutable static state in
    // CodemagicPatch.swift); tools 6.0 would default to it.
    swiftLanguageModes: [.v5],
    cxxLanguageStandard: .cxx20
)
