export function resolveDatabaseSearchPath(
  searchPath: string | undefined,
): string[] {
  if (searchPath === undefined) {
    return [];
  }

  return searchPath
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(validateDatabaseSearchPathSegment);
}

function validateDatabaseSearchPathSegment(segment: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
    throw new Error(
      `DATABASE_SEARCH_PATH entries must be valid PostgreSQL identifiers. Invalid entry: ${segment}`,
    );
  }

  return segment;
}
