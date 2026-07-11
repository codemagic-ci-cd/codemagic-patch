package io.codemagic.patch.demo

import android.app.Application
import io.codemagic.patch.CodemagicPatch
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  // RN 0.84 default new-arch host wiring. The OTA SDK is integrated by feeding the
  // selected OTA bundle path into `jsBundleFilePath`; on install the SDK reloads
  // this `by lazy` host in place by swapping its bundle loader.
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      jsBundleFilePath = CodemagicPatch.getJSBundleFile(applicationContext),
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
