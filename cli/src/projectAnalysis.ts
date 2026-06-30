import path from "node:path";

import { UsageError, type CommandDeps } from "./commands/shared";
import { isRecord } from "./output";

export type NativePlatform = "android" | "ios";

export type NativeProjectContext =
  | {
      kind: "present";
      source: "explicit-option" | "platform-directory";
    }
  | {
      kind: "absent";
    };

export type DetectedBundler =
  | {
      kind: "expo" | "metro";
      reason: string;
    }
  | {
      kind: "repack" | "rock";
      reason: string;
    };

type ProjectAnalysisDeps = Pick<CommandDeps, "readFile" | "stat">;

export async function resolveNativeProjectContext(
  deps: Pick<CommandDeps, "stat">,
  input: {
    hasExplicitNativeProjectOption?: boolean;
    platform: NativePlatform;
    projectRoot: string;
  },
): Promise<NativeProjectContext> {
  if (input.hasExplicitNativeProjectOption === true) {
    return {
      kind: "present",
      source: "explicit-option",
    };
  }

  if (
    await hasNativeProjectDirectoryForPlatform(
      deps,
      input.projectRoot,
      input.platform,
    )
  ) {
    return {
      kind: "present",
      source: "platform-directory",
    };
  }

  return {
    kind: "absent",
  };
}

export async function detectNativePlatforms(
  deps: Pick<CommandDeps, "stat">,
  projectRoot: string,
): Promise<NativePlatform[]> {
  const platforms: NativePlatform[] = [];

  if (await hasNativeProjectDirectoryForPlatform(deps, projectRoot, "android")) {
    platforms.push("android");
  }

  if (await hasNativeProjectDirectoryForPlatform(deps, projectRoot, "ios")) {
    platforms.push("ios");
  }

  return platforms;
}

export async function hasNativeProjectDirectoryForPlatform(
  deps: Pick<CommandDeps, "stat">,
  projectRoot: string,
  platform: NativePlatform,
): Promise<boolean> {
  if (platform === "android") {
    return await isDirectory(deps, path.join(projectRoot, "android"));
  }

  return (
    (await isDirectory(deps, path.join(projectRoot, "ios"))) ||
    (await isDirectory(deps, path.join(projectRoot, "iOS")))
  );
}

export async function detectProjectBundler(
  deps: ProjectAnalysisDeps,
  projectRoot: string,
): Promise<DetectedBundler> {
  const packageJson = await readProjectPackageJson(deps, projectRoot);
  const dependencies = readPackageNames(packageJson);
  const markers: DetectedBundler[] = [];

  if (
    dependencies.has("expo") ||
    (await hasAnyReadableFile(deps, projectRoot, [
      "app.config.js",
      "app.config.ts",
    ])) ||
    (await hasExpoAppJson(deps, projectRoot))
  ) {
    markers.push({ kind: "expo", reason: "Expo package or config" });
  }

  if (
    dependencies.has("@callstack/repack") ||
    dependencies.has("react-native-repack") ||
    (await hasAnyReadableFile(deps, projectRoot, [
      "repack.config.js",
      "repack.config.ts",
      "webpack.config.js",
      "rspack.config.js",
    ]))
  ) {
    markers.push({ kind: "repack", reason: "Re.Pack package or config" });
  }

  if (
    dependencies.has("rock") ||
    dependencies.has("@callstack/rock") ||
    (await hasAnyReadableFile(deps, projectRoot, ["rock.config.js", "rock.config.ts"]))
  ) {
    markers.push({ kind: "rock", reason: "Rock package or config" });
  }

  const uniqueKinds = Array.from(new Set(markers.map((marker) => marker.kind)));
  if (uniqueKinds.length > 1) {
    throw new UsageError(
      `Ambiguous bundler detection for ${projectRoot}: ${markers
        .map((marker) => `${formatBundlerName(marker.kind)} (${marker.reason})`)
        .join(", ")}. Pass --bundler metro or --bundler expo explicitly.`,
    );
  }

  return markers[0] ?? { kind: "metro", reason: "default Metro fallback" };
}

export function formatBundlerName(kind: DetectedBundler["kind"]): string {
  if (kind === "repack") {
    return "Re.Pack";
  }

  return kind === "rock" ? "Rock" : kind[0]!.toUpperCase() + kind.slice(1);
}

async function isDirectory(
  deps: Pick<CommandDeps, "stat">,
  directoryPath: string,
): Promise<boolean> {
  try {
    return (await deps.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function readProjectPackageJson(
  deps: Pick<CommandDeps, "readFile">,
  projectRoot: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await deps.readFile(path.join(projectRoot, "package.json"));
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function hasExpoAppJson(
  deps: Pick<CommandDeps, "readFile">,
  projectRoot: string,
): Promise<boolean> {
  try {
    const raw = await deps.readFile(path.join(projectRoot, "app.json"));
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return isRecord(parsed) && isRecord(parsed.expo);
  } catch {
    return false;
  }
}

function readPackageNames(
  packageJson: Record<string, unknown> | null,
): Set<string> {
  const names = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const dependencies = packageJson?.[section];
    if (isRecord(dependencies)) {
      for (const name of Object.keys(dependencies)) {
        names.add(name);
      }
    }
  }

  return names;
}

async function hasAnyReadableFile(
  deps: Pick<CommandDeps, "stat">,
  projectRoot: string,
  relativePaths: string[],
): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await isReadableFile(deps, path.join(projectRoot, relativePath))) {
      return true;
    }
  }

  return false;
}

async function isReadableFile(
  deps: Pick<CommandDeps, "stat">,
  filePath: string,
): Promise<boolean> {
  try {
    return (await deps.stat(filePath)).isFile();
  } catch {
    return false;
  }
}
