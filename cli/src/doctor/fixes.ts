import { lstat, readFile, realpath, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DoctorResult } from "../commands/doctor";
import { resolveProjectConfigPath } from "../configStore";
import { isRecord } from "../output";

export type DoctorFix = {
  id: "create-project-server-config";
  file: string;
  field: "serverUrl";
  value: string;
};
export type PreparedDoctorFix = {
  preview: DoctorFix;
  root: string;
  requestedRoot: string;
  packageText: string;
};

/** Only an explicit, successfully probed URL may become a persistent default. */
export async function prepareDoctorFix(
  projectRoot: string,
  explicitServerUrl: string | undefined,
  result: DoctorResult,
): Promise<PreparedDoctorFix | undefined> {
  if (!explicitServerUrl || ([...explicitServerUrl].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) || /cm_pat_|eyJ[A-Za-z0-9_-]+\./.test(explicitServerUrl))) return;
  try {
    const url = new URL(explicitServerUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    const checks = result.groups.flatMap((group) => group.checks);
    if (checks.some((check) => check.reason === "redirect")) return;
    if (!['project-config', 'server-url', 'server-health'].every((id) => checks.some((check) => check.id === id && check.status === 'pass'))) return;
    const root = await realpath(projectRoot);
    const file = resolveProjectConfigPath(root);
    try { await lstat(file); return; } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") return;
    }
    const packageFile = join(root, "package.json");
    const stat = await lstat(packageFile);
    if (!stat.isFile() || stat.size > 1024 * 1024) return;
    const packageText = await readFile(packageFile, "utf8");
    const pkg: unknown = JSON.parse(packageText);
    if (!isRecord(pkg)) return;
    if (pkg.codemagicPatch !== undefined && (!isRecord(pkg.codemagicPatch) || pkg.codemagicPatch.serverUrl !== undefined)) return;
    return { root, requestedRoot: projectRoot, packageText, preview: { id: "create-project-server-config", file, field: "serverUrl", value: explicitServerUrl } };
  } catch { return; }
}

/** Publish a new file atomically and exclusively; never replace an existing file. */
export async function applyDoctorFix(fix: PreparedDoctorFix, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (await realpath(fix.requestedRoot) !== fix.root || await readFile(join(fix.root, "package.json"), "utf8") !== fix.packageText)
    throw new Error("Project configuration changed; rerun doctor before applying this fix.");
  const temporary = join(fix.root, `.cmpatch-doctor-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ serverUrl: fix.preview.value }, null, 2) + "\n", { flag: "wx" });
    signal.throwIfAborted();
    await link(temporary, fix.preview.file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
