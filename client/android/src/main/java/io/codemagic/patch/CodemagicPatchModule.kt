package io.codemagic.patch

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.math.pow

class CodemagicPatchModule(private val reactContext: ReactApplicationContext) :
    NativeCodemagicPatchSpec(reactContext), LifecycleEventListener {
  private companion object {
    const val TAG = "CodemagicPatchModule"
  }

  private val storage = CodemagicPatchStorage(reactContext)
  private val downloader = CodemagicPatchDownloader(storage)
  private val installer = CodemagicPatchPackageInstaller(storage)
  private val metricsRetryLock = Any()
  private var metricsRetryAttempt = 0
  private var metricsRetryScheduled = false
  private var metricsBackoffUntilMs = 0L

  init {
    reactContext.addLifecycleEventListener(this)
    CodemagicPatchExecutors.network.execute { flushMetricEvents() }
  }

  @ReactMethod
  override fun getBootState(promise: Promise) {
    runOnIo(promise) { createBootStateMap() }
  }

  @ReactMethod
  override fun fetchManifest(promise: Promise) {
    runOnNetwork(promise, "NETWORK_ERROR") {
      // Capture boot/config context on the io executor so it cannot interleave
      // with lifecycle mutations (Spec §Thread Safety). Only the subsequent
      // network I/O runs on this network executor.
      val captured = captureOnIo {
        val binaryVersion = binaryVersionOrNull()
        Pair(binaryVersion, manifestContext(binaryVersion))
      }
      val binaryVersion = captured.first
      val context = captured.second
      if (binaryVersion == null) {
        return@runOnNetwork Arguments.createMap().apply {
          putString("status", "not-found")
          putString("source", "binary-version")
          putNull("manifestJson")
          putNull("metaJson")
          putMap("context", context)
        }
      }

      val downloadBaseUrl = config("CodemagicPatchDownloadBaseUrl").trimEnd('/')
      val deploymentKey = context.getString("deploymentKey")!!
      val runningHash = context.getString("runningPackageHash")
      val primaryPath =
          if (runningHash != null) "/$deploymentKey/$binaryVersion/$runningHash/manifest.json"
          else null
      val fallbackPath = "/$deploymentKey/$binaryVersion/manifest.json"

      val metaUrl = "$downloadBaseUrl/$deploymentKey/meta.json"
      // Candidate = running package's hash-specific manifest, else the binary-version one.
      val candidateUrl = "$downloadBaseUrl${primaryPath ?: fallbackPath}"

      // Fetch meta + candidate concurrently on OkHttp's dispatcher threads; the network
      // executor only blocks on the join below (never re-submits to itself), so no deadlock.
      // meta is fire-and-forget: handle() folds it to a 200-only body (else null) and
      // absorbs any failure, so only a candidate failure propagates out of allOf.
      val metaFuture =
          getAsync(metaUrl).handle { result, _ -> result?.takeIf { it.status == 200 }?.body }
      val candidateFuture = getAsync(candidateUrl)
      // callTimeout(10s) bounds each call; this 12s join is just a safety net.
      try {
        CompletableFuture.allOf(metaFuture, candidateFuture).get(12, TimeUnit.SECONDS)
      } catch (e: ExecutionException) {
        throw e.cause ?: e
      }

      val metaJson = metaFuture.getNow(null)
      val candidate = candidateFuture.getNow(null) ?: error("manifest request did not complete")


      val response =
          if (primaryPath != null && candidate.status == 404)
              getWithStatus("$downloadBaseUrl$fallbackPath") to "binary-version"
          else if (primaryPath != null) candidate to "running-package"
          else candidate to "binary-version"

      val body = response.first
      val map = Arguments.createMap()
      map.putString("source", response.second)
      map.putMap("context", context)
      map.putString("metaJson", metaJson)
      if (body.status == 404) {
        map.putString("status", "not-found")
        map.putNull("manifestJson")
      } else {
        map.putString("status", "ok")
        map.putString("manifestJson", body.body)
      }
      map
    }
  }

  @ReactMethod
  override fun getDeviceId(promise: Promise) {
    runOnIo(promise) { getDeviceId() }
  }

  @ReactMethod
  override fun getPackageMetadata(packageHash: String, promise: Promise) {
    runOnIo(promise) {
      if (!storage.isSafePackageHash(packageHash)) {
        null
      } else {
        val metadata = storage.packageMetadata(packageHash)
        if (metadata?.optString("package_hash") == packageHash) metadata.toWritableMap() else null
      }
    }
  }

  @ReactMethod
  override fun enqueueMetricEvent(eventJson: String, promise: Promise) {
    runOnIo(promise) {
      commitMetricEvent(eventJson)
      null
    }
  }

  @ReactMethod
  override fun downloadUpdate(request: ReadableMap, promise: Promise) {
    runOnNetwork(promise, "NETWORK_ERROR") {
      val hash = request.getString("packageHash") ?: error("packageHash is required")
      require(storage.isSafePackageHash(hash)) { "unsafe packageHash" }
      val artifactType = request.getString("artifactType") ?: error("artifactType is required")
      require(artifactType == "patch" || artifactType == "full_bundle") { "invalid artifactType" }
      val binaryVersion = binaryVersionOrNull() ?: error("binary version unavailable")
      val url = request.getString("url") ?: error("url is required")
      val runningHash = nativeBootPackageHash(binaryVersion)
      val req = CodemagicPatchDownloader.Request(
        packageHash = hash,
        artifactType = artifactType,
        url = url,
        expectedBytes = if (request.hasKey("expectedBytes") && !request.isNull("expectedBytes")) {
          request.getDouble("expectedBytes").toLong()
        } else {
          null
        },
        metadata = request.getMap("metadata")?.toHashMap() ?: emptyMap(),
        patchBaseHash = runningHash,
      )
      val totalForProgress = req.expectedBytes?.takeIf { it > 0 } ?: 0L
      downloader.download(req) { receivedBytes ->
        emitDownloadProgress(hash, artifactType, totalForProgress, receivedBytes)
      }
      null
    }
  }

  @ReactMethod
  override fun installUpdate(request: ReadableMap, promise: Promise) {
    runOnIo(promise) {
      val hash = request.getString("packageHash") ?: error("packageHash is required")
      val binaryVersion = binaryVersionOrNull() ?: error("binary version unavailable")
      installer.install(
        CodemagicPatchPackageInstaller.InstallContext(
          packageHash = hash,
          binaryVersion = binaryVersion,
          deploymentKey = config("CodemagicPatchDeploymentKey"),
          runningPackageHash = nativeBootPackageHash(binaryVersion),
        )
      )
      null
    }
  }

  @ReactMethod
  override fun confirmPendingUpdate(promise: Promise) {
    runOnIo(promise) {
      installer.confirmPending()
      null
    }
  }

  @ReactMethod
  override fun stageEmbeddedRevert(promise: Promise) {
    runOnIo(promise) {
      installer.stageEmbeddedRevert()
      null
    }
  }

  @ReactMethod
  override fun clearUpdatesForTests(promise: Promise) {
    runOnIo(promise) {
      installer.clearForTests()
      null
    }
  }

  @ReactMethod
  override fun reloadBundle(promise: Promise) {
    val application = reactContext.applicationContext as? ReactApplication
    if (application == null) {
      promise.reject("INTEGRITY_ERROR", "Host application does not implement ReactApplication")
      return
    }

    reactContext.runOnUiQueueThread {
      // `ReactApplication.reactNativeHost` is deprecated in the New Architecture
      // and its default getter throws on hosts that only expose `reactHost`
      // (the RN 0.82+ default template `reactHost by lazy { getDefaultReactHost(...) }`).
      // Probe it defensively so a reactHost-only host does not crash the reload.
      val legacyHost: ReactNativeHost? =
          try {
            application.reactNativeHost
          } catch (_: Throwable) {
            null
          }
      val reactHost = application.reactHost

      // New-arch reactHost-only host (e.g. RN 0.82+ default `reactHost by lazy {
      // getDefaultReactHost(...) }`). The ReactHost is cached on the Application
      // with a `JSBundleLoader` fixed at construction, and ReactHost exposes no
      // public way to swap it, so neither `activity.recreate()` nor
      // `reactHost.reload()` alone can boot a freshly installed bundle. Replace
      // the cached host's loader in place (via RN internals) and reload.
      if (legacyHost == null) {
        if (reactHost == null) {
          promise.reject("INTEGRITY_ERROR", "Host application does not expose a ReactHost")
          return@runOnUiQueueThread
        }
        promise.resolve(null)
        reloadReactHostInProcess(reactHost)
        return@runOnUiQueueThread
      }

      // Legacy/bridge or hybrid host (RN <= 0.81, both architectures). The host
      // rebuilds its ReactHost from `ReactNativeHost.getJSBundleFile()` once the
      // cached instances are dropped, so an in-process activity recreate suffices.
      if (!legacyHost.hasInstance() && reactHost == null) {
        promise.reject("INTEGRITY_ERROR", "Host application does not expose a ReactHost")
        return@runOnUiQueueThread
      }

      // Expo wraps the host in `expo.modules.ReactNativeHostWrapper` and caches its
      // ReactHost there — not in RN's `DefaultReactHost` singleton. On a new-arch
      // Expo host (running on the ReactHost, so the legacy bridge has no instance),
      // `resetDefaultReactHostSingleton()` + `activity.recreate()` would rebuild from
      // the wrapper's stale cache and boot the pre-install bundle. Swap the live
      // ReactHost's bundle loader in place instead, like the RN 0.82+ reactHost path.
      if (reactHost != null && !legacyHost.hasInstance() && isWrappedReactNativeHost(legacyHost)) {
        promise.resolve(null)
        reloadReactHostInProcess(reactHost)
        return@runOnUiQueueThread
      }

      val activity = reactContext.currentActivity
      if (activity != null) {
        // Recreate the foreground activity so a fresh React instance is
        // built against the new disk state. Two caches must be dropped
        // independently:
        //   • DefaultReactHost.reactHost (new architecture singleton) is
        //     reset via reflection so the next `getDefaultReactHost()` call
        //     builds a fresh ReactHost from `ReactNativeHost.getJSBundleFile()`.
        //   • ReactNativeHost.reactInstanceManager (legacy/paper architecture)
        //     is dropped via `host.clear()` — `ReactInstanceManager` captures
        //     its `JSBundleLoader` once at construction, so the next
        //     `reactInstanceManager` access must build a fresh one. Apps
        //     that ship both surfaces (e.g. `DefaultReactNativeHost` that
        //     overrides `getReactHost()` and falls back to ReactInstanceManager
        //     under `newArchEnabled=false`) need both resets so neither
        //     stale cache wins on `activity.recreate()`.
        resetDefaultReactHostSingleton()
        if (legacyHost.hasInstance()) {
          legacyHost.clear()
        }
        promise.resolve(null)
        activity.recreate()
        return@runOnUiQueueThread
      }

      // No foreground activity. Fall back to whichever surface the host
      // exposes, then clear the cached state so the next cold launch picks
      // up the new bundle.
      if (reactHost != null) {
        promise.resolve(null)
        reactHost.reload("CodemagicPatch reload")
        return@runOnUiQueueThread
      }
      if (legacyHost.hasInstance()) {
        legacyHost.clear()
      }
      promise.resolve(null)
    }
  }

  /** True when `host` is Expo's `expo.modules.ReactNativeHostWrapper` (or any host wrapper under `expo.modules`). */
  private fun isWrappedReactNativeHost(host: ReactNativeHost): Boolean =
      host.javaClass.name.startsWith("expo.modules.")

  /**
   * Reload a host that runs on a [ReactHost] (RN 0.82+ `reactHost by lazy { ... }`,
   * or a new-arch Expo host) so it boots the freshly selected CodemagicPatch bundle.
   *
   * Two delegate shapes need different handling, both covered by
   * [swapReactHostBundleLoader] (which replaces the loader via `@UnstableReactNativeAPI`
   * internals before `reload()`):
   *  • Bare RN (`DefaultReactHostDelegate`): `jsBundleLoader` is a constructor `val`
   *    fixed at host construction, so `reload()` alone reuses the old bundle; the swap
   *    replaces the `jsBundleLoader` field.
   *  • Expo (`ExpoReactHostFactory$ExpoReactHostDelegate`): `jsBundleLoader` is a
   *    getter-only computed `val` whose settable backing field is `_jsBundleLoader`
   *    (Expo keeps it so DevLauncher can replace the loader; the getter returns it when
   *    non-null). Expo SDK <= 54 re-derived the loader from `getJSBundleFile()` on every
   *    access, so a plain `reload()` sufficed; Expo SDK 55 captures `jsBundleFilePath` at
   *    host construction and no longer re-reads it, so the freshly installed bundle must
   *    be injected via `_jsBundleLoader`.
   * The swap is best-effort; if neither field is present the `reload()` below still
   * carries any host whose loader is recomputed dynamically.
   */
  private fun reloadReactHostInProcess(reactHost: ReactHost) {
    try {
      val bundlePath = CodemagicPatch.getJSBundleFile(reactContext.applicationContext)
      if (bundlePath != null) {
        val swapped = swapReactHostBundleLoader(reactHost, JSBundleLoader.createFileLoader(bundlePath))
        Log.i(
            TAG,
            "reloadBundle: in-place bundle-loader swap ${if (swapped) "succeeded" else "failed"} for ${reactHost.javaClass.name}",
        )
      }
      reactHost.reload("CodemagicPatch reload")
      Log.i(TAG, "reloadBundle: reloaded ReactHost in place")
    } catch (e: Throwable) {
      Log.w(TAG, "reloadBundle: in-place ReactHost reload failed", e)
    }
  }

  /**
   * Replace the [JSBundleLoader] a [ReactHost] holds (directly or via its
   * `reactHostDelegate`) so the subsequent `reload()` boots the freshly installed
   * bundle. Returns true when a loader field was located and replaced.
   */
  private fun swapReactHostBundleLoader(reactHost: Any, loader: JSBundleLoader): Boolean {
    // `ReactHostImpl` holds its `ReactHostDelegate` in a field RN renamed when it
    // ported the class from Java to Kotlin (confirmed from RN source):
    //   • RN <= 0.76 (ReactHostImpl.java):  `mReactHostDelegate`
    //   • RN >= 0.82 (ReactHostImpl.kt):    `reactHostDelegate`
    // The delegate exposes the loader under a field name that differs by host:
    //   • Bare RN `DefaultReactHostDelegate`: `override val jsBundleLoader` is a real
    //     backing field (same name on 0.76 / 0.82 / 0.85) — setting it is sufficient.
    //   • Expo `ExpoReactHostFactory$ExpoReactHostDelegate`: `jsBundleLoader` is a
    //     getter-only computed `val`; its settable backing field is `_jsBundleLoader`,
    //     which the getter returns when non-null (Expo SDK 55 no longer re-derives the
    //     loader from getJSBundleFile() per access, so this injection is required).
    // Each host carries only one of these fields; try both and succeed if either is set.
    val delegate =
        readFieldWalkingHierarchy(reactHost, "reactHostDelegate")
            ?: readFieldWalkingHierarchy(reactHost, "mReactHostDelegate")
    if (delegate == null) {
      Log.w(TAG, "reloadBundle: ReactHostDelegate field not found on ${reactHost.javaClass.name}")
      return false
    }
    val setPublic = setFieldWalkingHierarchy(delegate, "jsBundleLoader", loader)
    val setExpoBacking = setFieldWalkingHierarchy(delegate, "_jsBundleLoader", loader)
    return setPublic || setExpoBacking
  }

  private fun readFieldWalkingHierarchy(target: Any, name: String): Any? {
    var cls: Class<*>? = target.javaClass
    while (cls != null) {
      try {
        val field = cls.getDeclaredField(name)
        field.isAccessible = true
        return field.get(target)
      } catch (_: NoSuchFieldException) {
        cls = cls.superclass
      } catch (_: Throwable) {
        return null
      }
    }
    return null
  }

  private fun setFieldWalkingHierarchy(target: Any, name: String, value: Any?): Boolean {
    var cls: Class<*>? = target.javaClass
    while (cls != null) {
      try {
        val field = cls.getDeclaredField(name)
        field.isAccessible = true
        field.set(target, value)
        return true
      } catch (_: NoSuchFieldException) {
        cls = cls.superclass
      } catch (e: Throwable) {
        Log.w(TAG, "reloadBundle: failed to set ${target.javaClass.name}.$name", e)
        return false
      }
    }
    Log.w(TAG, "reloadBundle: field $name not found on ${target.javaClass.name}")
    return false
  }

  @ReactMethod
  override fun verifyJwtSignature(request: ReadableMap, promise: Promise) {
    runOnIo(promise) {
      CodemagicPatchUtil.verifyJwtSignature(
        jwt = request.getString("jwt") ?: "",
        expectedHash = request.getString("contentHash") ?: "",
        publicKeyPem = config("CodemagicPatchPublicKey"),
      )
    }
  }

  override fun onHostResume() {
    CodemagicPatchExecutors.network.execute { flushMetricEvents() }
  }

  override fun onHostPause() = Unit

  override fun onHostDestroy() = Unit

  override fun onCatalystInstanceDestroy() {
    reactContext.removeLifecycleEventListener(this)
    super.onCatalystInstanceDestroy()
  }

  private fun runOnIo(
    promise: Promise,
    rejectCode: String = "INTEGRITY_ERROR",
    work: () -> Any?
  ) {
    CodemagicPatchExecutors.io.execute {
      try {
        promise.resolve(work())
      } catch (error: Exception) {
        promise.reject(rejectCode, error.message, error)
      }
    }
  }

  private fun runOnNetwork(
    promise: Promise,
    rejectCode: String = "INTEGRITY_ERROR",
    work: () -> Any?
  ) {
    CodemagicPatchExecutors.network.execute {
      try {
        promise.resolve(work())
      } catch (error: Exception) {
        promise.reject(rejectCode, error.message, error)
      }
    }
  }

  /**
   * Runs [work] on the serial io executor and blocks the caller until it
   * completes, so storage/boot-state reads stay serialized with all other io
   * work (Spec §Thread Safety) even when invoked from the network executor.
   */
  private fun <T> captureOnIo(work: () -> T): T =
    try {
      CodemagicPatchExecutors.io.submit(Callable { work() }).get()
    } catch (error: ExecutionException) {
      throw error.cause ?: error
    }

  private fun commitMetricEvent(eventJson: String) {
    try {
      synchronized(CodemagicPatchExecutors.metricsLock) {
        val event = JSONObject(eventJson)
        val eventId = event.optString("event_id", System.nanoTime().toString())
        require(isSafeEventId(eventId)) { "unsafe metric event_id" }
        storage.writeJson("events/$eventId.json", event)
        applyMetricMetadataSideEffect(event)
        storage.enforceEventQueueCap()
      }
    } catch (_: Exception) {}
  }

  private fun isSafeEventId(eventId: String): Boolean =
      eventId.isNotBlank() &&
          !eventId.contains("..") &&
          Regex("^[A-Za-z0-9._-]+$").matches(eventId)

  private fun createBootStateMap(): WritableMap {
    prepareBootState()
    val binaryVersion = binaryVersionOrNull()
    if (binaryVersion == null) {
      return Arguments.createMap().apply {
        putString("bootSource", "embedded")
        putNull("runningPackageHash")
        putNull("confirmedPackageHash")
        putNull("pendingPackageHash")
        putNull("previousPackageHash")
        putNull("failedInstall")
      }
    }

    val state = storage.readState()
    val failed = state.failedInstall?.packageHash
    val pending = state.pending?.packageHash
      ?.takeIf { it != failed && isPackageBootEligible(it, binaryVersion) }
    val current = state.current?.packageHash
      ?.takeIf { isPackageBootEligible(it, binaryVersion) }
    val running = nativeBootPackageHash()
    val source = when {
      running != null && running == pending -> "pending"
      running != null && running == current -> "current"
      else -> "embedded"
    }
    return Arguments.createMap().apply {
      putString("bootSource", source)
      putString("runningPackageHash", running)
      putString("confirmedPackageHash", current)
      putString("pendingPackageHash", pending)
      putString("previousPackageHash", state.previous?.packageHash)
      putMap("failedInstall", state.failedInstall?.toFailedInstallMap())
    }
  }

  private fun prepareBootState() {
    if (CodemagicPatch.hasCompletedLaunchSelection()) {
      return
    }

    val binaryVersion = binaryVersionOrNull() ?: return
    val state = storage.readState()
    val hasInvalidBinary = state.packageHashes
      .any { hash -> !storage.metadataMatchesBinary(hash, binaryVersion) }

    if (hasInvalidBinary) {
      storage.writeState(CodemagicPatchState())
      return
    }

    val pending = state.pending?.packageHash
    val pendingStarted = state.pendingStarted
    if (pendingStarted != null && pendingStarted != pending) {
      storage.mutateState { it.pendingStarted = null }
      return
    }
    if (pending != null && pendingStarted != null) {
      val failedAt = CodemagicPatchUtil.currentIsoTimestamp()
      storage.mutateState {
        it.failedInstall = CodemagicPatchFailedInstall(
          packageHash = pending,
          reason = "crash_rollback",
          failedAt = failedAt
        )
        it.pending = null
        it.pendingStarted = null
      }
      enqueueCrashRollbackMetric(pending, failedAt)
    }
  }

  private fun enqueueCrashRollbackMetric(packageHash: String, emittedAt: String) {
    try {
      val binaryVersion = binaryVersionOrNull() ?: return
      synchronized(CodemagicPatchExecutors.metricsLock) {
        val deviceId = getDeviceId()
        val event = JSONObject()
          .put("event_id", CodemagicPatchUtil.crashRollbackEventId(deviceId, packageHash, emittedAt))
          .put("event_name", "Failed")
          .put("emitted_at", emittedAt)
          .put("device_id", deviceId)
          .put("deployment_key", config("CodemagicPatchDeploymentKey"))
          .put("binary_version", binaryVersion)
          .put("running_package_hash", JSONObject.NULL)
          .put("target_package_hash", packageHash)
          .put("platform", "android")
          .put("sdk_version", "0.0.0")
          .put("attributes", JSONObject()
            .put("reason", "install_fail")
            .put("failure_subtype", "crash_rollback"))
        storage.writeJson("events/${event.getString("event_id")}.json", event)
        storage.enforceEventQueueCap()
      }
    } catch (_: Exception) {}
  }

  private fun flushMetricEvents() {
    synchronized(CodemagicPatchExecutors.metricsLock) {
      flushMetricEventsLocked()
    }
  }

  private fun flushMetricEventsLocked() {
    if (isMetricFlushDeferred()) return

    val apiUrl = config("CodemagicPatchApiUrl").trimEnd('/')
    if (apiUrl.isBlank()) return

    val events = readCommittedMetricEvents().take(100)
    if (events.isEmpty()) return

    val body = JSONObject()
      .put("events", org.json.JSONArray(events.map { it.second }))
      .toString()

    val connection = (URL("$apiUrl/v1/metrics/events").openConnection() as HttpURLConnection)
    connection.connectTimeout = 10_000
    connection.readTimeout = 10_000
    connection.requestMethod = "POST"
    connection.doOutput = true
    connection.setRequestProperty("content-type", "application/json")

    try {
      connection.outputStream.use { output ->
        output.write(body.toByteArray(Charsets.UTF_8))
      }

      val status = connection.responseCode
      val responseText = responseBody(connection)
      when {
        status in 200..299 -> {
          acknowledgedMetricFiles(events, responseText).forEach {
            storage.delete("events/${it.name}")
          }
          resetMetricRetry()
        }
        status in 400..499 && status != 408 && status != 429 -> {
          events.forEach { storage.delete("events/${it.first.name}") }
          resetMetricRetry()
        }
        else -> scheduleMetricRetry(connection.getHeaderField("Retry-After"))
      }
    } catch (_: Exception) {
      // Metrics delivery is best-effort; committed WAL entries stay queued.
      scheduleMetricRetry(null)
    } finally {
      connection.disconnect()
    }
  }

  private fun responseBody(connection: HttpURLConnection): String {
    val stream = runCatching { connection.inputStream }.getOrElse {
      runCatching { connection.errorStream }.getOrNull()
    } ?: return ""
    return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
  }

  private fun acknowledgedMetricFiles(
    events: List<Pair<File, JSONObject>>,
    responseText: String
  ): List<File> {
    if (responseText.isBlank()) return events.map { it.first }
    val body = runCatching { JSONObject(responseText) }.getOrNull()
      ?: return events.map { it.first }
    val array = body.optJSONArray("acknowledged_event_ids")
      ?: return events.map { it.first }
    val acknowledgedIds = buildSet {
      for (index in 0 until array.length()) {
        array.optString(index).takeIf { it.isNotBlank() }?.let(::add)
      }
    }
    return events
      .filter { acknowledgedIds.contains(it.second.optString("event_id")) }
      .map { it.first }
  }

  private fun isMetricFlushDeferred(): Boolean =
      synchronized(metricsRetryLock) {
        metricsRetryScheduled && System.currentTimeMillis() < metricsBackoffUntilMs
      }

  private fun resetMetricRetry() {
    synchronized(metricsRetryLock) {
      metricsRetryAttempt = 0
      metricsBackoffUntilMs = 0L
    }
  }

  private fun scheduleMetricRetry(retryAfterHeader: String?) {
    val delayMs = synchronized(metricsRetryLock) {
      if (metricsRetryAttempt >= 5 || metricsRetryScheduled) return
      val retryAfterMs = retryAfterHeader?.toLongOrNull()?.let { it * 1000L }
      val baseMs = retryAfterMs ?: min(
        60_000.0,
        1000.0 * 2.0.pow(metricsRetryAttempt.toDouble())
      ).toLong()
      val jitteredMs = (baseMs * (1.0 + Math.random() * 0.2)).toLong()
      metricsRetryAttempt += 1
      metricsRetryScheduled = true
      metricsBackoffUntilMs = System.currentTimeMillis() + jitteredMs
      jitteredMs
    }

    CodemagicPatchExecutors.network.schedule({
      synchronized(metricsRetryLock) {
        metricsRetryScheduled = false
      }
      flushMetricEvents()
    }, delayMs, TimeUnit.MILLISECONDS)
  }

  private fun readCommittedMetricEvents(): List<Pair<File, JSONObject>> {
    val cutoffMs = System.currentTimeMillis() - 7L * 24L * 60L * 60L * 1000L
    return storage.listFiles("events")
      .filter { it.name.endsWith(".json") }
      .sortedBy { it.lastModified() }
      .mapNotNull { file ->
        try {
          if (file.lastModified() < cutoffMs) {
            file.delete()
            null
          } else {
            file to JSONObject(file.readText(Charsets.UTF_8))
          }
        } catch (_: Exception) {
          file.delete()
          null
        }
      }
  }

  private fun applyMetricMetadataSideEffect(event: JSONObject) {
    val eventName = event.optString("event_name")
    if (eventName != "Active" && eventName != "Success") return

    val packageHash = event.optString("target_package_hash")
    if (!storage.isSafePackageHash(packageHash)) return

    val metadata = storage.packageMetadata(packageHash) ?: return
    val emittedAt = event.optString("emitted_at", CodemagicPatchUtil.currentIsoTimestamp())
    if (eventName == "Active") {
      metadata.put("last_active_reported_at", emittedAt)
    } else {
      metadata.put("success_reported_at", emittedAt)
    }
    storage.writeJson("packages/$packageHash/update.json", metadata)
  }

  private fun manifestContext(binaryVersion: String? = binaryVersionOrNull()): WritableMap =
      Arguments.createMap().apply {
        putString("deploymentKey", config("CodemagicPatchDeploymentKey"))
        if (binaryVersion == null) putNull("binaryVersion") else putString("binaryVersion", binaryVersion)
        putString(
          "runningPackageHash",
          if (binaryVersion == null) null else nativeBootPackageHash(binaryVersion)
        )
        putString("deviceId", getDeviceId())
        putBoolean("publicKeyConfigured", config("CodemagicPatchPublicKey").isNotBlank())
      }

  private fun config(key: String): String {
    val e2e = e2eLaunchArg(e2eKeyFor(key))
    if (!e2e.isNullOrBlank()) return e2e
    if (key == "CodemagicPatchBinaryVersion") return binaryVersionOrNull() ?: ""
    val id = reactContext.resources.getIdentifier(key, "string", reactContext.packageName)
    return if (id == 0) "" else reactContext.getString(id)
  }

  private fun binaryVersionOrNull(): String? {
    e2eConfig("CodemagicPatchBinaryVersion")?.let { return it }
    return try {
      val info = reactContext.packageManager.getPackageInfo(reactContext.packageName, 0)
      info.versionName?.trim()?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
      null
    }
  }

  private fun nativeBootPackageHash(binaryVersion: String? = binaryVersionOrNull()): String? {
    val version = binaryVersion ?: return null
    return CodemagicPatch.currentLaunchPackageHash()
      ?.takeIf { isPackageBootEligible(it, version) }
  }

  private fun emitDownloadProgress(
      packageHash: String,
      artifactType: String,
      totalBytes: Long,
      receivedBytes: Long
  ) {
    val event = Arguments.createMap()
    event.putString("packageHash", packageHash)
    event.putString("artifactType", artifactType)
    event.putDouble("totalBytes", totalBytes.coerceAtLeast(0).toDouble())
    event.putDouble("receivedBytes", receivedBytes.coerceAtLeast(0).toDouble())
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("CodemagicPatchDownloadProgress", event)
  }

  private fun isPackageBootEligible(packageHash: String, binaryVersion: String): Boolean {
    if (!storage.metadataMatchesBinary(packageHash, binaryVersion)) return false
    return File(storage.packageContentsDir(packageHash), "index.android.bundle").isFile
  }

  private fun e2eKeyFor(key: String): String =
      when (key) {
        "CodemagicPatchDeploymentKey" -> "CODEMAGIC_PATCH_E2E_DEPLOYMENT_KEY"
        "CodemagicPatchDownloadBaseUrl" -> "CODEMAGIC_PATCH_E2E_DOWNLOAD_BASE_URL"
        "CodemagicPatchApiUrl" -> "CODEMAGIC_PATCH_E2E_API_BASE_URL"
        "CodemagicPatchBinaryVersion" -> "CODEMAGIC_PATCH_E2E_BINARY_VERSION"
        else -> key
      }

  private fun e2eConfig(key: String): String? =
      e2eLaunchArg(e2eKeyFor(key))?.takeIf { it.isNotBlank() }

  private fun getDeviceId(): String {
    val override = e2eLaunchArg("CODEMAGIC_PATCH_E2E_DEVICE_ID_OVERRIDE")
    if (!override.isNullOrBlank()) return override
    return storage.getDeviceId()
  }

  private fun e2eLaunchArg(key: String): String? {
    if (!e2eOverridesEnabled()) return null
    return currentActivity?.intent?.extras?.getString(key)
  }

  private fun e2eOverridesEnabled(): Boolean {
    return try {
      val packageManager = reactContext.packageManager
      val appInfo =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getApplicationInfo(
                reactContext.packageName,
                PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()))
          } else {
            @Suppress("DEPRECATION")
            packageManager.getApplicationInfo(reactContext.packageName, PackageManager.GET_META_DATA)
          }
      val debuggable = appInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
      debuggable &&
          appInfo.metaData?.getBoolean("io.codemagic.patch.E2E_OVERRIDES_ENABLED", false) == true
    } catch (_: Exception) {
      false
    }
  }

  private fun resetDefaultReactHostSingleton(): Boolean {
    return try {
      val defaultReactHost = Class.forName("com.facebook.react.defaults.DefaultReactHost")
      val field = defaultReactHost.getDeclaredField("reactHost")
      field.isAccessible = true
      field.set(null, null)
      true
    } catch (_: Throwable) {
      false
    }
  }

  private data class HttpBody(val status: Int, val body: String?)

  // Synchronous GET on the pooled client: 200..299 -> body, 404 -> null, else throws.
  private fun getWithStatus(url: String): HttpBody {
    val request = Request.Builder().url(url).get().build()
    CodemagicPatchExecutors.httpClient.newCall(request).execute().use { response ->
      val status = response.code
      return when {
        status == 404 -> HttpBody(404, null)
        status in 200..299 -> HttpBody(status, response.body?.string())
        else -> error("HTTP $status")
      }
    }
  }

  // Async GET on a dispatcher thread, returning a future for the concurrent meta +
  // candidate fetch. Same status mapping as getWithStatus; non-2xx (except 404)
  // completes the future exceptionally.
  private fun getAsync(url: String): CompletableFuture<HttpBody> {
    val future = CompletableFuture<HttpBody>()
    val request = Request.Builder().url(url).get().build()
    CodemagicPatchExecutors.httpClient.newCall(request).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        future.completeExceptionally(e)
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          try {
            val status = it.code
            future.complete(
                when {
                  status == 404 -> HttpBody(404, null)
                  status in 200..299 -> HttpBody(status, it.body?.string())
                  else -> error("HTTP $status")
                })
          } catch (e: Throwable) {
            future.completeExceptionally(e)
          }
        }
      }
    })
    return future
  }
}

private fun JSONObject.toWritableMap(): WritableMap =
    Arguments.createMap().also { map ->
      keys().forEach { key ->
        when (val value = get(key)) {
          JSONObject.NULL -> map.putNull(key)
          is Boolean -> map.putBoolean(key, value)
          is Int -> map.putInt(key, value)
          is Number -> map.putDouble(key, value.toDouble())
          else -> map.putString(key, value.toString())
        }
      }
    }

private fun CodemagicPatchFailedInstall.toFailedInstallMap(): WritableMap =
    Arguments.createMap().apply {
      putString("packageHash", packageHash)
      putString("reason", reason)
      putString("failedAt", failedAt)
    }
