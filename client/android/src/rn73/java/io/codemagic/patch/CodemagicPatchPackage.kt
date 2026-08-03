package io.codemagic.patch

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

// RN <= 0.73 slice, selected by android/build.gradle from the host's React
// Native version. BaseReactPackage only exists from RN 0.74, so this variant
// extends its predecessor TurboReactPackage (not deprecated on 0.73). Keep in
// sync with src/rn74plus/.../CodemagicPatchPackage.kt — the two variants
// differ only in the superclass.
class CodemagicPatchPackage : TurboReactPackage() {
  override fun getModule(
      name: String,
      reactContext: ReactApplicationContext
  ): NativeModule? =
      if (name == NativeCodemagicPatchSpec.NAME) CodemagicPatchModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
      ReactModuleInfoProvider {
        mapOf(
            NativeCodemagicPatchSpec.NAME to
                ReactModuleInfo(
                    NativeCodemagicPatchSpec.NAME,
                    CodemagicPatchModule::class.java.name,
                    false,
                    false,
                    false,
                    true))
      }
}
