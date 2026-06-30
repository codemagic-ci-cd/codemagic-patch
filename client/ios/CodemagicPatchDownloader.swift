import Foundation
import Darwin

final class CodemagicPatchDownloader {
  struct Request {
    let packageHash: String
    let artifactType: String           // "patch" or "full_bundle"
    let url: URL
    let expectedBytes: Int64?
    let metadata: [String: Any]
    let patchBaseHash: String?
  }

  private let storage: CodemagicPatchStorage

  init(storage: CodemagicPatchStorage) {
    self.storage = storage
  }

  func download(request: Request, onProgress: @escaping (Int64) -> Void) throws {
    if request.artifactType == "patch" {
      let baseExists = request.patchBaseHash.map {
        FileManager.default.fileExists(atPath: storage.packageContentsDir($0).path)
      } ?? false
      if !baseExists {
        throw makeError("patch download requires a current OTA base")
      }
    }
    if let expectedBytes = request.expectedBytes, expectedBytes < 0 {
      throw makeError("invalid expected byte count")
    }
    let expectedBytes = request.expectedBytes.flatMap { $0 > 0 ? $0 : nil }
    let payload = request.artifactType == "patch" ? "payload.patch.zst" : "payload.tar.zst"
    storage.removeRelative("downloads/\(request.packageHash)")
    try downloadFile(
      from: request.url,
      to: storage.url("downloads/\(request.packageHash)/\(payload)"),
      expectedBytes: expectedBytes,
      onProgress: onProgress
    )
    var record: [String: Any] = [
      "package_hash": request.packageHash,
      "artifact_type": request.artifactType,
      "payload": payload,
      "downloaded_at": CodemagicPatchUtil.currentIsoTimestamp(),
      "metadata": request.metadata
    ]
    if request.artifactType == "patch" {
      record["base_package_hash"] = request.patchBaseHash ?? NSNull()
    }
    try storage.writeJson("downloads/\(request.packageHash)/download.json", record)
  }

  private func downloadFile(
    from url: URL,
    to destination: URL,
    expectedBytes: Int64?,
    onProgress: @escaping (Int64) -> Void
  ) throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 180
    configuration.timeoutIntervalForResource = 180
    let semaphore = DispatchSemaphore(value: 0)
    let delegate = CodemagicPatchDownloadDelegate(
      destination: destination,
      expectedBytes: expectedBytes,
      fileSize: fileSize,
      commitDownloadedFile: commitDownloadedFile,
      onProgress: onProgress,
      semaphore: semaphore
    )
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)

    session.downloadTask(with: url).resume()

    semaphore.wait()
    session.finishTasksAndInvalidate()
    return try delegate.result.get()
  }

  private func commitDownloadedFile(from source: URL, to destination: URL) throws {
    let directory = destination.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let tmp = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).download")
    try? FileManager.default.removeItem(at: tmp)
    do {
      try FileManager.default.moveItem(at: source, to: tmp)
      try fsyncFile(tmp)
      guard rename(tmp.path, destination.path) == 0 else {
        throw CodemagicPatchStorage.posixError("rename failed for \(destination.lastPathComponent)")
      }
      storage.fsyncDirectory(directory)
    } catch {
      try? FileManager.default.removeItem(at: tmp)
      throw error
    }
  }

  private func fileSize(_ url: URL) throws -> Int64 {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let size = attributes[.size] as? NSNumber else {
      throw makeError("downloaded byte count unavailable")
    }
    return size.int64Value
  }

  private func fsyncFile(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY)
    guard fd >= 0 else {
      throw CodemagicPatchStorage.posixError("open failed for \(url.lastPathComponent)")
    }
    defer { _ = close(fd) }
    guard fsync(fd) == 0 else {
      throw CodemagicPatchStorage.posixError("fsync failed for \(url.lastPathComponent)")
    }
  }

  private func makeError(_ message: String) -> NSError {
    NSError(domain: "CodemagicPatch", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

private final class CodemagicPatchDownloadDelegate: NSObject, URLSessionDownloadDelegate {
  let destination: URL
  let expectedBytes: Int64?
  let fileSize: (URL) throws -> Int64
  let commitDownloadedFile: (URL, URL) throws -> Void
  let onProgress: (Int64) -> Void
  let semaphore: DispatchSemaphore
  var result: Result<Void, Error> = .failure(NSError(
    domain: "CodemagicPatch",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: "download failed"]
  ))

  init(
    destination: URL,
    expectedBytes: Int64?,
    fileSize: @escaping (URL) throws -> Int64,
    commitDownloadedFile: @escaping (URL, URL) throws -> Void,
    onProgress: @escaping (Int64) -> Void,
    semaphore: DispatchSemaphore
  ) {
    self.destination = destination
    self.expectedBytes = expectedBytes
    self.fileSize = fileSize
    self.commitDownloadedFile = commitDownloadedFile
    self.onProgress = onProgress
    self.semaphore = semaphore
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    onProgress(totalBytesWritten)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    if let status = (downloadTask.response as? HTTPURLResponse)?.statusCode,
       !(200...299).contains(status) {
      result = .failure(NSError(
        domain: "CodemagicPatch",
        code: status,
        userInfo: [NSLocalizedDescriptionKey: "HTTP \(status)"]
      ))
      return
    }

    do {
      if let expectedBytes = expectedBytes,
         try fileSize(location) != expectedBytes {
        throw NSError(
          domain: "CodemagicPatch",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "downloaded byte count mismatch"]
        )
      }
      try commitDownloadedFile(location, destination)
      result = .success(())
    } catch {
      result = .failure(error)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    if let error = error {
      result = .failure(error)
    }
    semaphore.signal()
  }
}
