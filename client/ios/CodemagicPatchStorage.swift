import Foundation
import Darwin

final class CodemagicPatchStorage {
  static let shared = CodemagicPatchStorage()

  let root: URL

  private init() {
    let documents = FileManager.default
      .urls(for: .documentDirectory, in: .userDomainMask).first!
    self.root = documents.appendingPathComponent("codemagic-patch", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: root.appendingPathComponent("state", isDirectory: true),
      withIntermediateDirectories: true
    )
  }

  // MARK: - Paths

  func url(_ relativePath: String) -> URL {
    root.appendingPathComponent(relativePath)
  }

  func packageContentsDir(_ packageHash: String) -> URL {
    root.appendingPathComponent("packages/\(packageHash)/contents", isDirectory: true)
  }

  // MARK: - Reads

  func readJson(_ relativePath: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url(relativePath)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }

  func readState() -> CodemagicPatchState {
    guard let data = try? Data(contentsOf: url("state/state.json")),
          let state = try? JSONDecoder().decode(CodemagicPatchState.self, from: data) else {
      return CodemagicPatchState()
    }
    return state.sanitized()
  }

  func writeState(_ state: CodemagicPatchState) throws {
    let data = try JSONEncoder().encode(state)
    try writeBytes("state/state.json", data)
  }

  func mutateState(_ mutator: (inout CodemagicPatchState) throws -> Void) throws {
    var state = readState()
    try mutator(&state)
    try writeState(state)
  }

  func packageMetadata(_ packageHash: String) -> [String: Any]? {
    guard CodemagicPatchStorage.isSafePackageHash(packageHash) else { return nil }
    return readJson("packages/\(packageHash)/update.json")
  }

  func metadataMatchesBinary(packageHash: String, binaryVersion: String) -> Bool {
    guard CodemagicPatchStorage.isSafePackageHash(packageHash),
          let metadata = readJson("packages/\(packageHash)/update.json") else {
      return false
    }
    return metadata["package_hash"] as? String == packageHash &&
      metadata["binary_version"] as? String == binaryVersion
  }

  // MARK: - Writes

  func writeJson(_ relativePath: String, _ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value)
    try writeBytes(relativePath, data)
  }

  func writeText(_ relativePath: String, _ value: String) throws {
    try writeBytes(relativePath, Data(value.utf8))
  }

  func writeBytes(_ relativePath: String, _ data: Data) throws {
    try durableWriteData(data, to: url(relativePath))
  }

  func durableWriteData(_ data: Data, to url: URL) throws {
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let tmp = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
    let fd = open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC, mode_t(S_IRUSR | S_IWUSR))
    guard fd >= 0 else {
      throw CodemagicPatchStorage.posixError("open failed for \(tmp.lastPathComponent)")
    }

    var fdOpen = true
    do {
      try data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return }
        var written = 0
        while written < rawBuffer.count {
          let result = Darwin.write(
            fd,
            baseAddress.advanced(by: written),
            rawBuffer.count - written
          )
          guard result >= 0 else {
            throw CodemagicPatchStorage.posixError("write failed for \(tmp.lastPathComponent)")
          }
          written += result
        }
      }
      guard fsync(fd) == 0 else {
        throw CodemagicPatchStorage.posixError("fsync failed for \(tmp.lastPathComponent)")
      }
      let closeResult = close(fd)
      fdOpen = false
      guard closeResult == 0 else {
        throw CodemagicPatchStorage.posixError("close failed for \(tmp.lastPathComponent)")
      }
      guard rename(tmp.path, url.path) == 0 else {
        throw CodemagicPatchStorage.posixError("rename failed for \(url.lastPathComponent)")
      }
      fsyncDirectory(directory)
    } catch {
      if fdOpen {
        _ = close(fd)
      }
      try? FileManager.default.removeItem(at: tmp)
      throw error
    }
  }

  // MARK: - Filesystem maintenance

  func fsyncDirectory(_ directory: URL) {
    let fd = open(directory.path, O_RDONLY)
    guard fd >= 0 else { return }
    _ = fsync(fd)
    _ = close(fd)
  }

  func fsyncTree(_ url: URL) {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
      return
    }

    if isDirectory.boolValue {
      let children = (try? FileManager.default.contentsOfDirectory(
        at: url,
        includingPropertiesForKeys: nil,
        options: []
      )) ?? []
      children.forEach(fsyncTree)
      fsyncDirectory(url)
      return
    }

    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else { return }
    _ = fsync(fd)
    _ = close(fd)
  }

  func removeItemDurably(at url: URL) {
    let directory = url.deletingLastPathComponent()
    try? FileManager.default.removeItem(at: url)
    fsyncDirectory(directory)
  }

  func removeRelative(_ relativePath: String) {
    removeItemDurably(at: url(relativePath))
  }

  // MARK: - Events

  func eventFileURLs() -> [URL] {
    let dir = root.appendingPathComponent("events", isDirectory: true)
    let files = (try? FileManager.default.contentsOfDirectory(
      at: dir,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    )) ?? []
    return files
      .filter { $0.pathExtension == "json" }
      .sorted { left, right in
        let leftDate = (try? left.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        let rightDate = (try? right.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return leftDate < rightDate
      }
  }

  func enforceEventQueueCap(maxEvents: Int = 100) {
    let files = eventFileURLs()
    let overflow = files.count - maxEvents
    if overflow > 0 {
      files.prefix(overflow).forEach { try? FileManager.default.removeItem(at: $0) }
    }
  }

  // MARK: - Device id

  func getOrCreateDeviceId() -> String {
    let supportDir = FileManager.default
      .urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first!
      .appendingPathComponent("codemagic-patch", isDirectory: true)
    let deviceIdFile = supportDir.appendingPathComponent("device_id")

    if let existing = try? String(contentsOf: deviceIdFile, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines),
       !existing.isEmpty {
      return existing
    }

    let defaults = UserDefaults.standard
    if let existing = defaults.string(forKey: "codemagic-patch.device_id"), !existing.isEmpty {
      try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
      try? existing.data(using: .utf8)?.write(to: deviceIdFile, options: .atomic)
      return existing
    }

    let generated = UUID().uuidString
    try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
    try? generated.data(using: .utf8)?.write(to: deviceIdFile, options: .atomic)
    defaults.set(generated, forKey: "codemagic-patch.device_id")
    return generated
  }

  // MARK: - Static helpers

  static func isSafePackageHash(_ packageHash: String) -> Bool {
    packageHash.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
  }

  static func posixError(_ message: String) -> NSError {
    NSError(
      domain: NSPOSIXErrorDomain,
      code: Int(errno),
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}
