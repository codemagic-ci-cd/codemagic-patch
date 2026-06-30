import { randomUUID } from "node:crypto";

export function createReleaseId(): string {
  return `rel_${randomUUID().replace(/-/g, "")}`;
}

export function createReleaseJobId(): string {
  return `rj_${randomUUID().replace(/-/g, "")}`;
}
