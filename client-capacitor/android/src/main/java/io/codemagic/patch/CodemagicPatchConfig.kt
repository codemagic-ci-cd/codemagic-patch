package io.codemagic.patch

import android.content.Context
import android.content.res.Resources
import com.getcapacitor.Logger
import com.getcapacitor.PluginConfig
import org.json.JSONObject

/**
 * Resolved plugin configuration — see specs/adr/0003-configuration-via-capacitor-config.md.
 *
 * `publicKey` is the only optional field (`PROTOCOL.md`'s signature enforcement is
 * itself optional); `deploymentKey`, `apiUrl` and `downloadBaseUrl` are required.
 */
internal data class CodemagicPatchConfig(
    val deploymentKey: String,
    val apiUrl: String,
    val downloadBaseUrl: String,
    val publicKey: String?,
)

/**
 * Thrown when required configuration is missing or blank. Always surfaced as
 * `CodemagicPatchErrorCode.ConfigurationInvalid` at the plugin-method boundary — never
 * silently defaulted, per ADR-0003's "fail fast and loudly" decision.
 */
internal class CodemagicPatchConfigError(
    message: String,
) : Exception(message)

/**
 * Reads `deploymentKey`/`apiUrl`/`downloadBaseUrl`/`publicKey`, preferring a native
 * resource override (`res/values/strings.xml`) over the Capacitor plugin config
 * (`capacitor.config.ts`'s `plugins.CodemagicPatch.android.*`) — the precedence ADR-0003
 * specifies for CI-injected, per-environment secrets that shouldn't require rewriting
 * `capacitor.config.ts`. The resource *names* (`CodemagicPatchDeploymentKey`, etc.) are
 * unprefixed and unchanged from upstream's own native-resource keys (see
 * specs/adr/0003-configuration-via-capacitor-config.md's Context section) — Android's own
 * `strings.xml` is already platform-specific, so no `android.` prefix is needed there;
 * the prefix only matters for the single shared `capacitor.config.ts`, where both
 * platforms' blocks coexist.
 */
internal object CodemagicPatchConfigResolver {
    private const val PLATFORM = "android"

    fun resolve(
        context: Context,
        pluginConfig: PluginConfig,
    ): CodemagicPatchConfig =
        resolve(
            readResource = { name -> readStringResource(context, name) },
            readConfig = { key -> cleanConfigValue(pluginConfig.getString("$PLATFORM.$key")) },
        )

    /**
     * Same precedence logic, decoupled from `Context`/`PluginConfig` so it can be
     * exercised with plain lookup functions — neither Capacitor type is constructible
     * from outside its own package (`PluginConfig`'s constructor is package-private),
     * which would otherwise make this logic untestable without a real Bridge. See
     * `CodemagicPatchConfigResolverTest`.
     */
    fun resolve(
        readResource: (name: String) -> String?,
        readConfig: (key: String) -> String?,
    ): CodemagicPatchConfig =
        CodemagicPatchConfig(
            deploymentKey = requireValue(readResource, readConfig, "CodemagicPatchDeploymentKey", "deploymentKey"),
            apiUrl = requireValue(readResource, readConfig, "CodemagicPatchApiUrl", "apiUrl"),
            downloadBaseUrl = requireValue(readResource, readConfig, "CodemagicPatchDownloadBaseUrl", "downloadBaseUrl"),
            publicKey = optionalValue(readResource, readConfig, "CodemagicPatchPublicKey", "publicKey"),
        )

    private fun requireValue(
        readResource: (String) -> String?,
        readConfig: (String) -> String?,
        resourceName: String,
        configKey: String,
    ): String =
        optionalValue(readResource, readConfig, resourceName, configKey)
            ?: throw CodemagicPatchConfigError(
                "Missing required CodemagicPatch configuration \"$configKey\" — set " +
                    "plugins.CodemagicPatch.$PLATFORM.$configKey in capacitor.config.ts, " +
                    "or the \"$resourceName\" string resource as an override.",
            )

    private fun optionalValue(
        readResource: (String) -> String?,
        readConfig: (String) -> String?,
        resourceName: String,
        configKey: String,
    ): String? {
        readResource(resourceName)?.let { return it }
        return readConfig(configKey)
    }

