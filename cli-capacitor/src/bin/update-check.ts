// Copied from cli/src/bin/update-check.ts; see cli-capacitor-tech-spec › Provenance.

// The detached process updateNotice.ts starts. Not a command: it takes the
// package to look up and the state file to write, and prints nothing.

import { writeFileSync } from "node:fs";

import { checkForUpdate } from "@codemagic/patch-shared";

const [packageName, statePath] = process.argv.slice(2);

if (packageName !== undefined && statePath !== undefined) {
  void checkForUpdate({
    fetch: globalThis.fetch,
    now: Date.now,
    packageName,
    writeState: (text) => writeFileSync(statePath, text),
  });
}
