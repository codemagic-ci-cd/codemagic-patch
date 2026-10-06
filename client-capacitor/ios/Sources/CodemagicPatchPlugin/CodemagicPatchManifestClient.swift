// Adapted from codemagic-ci-cd/codemagic-patch@f22294f7c2599b79979b8620e5cb6db4bf3bdf0a
// client/ios/CodemagicPatchModule.swift's fetchManifest() (Apache-2.0) — same URL
// construction, parallel meta.json fetch, and primary/fallback 404 handling. Uses plain
// `URLSession` data tasks (matching upstream), synchronised with a semaphore the same
// way this project's own `CodemagicPatchDownloader`/upstream's synchronous iOS style
// already does — safe because Capacitor's own plugin-call dispatch queue is a
// dedicated background queue, never the main thread (verified against
// `CapacitorBridge.swift`'s `dispatchQueue`, a serial queue distinct from
// `DispatchQueue.main`).
import Foundation

final class CodemagicPatchManifestClient {
    /// Mirrors `ManifestFetchResult` (src/definitions.ts) field-for-field, minus
    /// `context` — the plugin assembles that separately, since it needs boot-selection
    /// state this client has no reason to know about.
    struct Result {
        let status: String
        let source: String
        let manifestJson: String?
        let metaJson: String?
    }

    private struct HttpBody {
        let status: Int
        let body: String?
    }

    private let config: CodemagicPatchConfig
    private let session: URLSession

    init(config: CodemagicPatchConfig, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    /// `PROTOCOL.md` § Manifest Path Rule: try the primary path
    /// (`{deploymentKey}/{binaryVersion}/{runningPackageHash}/manifest.json`) when a
    /// package is currently running; on a 404 there (or when there is no running
    /// package to try a primary path for at all), fall back to
    /// `{deploymentKey}/{binaryVersion}/manifest.json`. `meta.json` is fetched in
    /// parallel and is informational only — any failure there yields `nil` and never
    /// fails or delays this call (`PROTOCOL-CONFORMANCE.md` M5).
    func fetchManifest(binaryVersion: String, runningPackageHash: String?) throws -> Result {
        let base = config.downloadBaseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let deploymentKey = config.deploymentKey
        let fallbackPath = "/\(deploymentKey)/\(binaryVersion)/manifest.json"
        let primaryPath = runningPackageHash.map { "/\(deploymentKey)/\(binaryVersion)/\($0)/manifest.json" }
        let metaUrl = "\(base)/\(deploymentKey)/meta.json"
        let candidateUrl = "\(base)\(primaryPath ?? fallbackPath)"

        var metaResult: HttpBody?
        let metaGroup = DispatchGroup()
        metaGroup.enter()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            metaResult = try? self?.requestSync(metaUrl)
            metaGroup.leave()
        }

        let candidate = try requestSync(candidateUrl)

        let selected: HttpBody
        let source: String
        if primaryPath != nil, candidate.status == 404 {
            selected = try requestSync("\(base)\(fallbackPath)")
            source = "binary-version"
        } else if primaryPath != nil {
            selected = candidate
            source = "running-package"
        } else {
            selected = candidate
            source = "binary-version"
        }

        // Code-review finding (critical): this used to wait up to metaTimeout (10s)
        // *after* the manifest had already resolved, so a stalled meta.json origin
        // delayed every OTA check by up to 10 extra seconds — directly contradicting
        // this method's own doc comment and PROTOCOL-CONFORMANCE.md's M5 row (both
        // already claimed "never fails or delays this call", which the code didn't
        // actually do). meta.json is informational-only and fetched in parallel
        // specifically so a slow origin can never hold up the manifest path — so this
        // now polls with a zero timeout: use metaResult only if it is *already*
        // available the instant the manifest request completes, otherwise fall back to
        // nil immediately, exactly as an outright meta.json failure already does.
        //
        // Reading metaResult is still safe to do unconditionally here: a
        // DispatchGroup's leave() happens-before any wait() that observes the group
        // reach zero (.success), which `.now()` still relies on — the only case that
        // changed is that a *not-yet-arrived* result is now treated identically to a
        // *timed-out* one (both nil), removing the need to reason about the
        // .timedOut-without-happens-before case this comment used to warn about.
        let metaJson = metaGroup.wait(timeout: .now()) == .success && metaResult?.status == 200
            ? metaResult?.body
            : nil

        if selected.status == 404 {
            return Result(status: "not-found", source: "binary-version", manifestJson: nil, metaJson: metaJson)
        }
        guard (200...299).contains(selected.status) else {
            throw CodemagicPatchFailure.httpError(
                status: selected.status,
                message: "manifest fetch failed with HTTP \(selected.status)"
            )
        }
        return Result(status: "ok", source: source, manifestJson: selected.body, metaJson: metaJson)
    }

    private func requestSync(_ urlString: String) throws -> HttpBody {
        guard let url = URL(string: urlString) else {
            throw CodemagicPatchFailure.httpError(status: 0, message: "invalid manifest URL: \(urlString)")
        }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "GET"

        let semaphore = DispatchSemaphore(value: 0)
        var httpBody: HttpBody?
        var requestError: Error?

        session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error = error {
                requestError = error
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 404 {
                httpBody = HttpBody(status: status, body: nil)
                return
            }
            if !(200...299).contains(status) {
                requestError = CodemagicPatchFailure.httpError(
                    status: status,
                    message: CodemagicPatchFailure.storageErrorMessage(CodemagicPatchFailure.readErrorBody(data: data))
                )
                return
            }
            httpBody = HttpBody(status: status, body: data.flatMap { String(data: $0, encoding: .utf8) })
        }.resume()

        semaphore.wait()
        if let requestError = requestError {
            throw requestError
        }
        guard let httpBody = httpBody else {
            throw CodemagicPatchFailure.httpError(status: 0, message: "no response for \(urlString)")
        }
        return httpBody
    }
}
