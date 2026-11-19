import { createRequire } from "node:module";
import path from "node:path";

/**
 * A `require` that resolves the way Node resolves from a file in `root`: the
 * project's own `node_modules`, then each parent's, so a dependency hoisted to
 * a monorepo root is found. Resolving never executes a package; requiring does.
 */
export function createProjectRequire(root: string): ReturnType<typeof createRequire> {
  return createRequire(path.join(root, "package.json"));
}
