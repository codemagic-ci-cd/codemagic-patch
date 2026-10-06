import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CapacitorConfig } from '@capacitor/cli';

// Reference app for @codemagic/capacitor-patch. Which Patch server it talks to is not
// committed: the values come from `patch.config.local.json` next to this file
// (gitignored — copy `patch.config.example.json` and fill it in, see README.md). A
// deployment key only means something against the one server that issued it, so a
// committed default could never work for anyone else anyway.
//
// `apiUrl` is also where the metrics write-ahead log is flushed to on foreground entry
// (`/v1/metrics/events`) — see CodemagicPatchConfigResolver.
//
// `publicKey` is optional: set it when the app on the server was created with code
// signing required, so the SDK's RS256 verification (verifyJwtSignature, both
// platforms) actually checks releases instead of skipping verification. It is the SPKI
// public key, not a secret — it is meant to ship in the client.
interface PatchPlatformConfig {
  deploymentKey: string;
  apiUrl: string;
  downloadBaseUrl: string;
  publicKey?: string;
}

type PatchPlatform = 'ios' | 'android';
type PatchLocalConfig = Partial<Record<PatchPlatform, PatchPlatformConfig>>;

const LOCAL_CONFIG_FILE = 'patch.config.local.json';
const REQUIRED_KEYS = ['deploymentKey', 'apiUrl', 'downloadBaseUrl'] as const;

function loadPatchLocalConfig(): PatchLocalConfig {
  // The Capacitor CLI always runs from the app root, which is also where this file
  // lives — cwd keeps this independent of how the CLI happens to load a .ts config.
  const localConfigPath = join(process.cwd(), LOCAL_CONFIG_FILE);
  if (!existsSync(localConfigPath)) {
    throw new Error(
      `${LOCAL_CONFIG_FILE} not found in ${process.cwd()}. Copy patch.config.example.json to ` +
        `${LOCAL_CONFIG_FILE} and fill in your Patch server URLs and one deployment key per ` +
        `platform — see example-app/README.md.`,
    );
  }

  const localConfig = JSON.parse(readFileSync(localConfigPath, 'utf8')) as PatchLocalConfig;
  const platforms = (['ios', 'android'] as const).filter((platform) => localConfig[platform]);
  if (platforms.length === 0) {
    throw new Error(`${LOCAL_CONFIG_FILE} must configure at least one of "ios" / "android".`);
  }

  // Fail here, at `cap sync`, rather than on a device: a block that is missing a value —
  // or still carries the template's "<…-deployment-key>" placeholder — builds and
  // installs fine and only surfaces later as an opaque sync error in the running app.
  for (const platform of platforms) {
    for (const key of REQUIRED_KEYS) {
      const value = localConfig[platform]?.[key];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('<')) {
        throw new Error(`${LOCAL_CONFIG_FILE}: "${platform}.${key}" is missing or still a placeholder.`);
      }
    }
  }
  return localConfig;
}

const config: CapacitorConfig = {
  appId: 'io.codemagic.patch.example',
  appName: 'CodemagicPatchExample',
  webDir: 'www',
  plugins: {
    // One block per platform, each with its own deployment key — never a shared one,
    // which would let iOS and Android releases overwrite each other's manifest (see
    // the Configuration section of the package README).
    CodemagicPatch: loadPatchLocalConfig(),
  },
};

export default config;
