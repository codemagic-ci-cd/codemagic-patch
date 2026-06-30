package io.codemagic.patch

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class CodemagicPatchPackage : BaseReactPackage() {
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
