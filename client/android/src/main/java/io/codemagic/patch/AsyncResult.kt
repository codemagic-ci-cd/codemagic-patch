package io.codemagic.patch

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

// Minimal latch-backed single-completion future.
// java.util.concurrent.CompletableFuture is an API 24+ class, but the SDK supports
// minSdk 23 hosts (RN 0.73–0.75) and library desugaring does not cover it, so it
// must not be used anywhere in this SDK; use this instead.
internal class AsyncResult<T : Any> {
  private val latch = CountDownLatch(1)
  @Volatile private var value: T? = null
  @Volatile private var error: Throwable? = null

  fun complete(result: T) {
    value = result
    latch.countDown()
  }

  fun completeExceptionally(e: Throwable) {
    error = e
    latch.countDown()
  }

  // Waits until [deadlineNanos]; returns the value, or throws the failure or a
  // TimeoutException if the deadline passes first.
  fun awaitOrThrow(deadlineNanos: Long): T {
    if (!latch.await(deadlineNanos - System.nanoTime(), TimeUnit.NANOSECONDS)) {
      throw TimeoutException("request did not complete")
    }
    error?.let { throw it }
    return value!!
  }

  // Waits until [deadlineNanos]; failure or timeout folds to null.
  fun awaitOrNull(deadlineNanos: Long): T? =
      try {
        awaitOrThrow(deadlineNanos)
      } catch (_: Exception) {
        null
      }
}
