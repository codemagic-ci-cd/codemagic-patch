export function r2Account(endpoint?: string): string | undefined;

export function verifyR2Domains(
  publicBucket: string,
  internalBucket: string,
  get: (path: string) => Promise<unknown>,
): Promise<void>;
