package io.codemagic.patch

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

internal object CodemagicPatchExecutors {
  val io: ScheduledExecutorService =
      Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "CodemagicPatchIo").apply { isDaemon = true }
      }
  val network: ScheduledExecutorService =
      Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "CodemagicPatchNetwork").apply { isDaemon = true }
      }
  val metricsLock = Any()

  // Shared pooled client for manifest / meta fetches: the ConnectionPool reuses
  // connections (HTTP/2 multiplexing) and callTimeout enforces the 10s manifest budget.
  val httpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .callTimeout(10, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()
  }
}
