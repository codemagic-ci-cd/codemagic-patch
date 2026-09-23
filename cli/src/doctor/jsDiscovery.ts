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
const METHODS = new Set(["sync", "checkForUpdate", "notifyAppReady", "wrap"]);
/**
 * Expo Router's root layout stems, most specific first: `src/app` takes
 * precedence over the root `app` directory and is the only one used when
 * both exist (https://docs.expo.dev/router/reference/src-directory/).
 */
export const EXPO_ROUTER_LAYOUTS: readonly string[] = ["src/app/_layout", "app/_layout"];
export type JsGraphRead = (file: string) => Promise<{ state: string; text?: string }>;
/** An SDK `sync` / `checkForUpdate` / `notifyAppReady` / `wrap` call site, by real path. */
export type JsGraphCall = { file: string; method: string };
export type JsGraphWalk = {
  /** One entry per file and SDK method reached from the entry. */
  calls: JsGraphCall[];
  /** A bound was hit or a module was unreadable or unparsable, so absence proves nothing. */
  limited: boolean;
  sources: string[];
};
type Ast = ReturnType<typeof parse>;
type Module = {
  ast: Ast;
  links: Map<string, string>;
  exports: Map<string, { source: string; name: string }>;
};

/**
 * The files an extensionless import may mean, in Metro's order: each source
 * extension in turn, platform-specific before `.native` before plain. An
 * import with an explicit extension is exact.
 */
export function moduleCandidates(base: string, platform: Platform): string[] {
  return /\.[cm]?[jt]sx?$/.test(base)
    ? [base]
    : [base, path.join(base, "index")].flatMap((stem) =>
        ["js", "jsx", "ts", "tsx", "mjs", "cjs"].flatMap((ext) =>
          [platform, "native", ""].map(
            (suffix) => `${stem}${suffix ? `.${suffix}` : ""}.${ext}`,
          ),
        ),
      );
}

/** Bounded local import graph. Does not load Babel/Metro configuration or execute JS. */
export async function inspectJsGraph(
  root: string,
  main: unknown,
  platforms: readonly Platform[],
  read: JsGraphRead,
): Promise<DiscoveryFinding> {
  const sources = new Set<string>();
  const matched: Platform[] = [];
  let limited = false;
  for (const platform of platforms) {
    const walk = await walkJsGraph(root, main, platform, read);
    for (const source of walk.sources) sources.add(source);
    if (walk.limited) limited = true;
    if (walk.calls.length > 0) matched.push(platform);
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

/**
 * One platform's walk of the bounded local import graph from the app's
 * entry (package.json `main`, the expo-router layout, expo/AppEntry's App,
 * or index/App), resolving Metro platform suffixes: every SDK method call
 * it reaches, including through local re-exports and `require`.
 */
export async function walkJsGraph(
  root: string,
  main: unknown,
  platform: Platform,
  read: JsGraphRead,
): Promise<JsGraphWalk> {
  root = await realpath(root).catch(() => root);
  const sources: string[] = [];
  const calls: JsGraphCall[] = [];
  let limited = false;
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
    for (const candidate of moduleCandidates(base, platform)) {
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
    // Expo's package entries live in node_modules; the app's own root is
    // the expo-router layout or the App module they load.
    const stems =
      main === "expo-router/entry"
        ? EXPO_ROUTER_LAYOUTS
        : /(^|\/)expo\/AppEntry(\.js)?$/.test(main)
          ? ["App"]
          : [main];
    for (const stem of stems) {
      const entry = await resolve(path.resolve(root, stem));
      if (entry) {
        entries.push(entry);
        break;
      }
    }
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
    sources.push(file);
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
  /** The SDK method a binding `name` imported from `source` in `file` resolves to, through local re-exports. */
  const sdkMethod = (
    file: string,
    source: string,
    name: string,
    seen = new Set<string>(),
  ): string | null => {
    if (source === SDK) return METHODS.has(name) ? name : null;
    const linked = modules.get(file)?.links.get(source);
    if (!linked || seen.has(`${linked}:${name}`) || seen.size > 32)
      return null;
    seen.add(`${linked}:${name}`);
    const reexport =
      modules.get(linked)?.exports.get(name) ??
      modules.get(linked)?.exports.get("*");
    return reexport
      ? sdkMethod(
          linked,
          reexport.source,
          reexport.name === "*" ? name : reexport.name,
          seen,
        )
      : null;
  };
  const recorded = new Set<string>();
  for (const [file, module] of modules) {
    const found = (method: string | null) => {
      if (method === null || recorded.has(`${file}:${method}`)) return;
      recorded.add(`${file}:${method}`);
      calls.push({ file, method });
    };
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
                found(sdkMethod(file, source, name));
              }
            }
          } else if (
            id.type === "Identifier" &&
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.property.type === "Identifier"
          ) {
            found(sdkMethod(file, source, callee.property.name));
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
          found(
            sdkMethod(
              file,
              source,
              imported.type === "Identifier" ? imported.name : imported.value,
            ),
          );
        } else if (
          binding.path.isImportNamespaceSpecifier() &&
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier"
        ) {
          found(sdkMethod(file, source, callee.property.name));
        }
      },
    });
  }
  return { calls, limited, sources };
}