    /**
     * The crash-rollback launch-attempt budget: the `CodemagicPatchMaxLaunchAttempts`
     * string resource, else `plugins.CodemagicPatch.android.maxLaunchAttempts`, else
     * [CodemagicPatchFailure.DEFAULT_MAX_LAUNCH_ATTEMPTS].
     *
     * Kept apart from [resolve] because boot selection needs it even when the required
     * network config is missing. It never throws: like upstream, a value that is present
     * but not a positive integer up to `Int.MAX_VALUE` logs a warning and falls back to
     * the default, because a typo in app config must not take OTA boot down with it.
     * An invalid higher-precedence value does not fall through to the lower one, since
     * it was set precisely to override it.
     */
    fun resolveMaxLaunchAttempts(
        context: Context,
        pluginConfig: PluginConfig,
    ): Int =
        resolveMaxLaunchAttempts(
            readResource = { name -> readStringResource(context, name) },
            readConfig = { key -> pluginConfig.getObject(PLATFORM)?.opt(key) },
            warn = { message -> Logger.warn("CodemagicPatch", message) },
        )

    /** Same resolution, over plain lookups — see [resolve]'s overload for why. */
    fun resolveMaxLaunchAttempts(
        readResource: (name: String) -> String?,
        readConfig: (key: String) -> Any?,
        warn: (message: String) -> Unit,
    ): Int {
        val default = CodemagicPatchFailure.DEFAULT_MAX_LAUNCH_ATTEMPTS
        val resourceName = CodemagicPatchFailure.MAX_LAUNCH_ATTEMPTS_KEY
        val configKey = "maxLaunchAttempts"
        val resourceValue = readResource(resourceName)
        val (source, raw) =
            if (resourceValue != null) {
                "The \"$resourceName\" string resource" to resourceValue
            } else {
                val configValue =
                    readConfig(configKey)
                        ?.takeUnless { it == JSONObject.NULL }
                        ?.let { if (it is String) cleanConfigValue(it) else it }
                        ?: return default
                "plugins.CodemagicPatch.$PLATFORM.$configKey" to configValue
            }
        parseMaxLaunchAttempts(raw)?.let { return it }
        warn("$source must be a positive integer up to ${Int.MAX_VALUE}, got '$raw'; using $default.")
        return default
    }

    private fun readStringResource(
        context: Context,
        name: String,
    ): String? {
        val id = context.resources.getIdentifier(name, "string", context.packageName)
        if (id == 0) return null
        // A resource declared only under a qualified directory (e.g. values-en) can
        // resolve an id yet have no value for the current configuration — treat it as
        // absent rather than throwing out of load(). Upstream guards the same case.
        val raw =
            try {
                context.getString(id)
            } catch (_: Resources.NotFoundException) {
                return null
            }
        return cleanConfigValue(raw)
    }
}

/**
 * A launch-attempt budget from either source: a whole number in `1..Int.MAX_VALUE`,
 * given as a JSON number or a decimal string. Int32 is the range upstream accepts on both
 * platforms, so the same value behaves the same on iOS. Booleans and fractional numbers
 * are rejected rather than coerced (`true` is not 1, `2.5` is not 2).
 */
internal fun parseMaxLaunchAttempts(raw: Any): Int? {
    val value: Long? =
        when (raw) {
            is Byte, is Short, is Int, is Long -> (raw as Number).toLong()
            is Float, is Double -> (raw as Number).toDouble().takeIf { it % 1.0 == 0.0 && it <= Int.MAX_VALUE }?.toLong()
            is String -> raw.trim().toLongOrNull()
            else -> null
        }
    return value?.takeIf { it in 1..Int.MAX_VALUE.toLong() }?.toInt()
}

/**
 * Trims and treats an all-whitespace value the same as absent. A code-review finding
 * noted iOS already did this for both its config sources (`CodemagicPatchConfig.swift`)
 * while Android only checked `isNotBlank()` and kept the raw, untrimmed value — the
 * exact same CI-injected `deploymentKey` (e.g. one that picked up a trailing newline
 * from a shell heredoc writing `strings.xml`) produced a working manifest URL on iOS
 * and a broken one on Android. A top-level function, not private to the resolver, so a
 * plain JVM unit test can exercise it directly — the resolver's own tests use the
 * closure-based overload above, whose lookup closures already return pre-resolved
 * values and never exercise this normalization at all.
 */
internal fun cleanConfigValue(raw: String?): String? = raw?.trim()?.takeIf { it.isNotEmpty() }
