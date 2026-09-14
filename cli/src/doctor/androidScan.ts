import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

type Dirent = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };

/**
 * Resource and host discovery have independent, bounded work budgets.
 *
 * `hostPath` is the application class as a package-relative path
 * (`com/app/MainApplication`) when the manifest/Gradle namespace made it
 * derivable. It is probed directly under each source set's java/kotlin root
 * so ordinary source trees never spend the walk budget; the bounded walk is
 * only the fallback when the application's qualified path is unknown.
 */
export async function scanAndroid(root: string, host: string, hostUnknown: boolean, hostPath?: string) {
  const result = { files: [] as string[], limited: false, sourcesLimited: false, present: false, nativeSources: undefined as string[] | undefined };
  const counts = { layout: 0, resources: 0, sources: 0 };
  type Scope = keyof typeof counts;
  const limit = (scope: Scope) => {
    if (scope !== "sources") result.limited = true;
    if (scope !== "resources") result.sourcesLimited = true;
  };
  async function entries(dir: string, scope: Scope, visit: (entry: Dirent) => Promise<void>) {
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { limit(scope); return; }
      if (scope === "layout") result.present = true;
      for await (const entry of await opendir(dir, {bufferSize: 32})) {
        if (++counts[scope] > (scope === "resources" ? 1000 : 200)) { limit(scope); break; }
        await visit(entry);
      }
    } catch (error) {
      if ((error as {code?: string}).code !== "ENOENT") limit(scope);
    }
  }
  async function sources(dir: string, depth: number): Promise<void> {
    if (counts.sources > 200) return;
    await entries(dir, "sources", async (entry) => {
      if (entry.isSymbolicLink()) { limit("sources"); return; }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 6) limit("sources"); else await sources(file, depth + 1);
      } else if (entry.isFile() && [host + ".kt", host + ".java"].includes(entry.name)) result.files.push(file);
    });
  }
  async function direct(sourceRoot: string): Promise<string[]> {
    if (!hostPath) return [];
    // The source set was checked above; validate every remaining directory
    // without following links or enumerating unrelated source files.
    const segments = hostPath.split("/");
    let dir = sourceRoot;
    try {
      for (let i = 0; i < segments.length; i++) {
        const stat = await lstat(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          limit("sources");
          return [];
        }
        if (i < segments.length - 1) dir = path.join(dir, segments[i]);
      }
    } catch (error) {
      if ((error as {code?: string}).code !== "ENOENT") limit("sources");
      return [];
    }
    const hits: string[] = [];
    for (const extension of [".kt", ".java"]) {
      const file = path.join(sourceRoot, hostPath + extension);
      try {
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) limit("sources");
        else hits.push(file);
      } catch (error) {
        if ((error as {code?: string}).code !== "ENOENT") limit("sources");
      }
    }
    return hits;
  }
  let xmlFiles = 0;
  const sourceRoots: string[] = [];
  await entries(root, "layout", async (sourceSet) => {
    if ([".git", "build", "node_modules"].includes(sourceSet.name)) return;
    if (sourceSet.isSymbolicLink()) { limit("layout"); return; }
    if (!sourceSet.isDirectory()) return;
    const dir = path.join(root, sourceSet.name);
    await entries(path.join(dir, "res"), "resources", async (resource) => {
      if (!/^values(?:-|$)/.test(resource.name)) return;
      if (resource.isSymbolicLink()) { limit("resources"); return; }
      if (!resource.isDirectory()) return;
      await entries(path.join(dir, "res", resource.name), "resources", async (entry) => {
        if (entry.isSymbolicLink()) { limit("resources"); return; }
        if (!entry.isFile() || !entry.name.endsWith(".xml")) return;
        if (++xmlFiles > 128) { limit("resources"); return; }
        result.files.push(path.join(dir, "res", resource.name, entry.name));
      });
    });
    sourceRoots.push(path.join(dir, "java"), path.join(dir, "kotlin"));
  });
  const hits = (await Promise.all(sourceRoots.map(direct))).flat();
  if (hits.length > 0) result.files.push(...hits);
  else if (!hostPath) {
    for (const sourceRoot of sourceRoots) await sources(sourceRoot, 0);
  }
  result.files.sort();
  const hosts = result.files.filter((file) => /\.(kt|java)$/.test(file));
  if (hostUnknown) result.nativeSources = [];
  else if (hosts.length === 1) result.nativeSources = hosts;
  return result;
}
