import { WebPlugin } from '@capacitor/core';

import type { BootState, CodemagicPatchPlugin, ManifestFetchResult, PackageMetadata } from './definitions';
import { CodemagicPatchError, CodemagicPatchErrorCode } from './definitions';

/**
 * OTA updates have no meaning on the web platform, where the deployment already *is*
 * the update — there is no separate binary to patch. Every method here rejects with
 * {@link CodemagicPatchErrorCode.UnsupportedOnWeb} rather than silently no-opping: a
 * misconfigured build (e.g. this plugin loaded in a Capacitor Electron/PWA target by
 * mistake) should fail loudly, not look like it worked.
 */
export class CodemagicPatchWeb extends WebPlugin implements CodemagicPatchPlugin {
  private unsupported(method: string): never {
    throw new CodemagicPatchError(
      CodemagicPatchErrorCode.UnsupportedOnWeb,
      `CodemagicPatch.${method}() is not supported on the web platform. ` +
        'OTA updates apply to native iOS/Android binaries only.',
    );
  }

  async getBootState(): Promise<BootState> {
    this.unsupported('getBootState');
  }

  async fetchManifest(): Promise<ManifestFetchResult> {
    this.unsupported('fetchManifest');
  }

  async getDeviceId(): Promise<{ deviceId: string }> {
    this.unsupported('getDeviceId');
  }

  async getPackageMetadata(): Promise<{ metadata: PackageMetadata | null }> {
    this.unsupported('getPackageMetadata');
  }

  async enqueueMetricEvent(): Promise<void> {
    this.unsupported('enqueueMetricEvent');
  }

  async downloadUpdate(): Promise<void> {
    this.unsupported('downloadUpdate');
  }

  async installUpdate(): Promise<void> {
    this.unsupported('installUpdate');
  }

  async confirmPendingUpdate(): Promise<void> {
    this.unsupported('confirmPendingUpdate');
  }

  async stageEmbeddedRevert(): Promise<void> {
    this.unsupported('stageEmbeddedRevert');
  }

  async clearUpdatesForTests(): Promise<void> {
    this.unsupported('clearUpdatesForTests');
  }

  async reloadBundle(): Promise<void> {
    this.unsupported('reloadBundle');
  }

  async verifyJwtSignature(): Promise<{ valid: boolean }> {
    this.unsupported('verifyJwtSignature');
  }
}
