// Errors raised by the SDK build tools. Callers (the native build hook, the
// CLI resolver) switch on `code`; the message is for humans.

export type BuildToolsErrorCode =
  /** A caller passed an argument the contract does not allow. */
  | "INVALID_ARGUMENT"
  /** The app root is missing, not a directory or has no package.json. */
  | "INVALID_APP_ROOT"
  /** The SDK's own `@expo/fingerprint` could not be resolved or loaded. */
  | "ENGINE_UNAVAILABLE"
  /** The resolved `@expo/fingerprint` is not the version the SDK pins. */
  | "ENGINE_VERSION_MISMATCH"
  /** The project's fingerprint.config.js carries an unusable value. */
  | "INVALID_PROJECT_CONFIG"
  /** The engine threw, or returned a result the contract does not accept. */
  | "CALCULATOR_FAILED"
  /** The selected embedded tree is missing, unreadable or not representable. */
  | "INVALID_TREE"
  /** The build resolved a bundle file name other than the platform default (spec §5.2 rule 6). */
  | "UNSUPPORTED_BUNDLE_NAME"
  /** CodemagicPatchBuild.json could not be written, replaced or removed. */
  | "WRITE_FAILED"
  /** The running Node.js is older than the build tools support (major below 20). */
  | "UNSUPPORTED_NODE";

export class BuildToolsError extends Error {
  readonly code: BuildToolsErrorCode;

  constructor(code: BuildToolsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BuildToolsError";
    this.code = code;
  }
}

export function isBuildToolsError(error: unknown): error is BuildToolsError {
  return error instanceof BuildToolsError;
}
