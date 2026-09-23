import { opendir } from "node:fs/promises";
import path from "node:path";
import {
  parseXcodeProject,
  resolveXcodeSetting,
  unquoteXcode as unquote,
  xcodeRefs as refs,
} from "../xcodeProject";

type Source = { state: string; text?: string };
type Read = (file: string) => Promise<Source>;
export type IosTarget = {
  plist?: string;
  sources: string[];
  project: string;
  name: string;
  settingsUnresolved: boolean;
  sourcesUnresolved: boolean;
};
export type IosTargets = {
  targets: IosTarget[];
  present: boolean;
  limited: boolean;
};
/** Follow Xcode target membership, not proximity of source files to a plist. */
export async function discoverIosTargets(
  root: string,
  read: Read,
): Promise<IosTargets> {
  const result: IosTargets = { targets: [], present: false, limited: false };
  const projects: string[] = [];
  try {
    let visited = 0;
    for await (const entry of await opendir(root)) {
      if (++visited > 200) {
        result.limited = true;
        break;
      }
      if (entry.name.endsWith(".xcodeproj")) {
        result.present = true;
        if (!entry.isDirectory() || projects.length >= 16)
          result.limited = true;
        else projects.push(path.join(root, entry.name, "project.pbxproj"));
      }
    }
  } catch {
    return result;
  }
  for (const project of projects.sort()) {
    const doc = await read(project);
    try {
      if (doc.state !== "resolved") throw new Error("unreadable project");
      const parsed = parseXcodeProject(doc.text!);
      const { record, project: projectObject } = parsed;
      const files = new Map<string, string>();
      const seen = new Set<string>();
      const walkGroup = (id: string, parent: string, depth: number) => {
        if (seen.has(id) || depth > 32 || seen.size >= 2000) return;
        seen.add(id);
        const group = record("PBXGroup", id);
        const file = record("PBXFileReference", id);
        const node = Object.keys(group).length ? group : file;
        const tree = unquote(node.sourceTree);
        const base =
          tree === "SOURCE_ROOT"
            ? root
            : tree === "<group>" || tree === ""
              ? parent
              : undefined;
        if (base === undefined) return;
        const location = path.resolve(base, unquote(node.path));
        if (Object.keys(file).length) files.set(id, location);
        for (const child of refs(group.children))
          walkGroup(child, location, depth + 1);
      };
      walkGroup(String(projectObject.mainGroup), root, 0);
      for (const target of parsed.targets) {
        if (result.targets.length >= 32) {
          result.limited = true;
          break;
        }
        let sourcesUnresolved =
          refs(target.fileSystemSynchronizedGroups).length > 0;
        const sources: string[] = [];
        for (const phase of refs(target.buildPhases)) {
          for (const buildFile of refs(
            record("PBXSourcesBuildPhase", phase).files,
          )) {
            const fileRef = String(record("PBXBuildFile", buildFile).fileRef);
            const source = files.get(fileRef);
            if (source && /\.(swift|mm|m)$/.test(source)) sources.push(source);
            else if (!source) sourcesUnresolved = true;
          }
        }
        if (sources.length > 64) sourcesUnresolved = true;
        let settingsUnresolved = false;
        const plists = new Set<string>();
        const configurations = parsed.configurations(target);
        if (!configurations.length) settingsUnresolved = true;
        for (const config of configurations) {
          const plist = resolveXcodeSetting(
            "INFOPLIST_FILE",
            config.settings,
            root,
          );
          if (!plist) settingsUnresolved = true;
          else plists.add(path.resolve(root, plist));
        }
        if (plists.size !== 1) settingsUnresolved = true;
        result.targets.push({
          project,
          name: unquote(target.name),
          plist: plists.size === 1 ? [...plists][0] : undefined,
          sources: [...new Set(sources)].slice(0, 64),
          settingsUnresolved,
          sourcesUnresolved,
        });
      }
    } catch {
      result.limited = true;
    }
  }
  return result;
}
