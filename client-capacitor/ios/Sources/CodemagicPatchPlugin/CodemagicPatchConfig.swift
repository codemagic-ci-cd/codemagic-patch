import Foundation
import Capacitor

/// Resolved plugin configuration — see
/// specs/adr/0003-configuration-via-capacitor-config.md. `publicKey` is the only
/// optional field (`PROTOCOL.md`'s signature enforcement is itself optional);
/// `deploymentKey`, `apiUrl` and `downloadBaseUrl` are required.
struct CodemagicPatchConfig {
    let deploymentKey: String
    let apiUrl: String
    let downloadBaseUrl: String
    let publicKey: String?
}

/// Thrown when required configuration is missing or blank. Always surfaced as
/// `CodemagicPatchErrorCode.ConfigurationInvalid` at the plugin-method boundary — never
/// silently defaulted, per ADR-0003's "fail fast and loudly" decision.
struct CodemagicPatchConfigError: Error {
    let message: String
}

/// Reads `deploymentKey`/`apiUrl`/`downloadBaseUrl`/`publicKey`, preferring a native
/// resource override (`Info.plist`) over the Capacitor plugin config
/// (`capacitor.config.ts`'s `plugins.CodemagicPatch.ios.*`) — the precedence ADR-0003
/// specifies for CI-injected, per-environment secrets that shouldn't require rewriting
/// `capacitor.config.ts`. The `Info.plist` key *names* (`CodemagicPatchDeploymentKey`,
/// etc.) are unprefixed and unchanged from upstream's own native-resource keys (see
/// specs/adr/0003-configuration-via-capacitor-config.md's Context section) — iOS's own
/// `Info.plist` is already platform-specific, so no `ios.` prefix is needed there; the
/// prefix only matters for the single shared `capacitor.config.ts`, where both
/// platforms' blocks coexist.
enum CodemagicPatchConfigResolver {
    private static let platform = "ios"

    static func resolve(pluginConfig: PluginConfig) throws -> CodemagicPatchConfig {
        try resolve(
            readResource: readInfoPlistString,
            readConfig: { key in
                pluginConfig.getString("\(platform).\(key)")?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .nilIfEmpty
            }
        )
    }

    /// Same precedence logic, decoupled from `PluginConfig` so it can be exercised with
    /// plain lookup closures — `PluginConfig.init(config:)` is internal to the Capacitor
    /// module, so no test target outside it can construct one, which would otherwise
    /// make this logic untestable without a real Bridge. See
    /// `CodemagicPatchConfigResolverTests`.
    static func resolve(
        readResource: (String) -> String?,
        readConfig: (String) -> String?
    ) throws -> CodemagicPatchConfig {
        CodemagicPatchConfig(
            deploymentKey: try requireValue(readResource, readConfig, "CodemagicPatchDeploymentKey", "deploymentKey"),
            apiUrl: try requireValue(readResource, readConfig, "CodemagicPatchApiUrl", "apiUrl"),
            downloadBaseUrl: try requireValue(
                readResource, readConfig, "CodemagicPatchDownloadBaseUrl", "downloadBaseUrl"
            ),
            publicKey: optionalValue(readResource, readConfig, "CodemagicPatchPublicKey", "publicKey")
        )
    }

    private static func requireValue(
        _ readResource: (String) -> String?,
        _ readConfig: (String) -> String?,
        _ infoPlistKey: String,
        _ configKey: String
    ) throws -> String {
        guard let value = optionalValue(readResource, readConfig, infoPlistKey, configKey) else {
            throw CodemagicPatchConfigError(
                message: "Missing required CodemagicPatch configuration \"\(configKey)\" — set " +
                    "plugins.CodemagicPatch.\(platform).\(configKey) in capacitor.config.ts, " +
                    "or the \"\(infoPlistKey)\" Info.plist key as an override."
            )
        }
        return value
    }

    private static func optionalValue(
        _ readResource: (String) -> String?,
        _ readConfig: (String) -> String?,
        _ infoPlistKey: String,
        _ configKey: String
    ) -> String? {
        if let resourceValue = readResource(infoPlistKey) {
            return resourceValue
        }
        return readConfig(configKey)
    }

    /// The crash-rollback launch-attempt budget: the `CodemagicPatchMaxLaunchAttempts`
    /// `Info.plist` key, else `plugins.CodemagicPatch.ios.maxLaunchAttempts`, else
    /// `CodemagicPatchFailure.defaultMaxLaunchAttempts`.
    ///
    /// Kept apart from `resolve` because boot selection needs it even when the required
    /// network config is missing. It never throws: like upstream, a value that is present
    /// but not a positive integer up to `Int32.max` logs a warning and falls back to the
    /// default, because a typo in app config must not take OTA boot down with it. An
    /// invalid higher-precedence value does not fall through to the lower one, since it
    /// was set precisely to override it.
    static func resolveMaxLaunchAttempts(pluginConfig: PluginConfig) -> Int {
        resolveMaxLaunchAttempts(
            readResource: { Bundle.main.object(forInfoDictionaryKey: $0) },
            readConfig: { pluginConfig.getObject(platform)?[$0] },
            warn: { CAPLog.print("⚡️ ⚠️ CodemagicPatch:", $0) }
        )
    }

    /// Same resolution, over plain lookups — see `resolve`'s overload for why.
    static func resolveMaxLaunchAttempts(
        readResource: (String) -> Any?,
        readConfig: (String) -> Any?,
        warn: (String) -> Void
    ) -> Int {
        let fallback = CodemagicPatchFailure.defaultMaxLaunchAttempts
        let key = CodemagicPatchFailure.maxLaunchAttemptsKey
        let source: String
        let raw: Any
        if let resourceValue = present(readResource(key)) {
            source = "The \"\(key)\" Info.plist key"
            raw = resourceValue
        } else if let configValue = present(readConfig("maxLaunchAttempts")) {
            source = "plugins.CodemagicPatch.\(platform).maxLaunchAttempts"
            raw = configValue
        } else {
            return fallback
        }
        if let parsed = parseMaxLaunchAttempts(raw) {
            return parsed
        }
        warn("\(source) must be a positive integer up to \(Int32.max), got '\(raw)'; using \(fallback).")
        return fallback
    }

    /// A launch-attempt budget from either source: a whole number in `1...Int32.max`,
    /// given as a number or a decimal string. Int32 is the range upstream accepts on
    /// both platforms, so the same value behaves the same on Android. Booleans and
    /// fractional numbers are rejected rather than coerced (`true` is not 1, `2.5` is
    /// not 2) — a plist `<true/>` and a JSON `true` both bridge to `NSNumber`.
    static func parseMaxLaunchAttempts(_ raw: Any) -> Int? {
        let value: Double?
        switch raw {
        case let number as NSNumber:
            value = CFGetTypeID(number) == CFBooleanGetTypeID() ? nil : number.doubleValue
        case let text as String:
            value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)).map(Double.init)
        default:
            value = nil
        }
        guard let value, value.rounded() == value, value >= 1, value <= Double(Int32.max) else {
            return nil
        }
        return Int(value)
    }

    /// Treats a missing value, `NSNull` and a blank string as absent.
    private static func present(_ value: Any?) -> Any? {
        switch value {
        case nil, is NSNull:
            return nil
        case let text as String:
            return text.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        default:
            return value
        }
    }

    private static func readInfoPlistString(_ key: String) -> String? {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
