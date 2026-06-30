import Foundation

final class CodemagicPatchPackageInstaller {
  struct InstallContext {
    let packageHash: String
    let binaryVersion: String
    let deploymentKey: String
    let runningPackageHash: String?
  }

  private let storage: CodemagicPatchStorage

  init(storage: CodemagicPatchStorage) {
    self.storage = storage
  }

  func install(_ context: InstallContext) throws {
    guard CodemagicPatchStorage.isSafePackageHash(context.packageHash),
          let record = storage.readJson("downloads/\(context.packageHash)/download.json") else {
      throw makeError("download record missing")
    }
    let metadata = record["metadata"] as? [String: Any] ?? [:]
    guard record["package_hash"] as? String == context.packageHash else {
      throw makeError("download record package hash mismatch")
    }
    guard let artifactType = record["artifact_type"] as? String,
          artifactType == "patch" || artifactType == "full_bundle" else {
      throw makeError("download record artifact type is invalid")
    }
    let expectedPayload = artifactType == "patch" ? "payload.patch.zst" : "payload.tar.zst"
    guard record["payload"] as? String == expectedPayload else {
      throw makeError("download payload path is invalid")
    }

    let tmpRoot = storage.url("tmp/\(context.packageHash)")
    let tmpContents = tmpRoot.appendingPathComponent("contents", isDirectory: true)
    try? FileManager.default.removeItem(at: tmpRoot)
    try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)

    let payload = storage.url("downloads/\(context.packageHash)/\(expectedPayload)")
    guard FileManager.default.fileExists(atPath: payload.path) else {
      throw makeError("download payload missing")
    }
    if artifactType == "patch" {
      guard let base = record["base_package_hash"] as? String,
            base == context.runningPackageHash,
            storage.metadataMatchesBinary(packageHash: base, binaryVersion: context.binaryVersion),
            FileManager.default.fileExists(atPath: storage.packageContentsDir(base).path) else {
        throw makeError("patch base package missing")
      }
      try runArtifactOperation("patch application failed") {
        CodemagicPatchBundleOps.applyDirectoryPatch(
          withBaseDir: storage.packageContentsDir(base).path,
          patchPath: payload.path,
          outDir: tmpContents.path
        )
      }
    } else {
      try runArtifactOperation("bundle extraction failed") {
        CodemagicPatchBundleOps.extractBundle(payload.path, toOutDir: tmpContents.path)
      }
    }

    try runArtifactOperation("unsafe package contents") {
      CodemagicPatchBundleOps.validateContentsTree(tmpContents.path)
    }

    guard CodemagicPatchHashing.packageHash(atPath: tmpContents.path) == context.packageHash else {
      try? FileManager.default.removeItem(at: tmpRoot)
      throw makeError("package hash mismatch")
    }

    let packageRoot = storage.url("packages/\(context.packageHash)")
    try promotePackageContents(hash: context.packageHash, tmpContents: tmpContents, packageRoot: packageRoot)
    try? FileManager.default.removeItem(at: tmpRoot)

    try storage.writeJson("packages/\(context.packageHash)/update.json", [
      "package_hash": context.packageHash,
      "binary_version": context.binaryVersion,
      "deployment_key": context.deploymentKey,
      "label": metadata["label"] as? String ?? context.packageHash,
      "is_mandatory": metadata["isMandatory"] as? Bool ?? false,
      "release_notes": metadata["releaseNotes"] ?? NSNull(),
      "installed_at": CodemagicPatchUtil.currentIsoTimestamp(),
      "source": artifactType,
      "signature_verified": metadata["signatureVerified"] as? Bool ?? false
    ])
    let current = storage.readState().current?.packageHash
    try storage.mutateState { state in
      if let current = current, current != context.packageHash {
        state.previous = CodemagicPatchPackagePointer(packageHash: current)
      }
      state.pending = CodemagicPatchPackagePointer(packageHash: context.packageHash)
      state.pendingStarted = nil
    }
  }

  func confirmPending() throws {
    try storage.mutateState { state in
      if let pending = state.pending?.packageHash {
        state.current = CodemagicPatchPackagePointer(packageHash: pending)
        state.pending = nil
        state.pendingStarted = nil
      }
    }
  }

  func stageEmbeddedRevert() {
    try? storage.mutateState { state in
      state.current = nil
      state.previous = nil
      state.pending = nil
      state.pendingStarted = nil
    }
  }

  func clearForTests() {
    ["packages", "downloads", "tmp", "state"].forEach {
      storage.removeRelative($0)
    }
  }

  private func promotePackageContents(
    hash: String,
    tmpContents: URL,
    packageRoot: URL
  ) throws {
    let contents = packageRoot.appendingPathComponent("contents", isDirectory: true)
    try FileManager.default.createDirectory(at: packageRoot, withIntermediateDirectories: true)

    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: contents.path, isDirectory: &isDirectory) {
      let existingValid = isDirectory.boolValue &&
        CodemagicPatchBundleOps.validateContentsTree(contents.path) &&
        CodemagicPatchHashing.packageHash(atPath: contents.path) == hash
      guard existingValid else {
        throw makeError("existing package contents are invalid")
      }
      return
    }

    storage.fsyncTree(tmpContents)
    try FileManager.default.moveItem(at: tmpContents, to: contents)
    storage.fsyncDirectory(packageRoot)
  }

  private func runArtifactOperation(_ message: String, _ operation: () -> Bool) throws {
    if !operation() {
      throw makeError(message)
    }
  }

  private func makeError(_ message: String) -> NSError {
    NSError(domain: "CodemagicPatch", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
