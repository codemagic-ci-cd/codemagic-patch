import Foundation
import React
import UIKit

@objc(CodemagicPatchModule)
class CodemagicPatchModule: NSObject {
  @objc var bridge: RCTBridge?

  private let storage = CodemagicPatchStorage.shared
  private let downloader = CodemagicPatchDownloader(storage: CodemagicPatchStorage.shared)
  private let installer = CodemagicPatchPackageInstaller(storage: CodemagicPatchStorage.shared)
  private var metricsRetryAttempt = 0
  private var metricsRetryScheduled = false
  private var metricsBackoffUntil: Date?

  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleForegroundEntry),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
    if UIApplication.shared.applicationState == .active {
      codemagicPatchNetworkQueue.async { [weak self] in
        self?.flushMetricEvents()
      }
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  private func runOnIo(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    rejectCode: String = "INTEGRITY_ERROR",
    _ work: @escaping () throws -> Any?
  ) {
    codemagicPatchIoQueue.async {
      do {
        resolve(try work() ?? NSNull())
      } catch {
        reject(rejectCode, error.localizedDescription, error)
      }
    }
  }

  private func runOnNetwork(
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock,
    rejectCode: String = "INTEGRITY_ERROR",
    _ work: @escaping () throws -> Any?
  ) {
    codemagicPatchNetworkQueue.async {
      do {
        resolve(try work() ?? NSNull())
      } catch {
        reject(rejectCode, error.localizedDescription, error)
      }
    }
  }

  @objc
  func getBootState(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      self.prepareBootState()
      guard let binaryVersion = self.binaryVersionOrNil() else {
        return self.embeddedBootState()
      }
      let state = self.storage.readState()
      let failedHash = state.failedInstall?.packageHash
      let pendingHash = state.pending?.packageHash
      let pending = pendingHash.flatMap {
        $0 == failedHash || !self.isBootEligible($0, binaryVersion: binaryVersion) ? nil : $0
      }
      let currentHash = state.current?.packageHash
      let current = currentHash.flatMap {
        self.isBootEligible($0, binaryVersion: binaryVersion) ? $0 : nil
      }
      let running = self.nativeBootPackageHash(binaryVersion: binaryVersion)
      let source = running != nil && running == pending ? "pending" : (running != nil && running == current ? "current" : "embedded")
      return [
        "bootSource": source,
        "runningPackageHash": running as Any? ?? NSNull(),
        "confirmedPackageHash": current as Any? ?? NSNull(),
        "pendingPackageHash": pending as Any? ?? NSNull(),
        "previousPackageHash": state.previous?.packageHash as Any? ?? NSNull(),
        "failedInstall": self.failedInstall() as Any? ?? NSNull()
      ]
    }
  }

  @objc
  func fetchManifest(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnNetwork(resolve: resolve, reject: reject, rejectCode: "NETWORK_ERROR") {
      // Capture boot/config context on the io queue so it cannot interleave with
      // lifecycle mutations (Spec §Thread Safety); only the network I/O below
      // runs on the network queue.
      let (binaryVersion, runningHash, context): (String?, String?, [String: Any]) = codemagicPatchIoQueueSync {
        let deploymentKey = self.config("CodemagicPatchDeploymentKey")
        let binaryVersion = self.binaryVersionOrNil()
        let runningHash = binaryVersion.flatMap { self.nativeBootPackageHash(binaryVersion: $0) }
        let context: [String: Any] = [
          "deploymentKey": deploymentKey,
          "binaryVersion": binaryVersion as Any? ?? NSNull(),
          "runningPackageHash": runningHash as Any? ?? NSNull(),
          "deviceId": self.getOrCreateDeviceId(),
          "publicKeyConfigured": !self.config("CodemagicPatchPublicKey").isEmpty
        ]
        return (binaryVersion, runningHash, context)
      }
      guard let binaryVersion = binaryVersion else {
        return [
          "status": "not-found",
          "source": "binary-version",
          "manifestJson": NSNull(),
          "metaJson": NSNull(),
          "context": context
        ]
      }
      let deploymentKey = self.config("CodemagicPatchDeploymentKey")
      let base = self.config("CodemagicPatchDownloadBaseUrl").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      let fallback = "\(base)/\(deploymentKey)/\(binaryVersion)/manifest.json"
      let primary = runningHash.map { "\(base)/\(deploymentKey)/\(binaryVersion)/\($0)/manifest.json" }

      // Candidate = primary when an OTA is running, else the binary-version fallback.
      // Fetch meta + candidate concurrently: the dataTasks run on URLSession's own queue,
      // not this serial network queue, so group.wait() is safe (no deadlock). URLSession.shared
      // already pools connections and negotiates HTTP/2, so both can share one handshake.
      let group = DispatchGroup()
      var metaResult: Result<(status: Int, body: String?), Error>?
      var candidateResult: Result<(status: Int, body: String?), Error>?
      self.getAsync("\(base)/\(deploymentKey)/meta.json", into: group) { metaResult = $0 }
      self.getAsync(primary ?? fallback, into: group) { candidateResult = $0 }
      group.wait()

      // meta is fire-and-forget: return a body only for successful metadata responses.
      let meta: String? = {
        if case let .success(value)? = metaResult, value.status == 200 {
          return value.body
        }
        return nil
      }()
      let candidate = try candidateResult!.get()
      let usedFallback = candidate.status == 404 && primary != nil
      let selected = usedFallback ? try self.get(fallback) : candidate

      guard selected.status == 404 || (200...299).contains(selected.status) else {
        throw NSError(
          domain: "CodemagicPatch",
          code: selected.status,
          userInfo: [NSLocalizedDescriptionKey: "HTTP \(selected.status)"]
        )
      }
      return [
        "status": selected.status == 404 ? "not-found" : "ok",
        "source": usedFallback || primary == nil ? "binary-version" : "running-package",
        "manifestJson": selected.status == 404 ? NSNull() : selected.body as Any,
        "metaJson": meta as Any? ?? NSNull(),
        "context": context
      ]
    }
  }

  @objc
  func getDeviceId(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      self.getOrCreateDeviceId()
    }
  }

  @objc
  func getPackageMetadata(_ packageHash: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      guard CodemagicPatchStorage.isSafePackageHash(packageHash),
            let metadata = self.storage.readJson("packages/\(packageHash)/update.json"),
            metadata["package_hash"] as? String == packageHash else {
        return NSNull()
      }
      return metadata
    }
  }

  @objc
  func enqueueMetricEvent(_ eventJson: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    codemagicPatchIoQueue.async {
      self.commitMetricEvent(eventJson)
      resolve(nil)
    }
  }

  @objc
  func downloadUpdate(_ request: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    codemagicPatchNetworkQueue.async {
      var requestedUrlString = ""
      do {
        guard let hash = request["packageHash"] as? String,
              let artifactType = request["artifactType"] as? String,
              let urlString = request["url"] as? String,
              let url = URL(string: urlString) else {
          throw NSError(domain: "CodemagicPatch", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid download request"])
        }
        requestedUrlString = urlString
        guard CodemagicPatchStorage.isSafePackageHash(hash), artifactType == "patch" || artifactType == "full_bundle" else {
          throw NSError(domain: "CodemagicPatch", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid download request"])
        }
        guard let binaryVersion = self.binaryVersionOrNil() else {
          throw NSError(domain: "CodemagicPatch", code: 1, userInfo: [NSLocalizedDescriptionKey: "binary version unavailable"])
        }
        let runningHash = self.nativeBootPackageHash(binaryVersion: binaryVersion)
        let req = CodemagicPatchDownloader.Request(
          packageHash: hash,
          artifactType: artifactType,
          url: url,
          expectedBytes: (request["expectedBytes"] as? NSNumber)?.int64Value,
          metadata: request["metadata"] as? [String: Any] ?? [:],
          patchBaseHash: runningHash
        )
        let totalForProgress = req.expectedBytes.flatMap { $0 > 0 ? $0 : nil } ?? 0
        try self.downloader.download(request: req) { receivedBytes in
          self.emitDownloadProgress(
            packageHash: hash,
            artifactType: artifactType,
            totalBytes: totalForProgress,
            receivedBytes: receivedBytes
          )
        }
        resolve(nil)
      } catch {
        let prefix = requestedUrlString.isEmpty ? "" : "\(requestedUrlString): "
        reject("NETWORK_ERROR", "\(prefix)\(error.localizedDescription)", error)
      }
    }
  }

  @objc
  func installUpdate(_ request: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      guard let hash = request["packageHash"] as? String else {
        throw NSError(domain: "CodemagicPatch", code: 2, userInfo: [NSLocalizedDescriptionKey: "download record missing"])
      }
      guard let binaryVersion = self.binaryVersionOrNil() else {
        throw NSError(domain: "CodemagicPatch", code: 2, userInfo: [NSLocalizedDescriptionKey: "binary version unavailable"])
      }
      try self.installer.install(
        CodemagicPatchPackageInstaller.InstallContext(
          packageHash: hash,
          binaryVersion: binaryVersion,
          deploymentKey: self.config("CodemagicPatchDeploymentKey"),
          runningPackageHash: self.nativeBootPackageHash(binaryVersion: binaryVersion)
        )
      )
      return nil
    }
  }

  @objc
  func confirmPendingUpdate(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      try self.installer.confirmPending()
      return nil
    }
  }

  @objc
  func stageEmbeddedRevert(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      self.installer.stageEmbeddedRevert()
      return nil
    }
  }

  @objc
  func clearUpdatesForTests(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      self.installer.clearForTests()
      return nil
    }
  }

  @objc
  func reloadBundle(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      if let bundleURL = CodemagicPatch.bundleURL() {
        RCTReloadCommandSetBundleURL(bundleURL)
      }
      RCTTriggerReloadCommandListeners("CodemagicPatch update")
      resolve(nil)
    }
  }

  @objc
  func verifyJwtSignature(_ request: [String: Any], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    runOnIo(resolve: resolve, reject: reject) {
      CodemagicPatchUtil.verifyJwtSignature(
        jwt: request["jwt"] as? String ?? "",
        expectedHash: request["contentHash"] as? String ?? "",
        publicKeyPem: self.config("CodemagicPatchPublicKey")
      )
    }
  }

  @objc
  private func handleForegroundEntry() {
    codemagicPatchNetworkQueue.async { [weak self] in
      self?.flushMetricEvents()
    }
  }

  private func commitMetricEvent(_ eventJson: String) {
    do {
      try withCodemagicPatchMetricsLock {
        let event = try JSONSerialization.jsonObject(with: Data(eventJson.utf8)) as? [String: Any]
        let eventId = event?["event_id"] as? String ?? UUID().uuidString
        guard isSafeEventId(eventId) else {
          throw NSError(
            domain: "CodemagicPatch",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "unsafe metric event_id"]
          )
        }
        let eventDictionary = event ?? [:]
        try storage.writeJson("events/\(eventId).json", eventDictionary)
        try applyMetricMetadataSideEffect(eventDictionary)
        storage.enforceEventQueueCap()
      }
    } catch {
    }
  }

  private func isSafeEventId(_ eventId: String) -> Bool {
    guard !eventId.isEmpty, !eventId.contains("..") else { return false }
    return eventId.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil
  }

  private func applyMetricMetadataSideEffect(_ event: [String: Any]) throws {
    guard let eventName = event["event_name"] as? String,
          eventName == "Active" || eventName == "Success",
          let packageHash = event["target_package_hash"] as? String,
          CodemagicPatchStorage.isSafePackageHash(packageHash),
          var metadata = storage.readJson("packages/\(packageHash)/update.json") else {
      return
    }

    let emittedAt = event["emitted_at"] as? String ?? CodemagicPatchUtil.currentIsoTimestamp()
    if eventName == "Active" {
      metadata["last_active_reported_at"] = emittedAt
    } else {
      metadata["success_reported_at"] = emittedAt
    }
    try storage.writeJson("packages/\(packageHash)/update.json", metadata)
  }

  private func failedInstall() -> [String: Any]? {
    guard let failed = storage.readState().failedInstall else { return nil }
    return [
      "packageHash": failed.packageHash,
      "reason": failed.reason,
      "failedAt": failed.failedAt
    ]
  }

  private func embeddedBootState() -> [String: Any] {
    [
      "bootSource": "embedded",
      "runningPackageHash": NSNull(),
      "confirmedPackageHash": NSNull(),
      "pendingPackageHash": NSNull(),
      "previousPackageHash": NSNull(),
      "failedInstall": NSNull()
    ]
  }

  private func prepareBootState() {
    if CodemagicPatch.hasCompletedLaunchSelection {
      return
    }

    guard let binaryVersion = binaryVersionOrNil() else {
      return
    }
    let state = storage.readState()
    let hashes = state.packageHashes
    if hashes.contains(where: { !storage.metadataMatchesBinary(packageHash: $0, binaryVersion: binaryVersion) }) {
      try? storage.writeState(CodemagicPatchState())
      return
    }

    guard let started = state.pendingStarted else {
      return
    }
    guard let pending = state.pending?.packageHash else {
      try? storage.mutateState { $0.pendingStarted = nil }
      return
    }
    if started != pending {
      try? storage.mutateState { $0.pendingStarted = nil }
      return
    }

    let failedAt = CodemagicPatchUtil.currentIsoTimestamp()
    do {
      try storage.mutateState { state in
        state.failedInstall = CodemagicPatchFailedInstall(
          packageHash: pending,
          reason: "crash_rollback",
          failedAt: failedAt
        )
        state.pending = nil
        state.pendingStarted = nil
      }
    } catch {
      return
    }
    enqueueCrashRollbackMetric(packageHash: pending, emittedAt: failedAt)
  }

  private func enqueueCrashRollbackMetric(packageHash: String, emittedAt: String) {
    do {
      try withCodemagicPatchMetricsLock {
        guard let binaryVersion = binaryVersionOrNil() else {
          return
        }
        let deviceId = getOrCreateDeviceId()
        let eventId = CodemagicPatchUtil.crashRollbackEventId(
          deviceId: deviceId,
          packageHash: packageHash,
          failedAt: emittedAt
        )
        try storage.writeJson("events/\(eventId).json", [
          "event_id": eventId,
          "event_name": "Failed",
          "emitted_at": emittedAt,
          "device_id": deviceId,
          "deployment_key": config("CodemagicPatchDeploymentKey"),
          "binary_version": binaryVersion,
          "running_package_hash": NSNull(),
          "target_package_hash": packageHash,
          "platform": "ios",
          "sdk_version": "0.0.0",
          "attributes": [
            "reason": "install_fail",
            "failure_subtype": "crash_rollback"
          ]
        ])
        storage.enforceEventQueueCap()
      }
    } catch {
    }
  }

  private func flushMetricEvents() {
    withCodemagicPatchMetricsLock {
      flushMetricEventsLocked()
    }
  }

  private func flushMetricEventsLocked() {
    if isMetricFlushDeferred() { return }

    let apiUrl = config("CodemagicPatchApiUrl").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !apiUrl.isEmpty,
          let url = URL(string: "\(apiUrl)/v1/metrics/events") else {
      return
    }

    let events = readCommittedMetricEvents().prefix(100)
    guard !events.isEmpty else { return }

    let payload: [String: Any] = [
      "events": events.map { $0.event }
    ]

    guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = body

    let semaphore = DispatchSemaphore(value: 0)
    var statusCode: Int?
    var responseData: Data?
    var retryAfter: String?
    var responseError: Error?
    URLSession.shared.dataTask(with: request) { data, response, error in
      if let http = response as? HTTPURLResponse {
        statusCode = http.statusCode
        retryAfter = http.value(forHTTPHeaderField: "Retry-After")
      }
      responseData = data
      responseError = error
      semaphore.signal()
    }.resume()
    semaphore.wait()

    guard responseError == nil, let status = statusCode else {
      scheduleMetricRetry(retryAfter: retryAfter)
      return
    }

    if (200...299).contains(status) {
      acknowledgedMetricUrls(events: Array(events), data: responseData).forEach {
        try? FileManager.default.removeItem(at: $0)
      }
      resetMetricRetry()
    } else if (400...499).contains(status), status != 408, status != 429 {
      events.forEach { try? FileManager.default.removeItem(at: $0.url) }
      resetMetricRetry()
    } else {
      scheduleMetricRetry(retryAfter: retryAfter)
    }
  }

  private func acknowledgedMetricUrls(
    events: [(url: URL, event: [String: Any])],
    data: Data?
  ) -> [URL] {
    guard let data, !data.isEmpty else {
      return events.map { $0.url }
    }
    guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return events.map { $0.url }
    }
    guard let ids = body["acknowledged_event_ids"] as? [String] else {
      return events.map { $0.url }
    }
    let acknowledgedIds = Set(ids)
    return events
      .filter { acknowledgedIds.contains($0.event["event_id"] as? String ?? "") }
      .map { $0.url }
  }

  private func isMetricFlushDeferred() -> Bool {
    if metricsRetryScheduled,
       let until = metricsBackoffUntil,
       Date() < until {
      return true
    }
    return false
  }

  private func resetMetricRetry() {
    metricsRetryAttempt = 0
    metricsBackoffUntil = nil
  }

  private func scheduleMetricRetry(retryAfter: String?) {
    guard metricsRetryAttempt < 5, !metricsRetryScheduled else { return }

    let retryAfterSeconds = retryAfter.flatMap { TimeInterval($0) }
    let baseDelay = retryAfterSeconds ?? min(60, pow(2, Double(metricsRetryAttempt)))
    let delay = baseDelay * (1 + Double.random(in: 0...0.2))
    metricsRetryAttempt += 1
    metricsRetryScheduled = true
    metricsBackoffUntil = Date().addingTimeInterval(delay)

    codemagicPatchNetworkQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      self.metricsRetryScheduled = false
      self.flushMetricEvents()
    }
  }

  private func readCommittedMetricEvents() -> [(url: URL, event: [String: Any])] {
    let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
    return storage.eventFileURLs().compactMap { url in
      let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      if modified < cutoff {
        try? FileManager.default.removeItem(at: url)
        return nil
      }

      guard let data = try? Data(contentsOf: url),
            let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        try? FileManager.default.removeItem(at: url)
        return nil
      }
      return (url, event)
    }
  }

  private func isBootEligible(_ packageHash: String, binaryVersion: String) -> Bool {
    guard storage.metadataMatchesBinary(packageHash: packageHash, binaryVersion: binaryVersion) else {
      return false
    }
    return resolveBundle(hash: packageHash, binaryVersion: binaryVersion) != nil
  }

  private func nativeBootPackageHash(binaryVersion: String) -> String? {
    guard let packageHash = CodemagicPatch.currentLaunchPackageHash,
          isBootEligible(packageHash, binaryVersion: binaryVersion) else {
      return nil
    }
    return packageHash
  }

  private func resolveBundle(hash: String, binaryVersion: String) -> URL? {
    guard CodemagicPatchStorage.isSafePackageHash(hash),
          storage.metadataMatchesBinary(packageHash: hash, binaryVersion: binaryVersion) else {
      return nil
    }

    let candidate = storage.packageContentsDir(hash).appendingPathComponent("main.jsbundle")
    return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
  }

  private func getOrCreateDeviceId() -> String {
    if let override = e2eConfig("CODEMAGIC_PATCH_E2E_DEVICE_ID_OVERRIDE"), !override.isEmpty {
      return override
    }
    return storage.getOrCreateDeviceId()
  }

  private func config(_ key: String) -> String {
    let envKey: String
    switch key {
    case "CodemagicPatchDeploymentKey": envKey = "CODEMAGIC_PATCH_E2E_DEPLOYMENT_KEY"
    case "CodemagicPatchDownloadBaseUrl": envKey = "CODEMAGIC_PATCH_E2E_DOWNLOAD_BASE_URL"
    case "CodemagicPatchApiUrl": envKey = "CODEMAGIC_PATCH_E2E_API_BASE_URL"
    case "CodemagicPatchBinaryVersion": envKey = "CODEMAGIC_PATCH_E2E_BINARY_VERSION"
    default: envKey = key
    }
    if let e2e = e2eConfig(envKey) { return e2e }
    if key == "CodemagicPatchBinaryVersion" { return binaryVersionOrNil() ?? "" }
    return Bundle.main.object(forInfoDictionaryKey: key) as? String ?? ""
  }

  private func binaryVersionOrNil() -> String? {
    if let e2e = e2eConfig("CODEMAGIC_PATCH_E2E_BINARY_VERSION") {
      return e2e
    }
    guard let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String else {
      return nil
    }
    let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func e2eConfig(_ key: String) -> String? {
    guard e2eOverridesEnabled() else { return nil }
    if let env = ProcessInfo.processInfo.environment[key], !env.isEmpty { return env }
    if let argument = launchArgument(key), !argument.isEmpty { return argument }
    return nil
  }

  private func e2eOverridesEnabled() -> Bool {
    guard Bundle.main.object(forInfoDictionaryKey: "CodemagicPatchE2EOverridesEnabled") as? Bool == true else {
      return false
    }
#if targetEnvironment(simulator)
    return true
#else
    return false
#endif
  }

  private func launchArgument(_ key: String) -> String? {
    let dashed = "-\(key)"
    let args = ProcessInfo.processInfo.arguments
    guard let index = args.firstIndex(of: dashed), index + 1 < args.count else {
      return nil
    }
    return args[index + 1]
  }

  private func emitDownloadProgress(
    packageHash: String,
    artifactType: String,
    totalBytes: Int64,
    receivedBytes: Int64
  ) {
    let body: [String: Any] = [
      "packageHash": packageHash,
      "artifactType": artifactType,
      "totalBytes": max(0, totalBytes),
      "receivedBytes": max(0, receivedBytes)
    ]
    DispatchQueue.main.async { [weak self] in
      self?.bridge?.enqueueJSCall(
        "RCTDeviceEventEmitter",
        method: "emit",
        args: ["CodemagicPatchDownloadProgress", body],
        completion: nil
      )
    }
  }

  // 10s manifest-fetch budget (Spec); applied uniformly to meta, primary, and fallback.
  private func manifestRequest(_ urlString: String) -> URLRequest {
    URLRequest(url: URL(string: urlString)!, timeoutInterval: 10)
  }

  private func get(_ urlString: String) throws -> (status: Int, body: String?) {
    let semaphore = DispatchSemaphore(value: 0)
    var result: (Int, String?) = (500, nil)
    var thrown: Error?
    
    URLSession.shared.dataTask(with: manifestRequest(urlString)) { data, response, error in
      if let error = error { thrown = error }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 500
      result = (status, data.flatMap { String(data: $0, encoding: .utf8) })
      semaphore.signal()
    }.resume()
    semaphore.wait()
    if let thrown = thrown { throw thrown }
    return result
  }

  // Async GET reporting through the group, so meta + candidate can overlap. Mirrors get;
  // a transport error -> .failure, any HTTP status -> .success.
  private func getAsync(
    _ urlString: String,
    into group: DispatchGroup,
    store: @escaping (Result<(status: Int, body: String?), Error>) -> Void
  ) {
    group.enter()
    URLSession.shared.dataTask(with: manifestRequest(urlString)) { data, response, error in
      defer { group.leave() }
      if let error = error {
        store(.failure(error))
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 500
      store(.success((status, data.flatMap { String(data: $0, encoding: .utf8) })))
    }.resume()
  }
}
