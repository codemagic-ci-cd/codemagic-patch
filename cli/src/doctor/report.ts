import type { DoctorCheckGroup, DoctorCheckResult } from "../commands/doctor";

/** Resolve explicit prerequisite chains without borrowing another platform's evidence. */
export function doctorBlockers(
  groups: DoctorCheckGroup[],
): Map<DoctorCheckResult, DoctorCheckResult[]> {
  const checks = groups.flatMap((group) => group.checks);
  const resolve = (check: DoctorCheckResult, id: string) => {
    const candidates = checks.filter((item) => item.id === id);
    const local = candidates.filter((item) => item.platform === check.platform);
    const scoped = local.length ? local : candidates.filter((item) => !item.platform);
    return scoped.length === 1 ? scoped[0] : undefined;
  };
  const roots = (
    check: DoctorCheckResult,
    seen: Set<DoctorCheckResult>,
  ): DoctorCheckResult[] | undefined => {
    if (seen.has(check)) return undefined;
    if (check.status !== "skip" || check.reason !== "blocked") {
      return check.status === "fail" || check.status === "warn" ||
        (check.status === "skip" && ["unresolved", "deferred"].includes(check.reason ?? ""))
        ? [check] : undefined;
    }
    if (!check.prerequisites?.length) return undefined;
    const next = new Set(seen).add(check);
    const result: DoctorCheckResult[] = [];
    for (const id of check.prerequisites) {
      const prerequisite = resolve(check, id);
      if (!prerequisite) return undefined;
      if (prerequisite.status === "pass" || prerequisite.severity === "info") continue;
      const causes = roots(prerequisite, next);
      if (!causes) return undefined;
      result.push(...causes);
    }
    return result.length ? [...new Set(result)] : undefined;
  };
  const result = new Map<DoctorCheckResult, DoctorCheckResult[]>();
  for (const check of checks) {
    if (check.status !== "skip" || check.reason !== "blocked") continue;
    const causes = roots(check, new Set());
    if (causes) result.set(check, causes);
  }
  return result;
}
