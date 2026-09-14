/** Provider diagnostics never include response bodies or signed request headers. */
export class ProviderHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(
      `${operation} failed (HTTP ${status}${code && /^[\w.-]{1,80}$/u.test(code) ? `, ${code}` : ""}).`,
    );
    this.name = "ProviderHttpError";
  }
}
