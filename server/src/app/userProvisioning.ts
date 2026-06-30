import type { AuthRepository } from "../repositories";

export async function getOrCreateUser(
  repository: AuthRepository,
  input: Parameters<AuthRepository["createUser"]>[0],
): Promise<{
  created: boolean;
  user: Awaited<ReturnType<AuthRepository["getUserByEmail"]>> & {};
}> {
  const existing = await repository.getUserByEmail(input.email);
  if (existing) {
    return {
      created: false,
      user: existing,
    };
  }

  const created = await repository.createUser(input);
  if (created.outcome === "created") {
    return {
      created: true,
      user: created.user,
    };
  }

  const racedExisting = await repository.getUserByEmail(input.email);
  if (racedExisting) {
    return {
      created: false,
      user: racedExisting,
    };
  }

  throw new Error("user email conflict could not be resolved");
}
