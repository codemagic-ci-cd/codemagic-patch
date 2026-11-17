# iOS sources

The iOS half of `@codemagic/react-native-patch`. Each subdirectory is one Swift Package Manager target in `../Package.swift`, because SwiftPM does not mix Swift and Objective-C/C++ in one target. The CocoaPods podspec (`../CodemagicPatchClient.podspec`) compiles all three directories as a single pod.

| Directory | SwiftPM target | Contents |
| --- | --- | --- |
| `CodemagicPatchObjCBridge/` | `CodemagicPatchObjCBridge` (Objective-C++) | `CodemagicPatchHashing` and `CodemagicPatchBundleOps`, the bridge to the C libraries in `../libs/` |
| `CodemagicPatchClient/` | `CodemagicPatchClient` (Swift) | The SDK runtime; apps `import CodemagicPatchClient` to call `CodemagicPatch.bundleURL()` |
| `CodemagicPatchModuleBridge/` | `CodemagicPatchModuleBridge` (Objective-C++) | `CodemagicPatchModule.mm`, the TurboModule and legacy-bridge registration |

The C libraries themselves (`../libs/`) are the `CodemagicPatchNativeLibs` target.
