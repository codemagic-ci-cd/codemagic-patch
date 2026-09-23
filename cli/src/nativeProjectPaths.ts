import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Preserve the directory entry's spelling even on case-insensitive filesystems. */
export async function findIosRoot(root: string): Promise<string> {
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of ["ios", "iOS"]) {
    const candidate = path.join(root, name);
    if (names.includes(name) && await stat(candidate).then((entry) => entry.isDirectory(), () => false)) return candidate;
  }
  return path.join(root, "ios");
}
