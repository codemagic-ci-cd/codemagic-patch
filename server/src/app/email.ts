export function canonicalizeEmail(email: string): string {
  const canonical = email.trim().toLowerCase();

  if (canonical.length === 0) {
    throw new Error("email must not be empty");
  }

  return canonical;
}
