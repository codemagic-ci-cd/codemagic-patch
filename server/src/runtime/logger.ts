export interface RuntimeLogger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/**
 * Fallback used when no logger is injected. The production path
 * (`startServer`) always injects the shared logger instance; direct
 * `createServerRuntime` embedders that want logs must inject one.
 */
export function createNoopLogger(): RuntimeLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
