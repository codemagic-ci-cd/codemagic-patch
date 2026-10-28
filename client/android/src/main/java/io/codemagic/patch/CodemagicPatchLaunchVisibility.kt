package io.codemagic.patch

import android.app.Activity
import android.app.ActivityManager
import android.app.ActivityManager.RunningAppProcessInfo
import android.app.Application
import android.content.Context
import android.os.Bundle
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Whether this process is one the user can see, for deciding which launches
 * count against a pending package's launch-attempt budget.
 *
 * React Native resolves the bundle whenever something builds the React host,
 * and that is not always the user opening the app. A headless JS task — an FCM
 * data-message handler, say — boots the pending bundle in a background process
 * that never mounts the root component, so it can never reach
 * `notifyAppReady()`. The OS later reclaims that idle process, and charging it
 * would let a few background wake-ups roll back a package the user never ran.
 */
internal object CodemagicPatchLaunchVisibility {
  /**
   * True when the process is in the foreground or visible.
   *
   * When the platform cannot answer, the launch is treated as visible: charging
   * it is what the SDK always did, so an unknown never weakens rollback. The
   * same holds for the few processes with no UI that still report these
   * importances, such as one bound by the app on screen or one holding an
   * overlay window.
   */
  fun isUserFacing(): Boolean {
    val process = RunningAppProcessInfo()
    try {
      ActivityManager.getMyMemoryState(process)
    } catch (_: RuntimeException) {
      return true
    }
    return process.importance == RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
        process.importance == RunningAppProcessInfo.IMPORTANCE_VISIBLE
  }

  /**
   * Runs [action] once, on the main thread, when an activity of this process
   * is next created, started, or resumed. Returns false without scheduling
   * anything when the context does not lead to an [Application].
   *
   * Created reaches an activity that opens after the deferral before it
   * attaches a React surface, so a package that crashes on render is charged
   * first. Started and resumed reach an activity that already existed: a
   * reload that ran in the background shows no new activity, only the old one
   * coming back, and an activity kept alive behind the lock screen returns
   * through resume alone.
   */
  fun runOnNextActivity(context: Context, action: () -> Unit): Boolean {
    val application = context.applicationContext as? Application ?: return false
    val ran = AtomicBoolean(false)
    application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      private fun runOnce() {
        if (!ran.compareAndSet(false, true)) return
        application.unregisterActivityLifecycleCallbacks(this)
        action()
      }

      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = runOnce()
      override fun onActivityStarted(activity: Activity) = runOnce()
      override fun onActivityResumed(activity: Activity) = runOnce()
      override fun onActivityPaused(activity: Activity) {}
      override fun onActivityStopped(activity: Activity) {}
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
      override fun onActivityDestroyed(activity: Activity) {}
    })
    return true
  }
}
