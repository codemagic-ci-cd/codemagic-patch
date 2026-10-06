// Shell quoting and flag assembly shared by the CLI command builders. Both
// CLIs parse flags the same way, so the rules below hold for either — string
// only, no CLI import.

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Value flags are string flags in the CLI parsers: a bare `--flag` with no
// value is a parse error, so an absent or blank value must omit the flag
// entirely.
export function pushFlag(parts: string[], flag: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  parts.push(`--${flag} ${shellQuote(trimmed)}`);
}

export function pushBooleanFlag(parts: string[], flag: string): void {
  parts.push(`--${flag}`);
}
