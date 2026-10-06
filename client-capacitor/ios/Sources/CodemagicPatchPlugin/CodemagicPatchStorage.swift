// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchStorage.swift (Apache-2.0). No logic changes — the on-device
// layout (codemagic-patch/{packages,state,downloads,tmp,events}), atomic
// write-to-temp-then-rename with fsync, and the package-hash safety regex are all
// protocol/security properties, not RN-specific ones. One shape change: upstream is a
// process-wide `static let shared` singleton (RN has one JS runtime per process); this
// package takes `root` as an init parameter instead, so tests can point it at an
// isolated temp directory without touching the real Documents directory — see
// CodemagicPatchNativeConformanceTests.swift.
import Foundation
import Darwin

final class CodemagicPatchStorage {
    let root: URL

    init(root: URL) {
        self.root = root
        try? FileManager.default.createDirectory(
            at: root.appendingPathComponent("state", isDirectory: true),
            withIntermediateDirectories: true
        )
    }

    static func inDocumentsDirectory() -> CodemagicPatchStorage {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            fatalError("no Documents directory — impossible on a real iOS device")
        }
        return CodemagicPatchStorage(root: documents.appendingPathComponent("codemagic-patch", isDirectory: true))
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

    func writeBytes(_ relativePath: String, _ data: Data) throws {
        try durableWriteData(data, to: url(relativePath))
    }

    /// Durably commits a file already on disk (e.g. a `URLSessionDownloadTask`'s temp
    /// file) to `relativePath` — move to a same-directory temp name, fsync that file,
    /// atomic rename, fsync the directory. The same durability shape as
    /// `durableWriteData`, but for a file that already exists rather than bytes held in
    /// memory (an artifact payload can be tens of megabytes, too large to buffer the
    /// way `writeBytes` does).
    func durablyCommitFile(from source: URL, to relativePath: String) throws {
        let target = url(relativePath)
        let directory = target.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let tmp = directory.appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        try FileManager.default.moveItem(at: source, to: tmp)

        let fileDescriptor = open(tmp.path, O_RDONLY)
        if fileDescriptor >= 0 {
            _ = fsync(fileDescriptor)
            close(fileDescriptor)
        }

        guard rename(tmp.path, target.path) == 0 else {
            try? FileManager.default.removeItem(at: tmp)
            throw CodemagicPatchStorage.posixError("rename failed for \(target.lastPathComponent)")
        }
        fsyncDirectory(directory)
    }

    func durableWriteData(_ data: Data, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let tmp = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fileDescriptor = open(tmp.path, O_WRONLY | O_CREAT | O_TRUNC, mode_t(S_IRUSR | S_IWUSR))
        guard fileDescriptor >= 0 else {
            throw CodemagicPatchStorage.posixError("open failed for \(tmp.lastPathComponent)")
        }

        var fdOpen = true
        do {
            try data.withUnsafeBytes { rawBuffer in
                guard let baseAddress = rawBuffer.baseAddress else { return }
                var written = 0
                while written < rawBuffer.count {
                    let result = Darwin.write(
                        fileDescriptor,
                        baseAddress.advanced(by: written),
                        rawBuffer.count - written
                    )
                    guard result >= 0 else {
                        throw CodemagicPatchStorage.posixError("write failed for \(tmp.lastPathComponent)")
                    }
                    written += result
                }
            }
            guard fsync(fileDescriptor) == 0 else {
                throw CodemagicPatchStorage.posixError("fsync failed for \(tmp.lastPathComponent)")
            }
            let closeResult = close(fileDescriptor)
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
                _ = close(fileDescriptor)
            }
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
    }

    // MARK: - Filesystem maintenance

    func fsyncDirectory(_ directory: URL) {
        let fileDescriptor = open(directory.path, O_RDONLY)
        guard fileDescriptor >= 0 else { return }
        _ = fsync(fileDescriptor)
        _ = close(fileDescriptor)
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

        let fileDescriptor = open(url.path, O_RDONLY)
        guard fileDescriptor >= 0 else { return }
        _ = fsync(fileDescriptor)
        _ = close(fileDescriptor)
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

    func enforceEventQueueCap(maxEvents: Int = 100) {
        let dir = root.appendingPathComponent("events", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let sorted = files
            .filter { $0.pathExtension == "json" }
            .sorted { left, right in
                let leftDate = (try? left.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let rightDate = (try? right.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return leftDate < rightDate
            }
        let overflow = sorted.count - maxEvents
        if overflow > 0 {
            sorted.prefix(overflow).forEach { try? FileManager.default.removeItem(at: $0) }
        }
    }

    // MARK: - Device id

    func getOrCreateDeviceId() -> String {
        guard let supportRoot = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first else {
            fatalError("no Application Support directory — impossible on a real iOS device")
        }
        let supportDir = supportRoot.appendingPathComponent("codemagic-patch", isDirectory: true)
        let deviceIdFile = supportDir.appendingPathComponent("device_id")

        if let existing = try? String(contentsOf: deviceIdFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return existing
        }

        let generated = UUID().uuidString
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? generated.data(using: .utf8)?.write(to: deviceIdFile, options: .atomic)
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
