import { realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import type { DiscoveryFinding, Platform } from "./discovery";

const traverse =
  typeof traverseModule === "function"
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default;
const SDK = "@codemagic/react-native-patch";
const METHODS = new Set(["sync", "checkForUpdate", "notifyAppReady"]);
type Read = (file: string) => Promise<{ state: string; text?: string }>;
type Ast = ReturnType<typeof parse>;
type Module = {
  ast: Ast;
  links: Map<string, string>;
  exports: Map<string, { source: string; name: string }>;
};

/** Bounded local import graph. Does not load Babel/Metro configuration or execute JS. */
export async function inspectJsGraph(
  root: string,
  main: unknown,
  platforms: readonly Platform[],
  read: Read,
): Promise<DiscoveryFinding> {
  root = await realpath(root).catch(() => root);
  const sources = new Set<string>();
  const matched: Platform[] = [];
  let limited = false;
  for (const platform of platforms) {
    const cache = new Map<string, string | null>();
    const inside = (file: string) => {
      const relative = path.relative(root, file);
      return (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes("node_modules")
      );
    };
    const resolve = async (base: string): Promise<string | null> => {
      if (cache.has(base)) return cache.get(base)!;
      if (!inside(base) || cache.size >= 2048) {
        limited = true;
        return null;
      }
      // Explicit extensions are exact imports. Extensionless imports use the
      // same platform/native/plain ordering for each supported source extension.
      const candidates = /\.[cm]?[jt]sx?$/.test(base)
        ? [base]
        : [base, path.join(base, "index")].flatMap((stem) =>
            ["js", "jsx", "ts", "tsx", "mjs", "cjs"].flatMap((ext) =>
              [platform, "native", ""].map(
                (suffix) => `${stem}${suffix ? `.${suffix}` : ""}.${ext}`,
              ),
            ),
          );
      for (const candidate of candidates) {
        try {
          const actual = await realpath(candidate);
          if (!inside(actual)) continue;
          const doc = await read(actual);
          if (doc.state === "resolved") {
            cache.set(base, actual);
            return actual;
          }
        } catch {
          /* try next candidate */
        }
      }
      cache.set(base, null);
      return null;
    };
    const entries: string[] = [];
    if (typeof main === "string" && main.length > 0) {
      const entry = await resolve(path.resolve(root, main));
      if (entry) entries.push(entry);
    }
    if (!entries.length && !(typeof main === "string" && main.length > 0)) {
      const entry = await resolve(path.join(root, "index"));
      if (entry) entries.push(entry);
      else {
        const app = await resolve(path.join(root, "App"));
        if (app) entries.push(app);
      }
    }
    const modules = new Map<string, Module>();
    const queue = entries.map((file) => ({ file, depth: 0 }));
    let bytes = 0;
    while (queue.length) {
      const { file, depth } = queue.shift()!;
      if (modules.has(file)) continue;
      if (modules.size >= 256 || depth > 16) {
        limited = true;
        continue;
      }
      const doc = await read(file);
      if (doc.state !== "resolved") {
        limited = true;
        continue;
      }
      bytes += Buffer.byteLength(doc.text!);
      if (bytes > 8 * 1024 * 1024) {
        limited = true;
        break;
      }
      sources.add(file);
      let ast: Ast;
      try {
        ast = parse(doc.text!, {
          sourceType: "unambiguous",
          plugins: [
            "jsx",
            /\.[cm]?tsx?$/.test(file) ? "typescript" : "flow",
            "decorators-legacy",
          ],
        });
      } catch {
        limited = true;
        continue;
      }
      const module: Module = { ast, links: new Map(), exports: new Map() };
      modules.set(file, module);
      const imports = new Set<string>();
      traverse(ast, {
        ImportDeclaration(p) {
          if (p.node.importKind !== "type" &&
            (p.node.specifiers.length === 0 || p.node.specifiers.some((item) =>
              item.type !== "ImportSpecifier" || item.importKind !== "type")))
            imports.add(p.node.source.value);
        },
        ExportNamedDeclaration(p) {
          if (p.node.exportKind === "type") return;
          if (!p.node.source) {
            for (const item of p.node.specifiers) {
              if (item.type !== "ExportSpecifier" || item.exportKind === "type") continue;
              const binding = p.scope.getBinding(item.local.name);
              if (
                !binding?.path.isImportSpecifier() ||
                binding.path.node.importKind === "type" ||
                !binding.path.parentPath?.isImportDeclaration() ||
                binding.path.parentPath.node.importKind === "type"
              )
                continue;
              const imported = binding.path.node.imported;
              module.exports.set(
                item.exported.type === "Identifier"
                  ? item.exported.name
                  : item.exported.value,
                {
                  source: binding.path.parentPath.node.source.value,
                  name:
                    imported.type === "Identifier"
                      ? imported.name
                      : imported.value,
                },
              );
            }
            return;
          }
          if (p.node.specifiers.some((item) => item.type !== "ExportSpecifier" || item.exportKind !== "type"))
            imports.add(p.node.source.value);
          for (const item of p.node.specifiers) {
            if (item.type !== "ExportSpecifier" || item.exportKind === "type") continue;
            module.exports.set(
              item.exported.type === "Identifier"
                ? item.exported.name
                : item.exported.value,
              { source: p.node.source.value, name: item.local.name },
            );
          }
        },
        ExportAllDeclaration(p) {
          if (p.node.exportKind === "type") return;
          imports.add(p.node.source.value);
          module.exports.set("*", {
            source: module.exports.has("*") ? "" : p.node.source.value,
            name: "*",
          });
        },
        CallExpression(p) {
          if (
            (p.node.callee.type === "Import" ||
              (p.node.callee.type === "Identifier" &&
                p.node.callee.name === "require" &&
                !p.scope.getBinding("require"))) &&
            p.node.arguments[0]?.type === "StringLiteral"
          )
            imports.add(p.node.arguments[0].value);
        },
      });
      for (const specifier of imports) {
        if (!specifier.startsWith(".")) continue;
        const resolved = await resolve(
          path.resolve(path.dirname(file), specifier),
        );
        if (resolved) {
          module.links.set(specifier, resolved);
          queue.push({ file: resolved, depth: depth + 1 });
        }
      }
    }
    const isSdkExport = (
      file: string,
      source: string,
      name: string,
      seen = new Set<string>(),
    ): boolean => {
      if (source === SDK) return METHODS.has(name);
      const linked = modules.get(file)?.links.get(source);
      if (!linked || seen.has(`${linked}:${name}`) || seen.size > 32)
        return false;
      seen.add(`${linked}:${name}`);
      const reexport =
        modules.get(linked)?.exports.get(name) ??
        modules.get(linked)?.exports.get("*");
      return (
        !!reexport &&
        isSdkExport(
          linked,
          reexport.source,
          reexport.name === "*" ? name : reexport.name,
          seen,
        )
      );
    };
    let found = false;
    for (const [file, module] of modules) {
      traverse(module.ast, {
        CallExpression(p) {
          const callee = p.node.callee;
          const identifier =
            callee.type === "Identifier"
              ? callee
              : callee.type === "MemberExpression" &&
                  callee.object.type === "Identifier"
                ? callee.object
                : undefined;
          if (!identifier) return;
          const binding = p.scope.getBinding(identifier.name);
          if (!binding || !binding.constant) return;
          if (binding.path.isVariableDeclarator()) {
            const init = binding.path.node.init;
            if (
              init?.type !== "CallExpression" ||
              init.callee.type !== "Identifier" ||
              init.callee.name !== "require" ||
              binding.path.scope.getBinding("require") ||
              init.arguments[0]?.type !== "StringLiteral"
            )
              return;
            const source = init.arguments[0].value;
            const id = binding.path.node.id;
            if (id.type === "ObjectPattern" && callee.type === "Identifier") {
              for (const property of id.properties) {
                if (
                  property.type === "ObjectProperty" &&
                  !property.computed &&
                  property.value.type === "Identifier" &&
                  property.value.name === identifier.name
                ) {
                  const name =
                    property.key.type === "Identifier"
                      ? property.key.name
                      : property.key.type === "StringLiteral"
                        ? property.key.value
                        : "";
                  if (isSdkExport(file, source, name)) found = true;
                }
              }
            } else if (
              id.type === "Identifier" &&
              callee.type === "MemberExpression" &&
              !callee.computed &&
              callee.property.type === "Identifier"
            ) {
              if (isSdkExport(file, source, callee.property.name)) found = true;
            }
            return;
          }
          const declaration = binding.path.parentPath;
          if (
            !declaration?.isImportDeclaration() ||
            declaration.node.importKind === "type"
          )
            return;
          const source = declaration.node.source.value;
          if (
            binding.path.isImportSpecifier() &&
            callee.type === "Identifier" &&
            binding.path.node.importKind !== "type"
          ) {
            const imported = binding.path.node.imported;
            if (
              isSdkExport(
                file,
                source,
                imported.type === "Identifier" ? imported.name : imported.value,
              )
            )
              found = true;
          } else if (
            binding.path.isImportNamespaceSpecifier() &&
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier"
          ) {
            if (isSdkExport(file, source, callee.property.name)) found = true;
          }
        },
      });
    }
    if (found) matched.push(platform);
  }
  const pass = platforms.length > 0 && matched.length === platforms.length;
  return {
    id: "sdk-update-flow",
    status: pass ? "pass" : "skip",
    detail: pass
      ? `SDK update/readiness source signals found for ${matched.join(", ")}; call reachability and runtime execution are not verified.`
      : `Update/readiness source signals remain unverified for ${platforms.filter((p) => !matched.includes(p)).join(", ")}. Only bounded local imports were inspected; custom aliases and external package entries are not resolved.`,
    sources: [...sources],
    ...(!pass
      ? {
          reason: limited ? "discovery_limit" : "unresolved",
          advice: [
            "Inspect the application's update/readiness entry and local imports; source signals do not establish device execution.",
          ],
        }
      : {}),
  };
}
