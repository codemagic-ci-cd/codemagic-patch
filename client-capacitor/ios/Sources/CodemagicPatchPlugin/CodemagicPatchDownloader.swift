// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchDownloader.swift (Apache-2.0). Same URLSession download-task
// approach (a download task streams to a system-managed temp file automatically, unlike
// a data task, which would hold the whole payload in memory), byte-count check (not a
// hash check — package_hash verification happens later, over the *extracted* contents
// tree, in CodemagicPatchPackageInstaller.install(); see specs/PROTOCOL-CONFORMANCE.md
// H10/A9), and download.json record shape. One deliberate divergence, documented in
// specs/UPSTREAM-DIVERGENCE.md: `deployment_key` is written into the download record from
// this package's own resolved CodemagicPatchConfig (Phase 4), since InstallUpdateRequest
// (src/definitions.ts) has no field to carry one through to installUpdate() — see the
// divergence note already on CodemagicPatchPackageInstaller.swift from Phase 3.
import Foundation

final class CodemagicPatchDownloader {
    struct Request {
        let packageHash: String
        let artifactType: String
        let url: String
        let expectedBytes: Int64?
        let deploymentKey: String
        let label: String
        let isMandatory: Bool
        let releaseNotes: String?
        let signatureVerified: Bool
        /// Required when `artifactType` is `"patch"`; the package the patch applies against.
        let basePackageHash: String?
    }

    private let storage: CodemagicPatchStorage

    init(storage: CodemagicPatchStorage) {
        self.storage = storage
    }

    func download(_ request: Request, onProgress: ((Int64) -> Void)? = nil) throws {
        guard CodemagicPatchStorage.isSafePackageHash(request.packageHash) else {
            throw makeError("unsafe packageHash")
        }
        guard request.artifactType == "patch" || request.artifactType == "full_bundle" else {
            throw makeError("artifactType must be \"patch\" or \"full_bundle\"")
        }
        let payloadName = request.artifactType == "patch" ? "payload.patch.zst" : "payload.tar.zst"

        if request.artifactType == "patch" {
            guard let base = request.basePackageHash,
                  FileManager.default.fileExists(atPath: storage.packageContentsDir(base).path) else {
                throw makeError("patch download requires an existing base package on disk")
            }
        }

        guard let url = URL(string: request.url) else {
            throw makeError("invalid download URL: \(request.url)")
        }

        let relativePath = "downloads/\(request.packageHash)/\(payloadName)"
        let downloadedBytes = try downloadSync(url: url, onProgress: onProgress, relativePath: relativePath)

        if let expectedBytes = request.expectedBytes, downloadedBytes != expectedBytes {
            storage.removeRelative("downloads/\(request.packageHash)")
            throw makeError(
                "downloaded byte count (\(downloadedBytes)) does not match expected (\(expectedBytes))"
            )
        }

        try writeDownloadRecord(request, payloadName: payloadName)
    }

    private func downloadSync(
        url: URL,
        onProgress: ((Int64) -> Void)?,
        relativePath: String
    ) throws -> Int64 {
        let delegate = DownloadTaskDelegate(onProgress: onProgress)
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        var request = URLRequest(url: url, timeoutInterval: 180)
        request.httpMethod = "GET"
        let task = session.downloadTask(with: request)
        task.resume()
        delegate.semaphore.wait()

        // URLSession treats a non-2xx response as a *completed* download, not a
        // thrown error — the origin's error body is sitting at the temp file
        // location, and `didCompleteWithError` fires afterward with `error == nil`.
        // This must be checked before `resultError`, or a genuine HTTP failure would
        // fall through to the "no response" case below instead of surfacing its
        // actual status.
        if let status = delegate.resultResponse?.statusCode, !(200...299).contains(status) {
            let body = delegate.resultLocation.flatMap { CodemagicPatchFailure.readErrorBody(at: $0) }
            if let location = delegate.resultLocation {
                try? FileManager.default.removeItem(at: location)
            }
            throw CodemagicPatchFailure.httpError(status: status, message: CodemagicPatchFailure.storageErrorMessage(body))
        }

        if let error = delegate.resultError {
            throw error
        }

        guard let tempLocation = delegate.resultLocation else {
            throw makeError("download produced no file")
        }

        try storage.durablyCommitFile(from: tempLocation, to: relativePath)
        let attributes = try FileManager.default.attributesOfItem(atPath: storage.url(relativePath).path)
        return (attributes[.size] as? NSNumber)?.int64Value ?? 0
    }

    private func writeDownloadRecord(_ request: Request, payloadName: String) throws {
        var record: [String: Any] = [
            "package_hash": request.packageHash,
            "deployment_key": request.deploymentKey,
            "artifact_type": request.artifactType,
            "payload": payloadName,
            "metadata": [
                "label": request.label,
                "isMandatory": request.isMandatory,
                "releaseNotes": request.releaseNotes.map { $0 as Any } ?? NSNull(),
                "signatureVerified": request.signatureVerified
            ],
            "downloaded_at": CodemagicPatchUtil.currentIsoTimestamp()
        ]
        if let basePackageHash = request.basePackageHash {
            record["base_package_hash"] = basePackageHash
        }
        try storage.writeJson("downloads/\(request.packageHash)/download.json", record)
    }

    private func makeError(_ message: String) -> NSError {
        NSError(domain: "CodemagicPatch", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

/// `URLSessionDownloadDelegate` callbacks land on the session's own delegate queue, not
/// the calling thread — results are captured here and released to the waiting caller via
/// `semaphore`, mirroring the synchronous style the rest of this project's iOS network
/// code already uses (`CodemagicPatchManifestClient`, upstream's own module).
private final class DownloadTaskDelegate: NSObject, URLSessionDownloadDelegate {
    let semaphore = DispatchSemaphore(value: 0)
    private let onProgress: ((Int64) -> Void)?

    private(set) var resultLocation: URL?
    private(set) var resultResponse: HTTPURLResponse?
    private(set) var resultError: Error?

    init(onProgress: ((Int64) -> Void)?) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        onProgress?(totalBytesWritten)
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        resultResponse = downloadTask.response as? HTTPURLResponse
        // The system deletes `location` as soon as this method returns, so the file
        // must be moved out to a location this delegate owns before that happens —
        // the caller commits it durably later, once every other check has passed.
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try FileManager.default.moveItem(at: location, to: staging)
            resultLocation = staging
        } catch {
            resultError = error
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            resultError = error
        }
        semaphore.signal()
    }
}
