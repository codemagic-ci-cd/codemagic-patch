import { access } from "node:fs/promises";
import path from "node:path";

export interface HdiffPatchBinaryPaths {
  hdiffz: string;
  hpatchz: string;
}

const HDIFFPATCH_VERSION = "v4.12.2";
const HDIFFPATCH_VENDOR_ROOT = path.resolve(
  __dirname,
  "../../vendor/hdiffpatch",
  HDIFFPATCH_VERSION,
);

export async function resolveHdiffPatchBinaryPaths(): Promise<HdiffPatchBinaryPaths> {
  const envPaths = readBinaryPathsFromEnvironment();
  if (envPaths) {
    await assertBinaryPathsExist(envPaths);
    return envPaths;
  }

  const platformDirectory = resolvePlatformDirectory(process.platform, process.arch);
  const resolvedPaths = {
    hdiffz: path.join(HDIFFPATCH_VENDOR_ROOT, platformDirectory, "hdiffz"),
    hpatchz: path.join(HDIFFPATCH_VENDOR_ROOT, platformDirectory, "hpatchz"),
  };

  await assertBinaryPathsExist(resolvedPaths);
  return resolvedPaths;
}

export function isHdiffPatchPlatformSupported(
  platform = process.platform,
  arch = process.arch,
): boolean {
  try {
    resolvePlatformDirectory(platform, arch);
    return true;
  } catch {
    return false;
  }
}

function readBinaryPathsFromEnvironment(): HdiffPatchBinaryPaths | null {
  const envHdiffz = process.env.CODEMAGIC_PATCH_HDIFFZ_PATH;
  const envHpatchz = process.env.CODEMAGIC_PATCH_HPATCHZ_PATH;

  if (!envHdiffz && !envHpatchz) {
    return null;
  }

  if (!envHdiffz || !envHpatchz) {
    throw new Error(
      "Both CODEMAGIC_PATCH_HDIFFZ_PATH and CODEMAGIC_PATCH_HPATCHZ_PATH must be set together",
    );
  }

  return {
    hdiffz: envHdiffz,
    hpatchz: envHpatchz,
  };
}

function resolvePlatformDirectory(platform: string, arch: string): string {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return "macos";
  }

  if (platform === "linux" && arch === "x64") {
    return "linux64";
  }

  if (platform === "linux" && arch === "arm64") {
    return "linux_arm64";
  }

  if (platform === "win32" && arch === "x64") {
    return "windows64";
  }

  if (platform === "win32" && arch === "arm64") {
    return "windows_arm64";
  }

  throw new Error(`Unsupported HDiffPatch platform: ${platform}/${arch}`);
}

async function assertBinaryPathsExist(paths: HdiffPatchBinaryPaths): Promise<void> {
  await Promise.all([access(paths.hdiffz), access(paths.hpatchz)]);
}
