// The build tools need Node.js 20 or newer. Kept free of imports beyond the
// error class so the check itself runs on an older Node.

import { BuildToolsError } from "./errors";

export const MINIMUM_NODE_MAJOR = 20;

/** Throws `UNSUPPORTED_NODE` when `version`'s major is below 20. */
export function assertSupportedNode(version: string = process.versions.node): void {
  const major = Number.parseInt(version, 10);
  if (Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR) {
    return;
  }
  throw new BuildToolsError(
    "UNSUPPORTED_NODE",
    `the Codemagic Patch build tools require Node.js ${MINIMUM_NODE_MAJOR} or newer, but Node.js ${version} is running (${process.execPath}). Run the build with a newer Node.js.`,
  );
}
