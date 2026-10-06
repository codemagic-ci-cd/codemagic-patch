#!/usr/bin/env node
// CLI wrapper around the pure build-time checks in src/checkDeploymentKeys.ts (shared
// deploymentKey) and src/checkMaxLaunchAttempts.ts (invalid maxLaunchAttempts) — see
// those files and specs/adr/0003-configuration-via-capacitor-config.md. Deliberately plain Node, not
// part of the TS-compiled plugin bundle — it never runs in a WebView, only in whatever
// CI step a consuming project wires it into, e.g. before `cap sync`.
//
// Usage: npx codemagic-patch-check-config [path/to/capacitor.config.json]
// Defaults to ./capacitor.config.json. Only JSON is supported — a TypeScript source
// config must be pointed at its resolved JSON (e.g. a synced copy such as
// android/app/src/main/assets/capacitor.config.json) since this script has no
// TypeScript loader of its own.
import { readFileSync } from 'node:fs';

import { checkDeploymentKeys } from '../dist/esm/checkDeploymentKeys.js';
import { checkMaxLaunchAttempts } from '../dist/esm/checkMaxLaunchAttempts.js';

const configPath = process.argv[2] ?? 'capacitor.config.json';

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`codemagic-patch-check-config: could not read/parse "${configPath}": ${error.message}`);
  console.error(
    'Point this at a resolved JSON config — e.g. capacitor.config.json, or a synced native copy such as ' +
      'android/app/src/main/assets/capacitor.config.json — not a capacitor.config.ts source file.',
  );
  process.exit(1);
}

const failures = [checkDeploymentKeys(config), checkMaxLaunchAttempts(config)].filter((result) => !result.ok);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure.message);
  }
  process.exit(1);
}

console.log(
  'codemagic-patch-check-config: OK — no shared deploymentKey between iOS and Android, and any maxLaunchAttempts is valid.',
);
