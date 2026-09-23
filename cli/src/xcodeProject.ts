import { createRequire } from "node:module";
import { isRecord } from "./output";

const parser = createRequire(__filename)("xcode/lib/parser/pbxproj") as {
  parse: (text: string) => unknown;
};

// The pbxproj parser yields bare numerals (MARKETING_VERSION = 2;) as numbers.
export const unquoteXcode = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(/^"|"$/g, "")
    : typeof value === "number"
      ? String(value)
      : "";
export const xcodeRefs = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((ref) =>
        typeof ref === "string"
          ? ref
          : isRecord(ref)
            ? String(ref.value ?? "")
            : "",
      )
    : [];

export function parseXcodeProject(text: string) {
  const parsed = parser.parse(text);
  if (
    !isRecord(parsed) ||
    !isRecord(parsed.project) ||
    !isRecord(parsed.project.objects)
  ) {
    throw new Error("Invalid Xcode project");
  }
  const objects = parsed.project.objects;
  const record = (sectionName: string, id: string): Record<string, unknown> => {
    const section = objects[sectionName];
    const value = isRecord(section) ? section[id] : objects[id];
    return isRecord(value) && value.isa === sectionName ? value : {};
  };
  const project = record("PBXProject", String(parsed.project.rootObject));
  if (!project.isa) throw new Error("Missing Xcode project root");
  const configurations = (owner: Record<string, unknown>) =>
    xcodeRefs(
      record("XCConfigurationList", String(owner.buildConfigurationList))
        .buildConfigurations,
    ).map((id) => record("XCBuildConfiguration", id));
  const parents = configurations(project);
  return {
    record,
    project,
    targets: xcodeRefs(project.targets)
      .map((id) => record("PBXNativeTarget", id))
      .filter(
        (target) =>
          unquoteXcode(target.productType) ===
          "com.apple.product-type.application",
      ),
    configurations: (target: Record<string, unknown>) =>
      configurations(target).map((config) => {
        const parent = parents.find(
          (item) => unquoteXcode(item.name) === unquoteXcode(config.name),
        );
        return {
          name: unquoteXcode(config.name),
          settings: {
            // A target xcconfig can override project-level values. Only trust
            // target-inline settings when that intermediate layer is unknown.
            ...(!config.baseConfigurationReference &&
            isRecord(parent?.buildSettings)
              ? parent.buildSettings
              : {}),
            ...(isRecord(config.buildSettings) ? config.buildSettings : {}),
          },
        };
      }),
  };
}

/** Only resolve inline settings; never execute Xcode or evaluate xcconfig files. */
export function resolveXcodeSetting(
  key: string,
  settings: Record<string, unknown>,
  root: string,
): string | undefined {
  const readSetting = (name: string): string | undefined => {
    // The CLI has no SDK/architecture context. A conditional override of any
    // referenced setting makes its default unsafe, including indirect aliases.
    if (
      Object.keys(settings).some((candidate) =>
        unquoteXcode(candidate).startsWith(`${name}[`),
      )
    ) {
      return undefined;
    }
    if (name === "SRCROOT" || name === "PROJECT_DIR") return root;
    return unquoteXcode(settings[name]) || undefined;
  };
  let resolved = readSetting(key);
  if (resolved === undefined) return undefined;
  for (let n = 0; n < 8 && /\$[({]/.test(resolved); n++) {
    resolved = resolved.replace(
      /\$\(([^)]+)\)|\$\{([^}]+)\}/g,
      (match, a: string, b: string) => readSetting(a ?? b) ?? match,
    );
  }
  return resolved.trim() && !/\$[({]/.test(resolved)
    ? resolved.trim()
    : undefined;
}
