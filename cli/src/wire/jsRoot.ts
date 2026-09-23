// `Patch.wrap(App)` at the JavaScript root: finding the root component
// behind the registered entry, and changing its default export so mounting
// it runs the SDK's update check. Bounded on purpose — one recognised entry
// shape, one recognised export shape — with everything else handed to the
// developer together with the reason.

import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import type * as t from "@babel/types";

import { EXPO_ROUTER_LAYOUTS, moduleCandidates, walkJsGraph, type JsGraphCall } from "../doctor/jsDiscovery";
import type { NativePlatform } from "../projectAnalysis";
import { isFile, readTextFile } from "./fs";
import { SDK_PACKAGE } from "./project";

const traverse =
  typeof traverseModule === "function"
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default;

const STARTUP_METHODS = new Set(["sync", "checkForUpdate", "notifyAppReady"]);

/**
 * Where an entry hands its root to React Native, for the cases where the
 * wrapper belongs at that call rather than at a default export: a locally
 * declared or non-default-imported component, an expression, or more than
 * one registration.
 */
export type JsRegistrationSite = {
  file: string;
  api: "registerComponent" | "registerRootComponent";
  /** The first `registerComponent` argument, when it is a string literal. */
  appName?: string;
  /** The registered identifier, when exactly one was registered. */
  component?: string;
};

export type JsRootResolution =
  | { kind: "resolved"; file: string; via: string }
  | { kind: "unresolved"; reason: string; registration?: JsRegistrationSite };

/**
 * The module whose default export is the app's root component, for one
 * platform (platform-specific files such as `App.ios.tsx` resolve here).
 * Files are returned by real path so a root shared by both platforms
 * compares equal however it was reached.
 */
export async function resolveJsRoot(
  root: string,
  main: unknown,
  platform: NativePlatform,
): Promise<JsRootResolution> {
  const resolve = (base: string) => resolveModule(root, base, platform);
  if (main === "expo-router/entry") {
    for (const layout of EXPO_ROUTER_LAYOUTS) {
      const file = await resolve(path.join(root, layout));
      if (file !== null) return followRegistration(file, resolve, 0, false);
    }
    return { kind: "unresolved", reason: "expo-router is the entry but no src/app/_layout or app/_layout was found" };
  }
  if (typeof main === "string" && /(^|\/)expo\/AppEntry(\.js)?$/.test(main)) {
    const file = await resolve(path.join(root, "App"));
    return file === null
      ? { kind: "unresolved", reason: "expo/AppEntry is the entry but no App module was found" }
      : followRegistration(file, resolve, 0, false);
  }
  const entry =
    typeof main === "string" && main.length > 0
      ? await resolve(path.resolve(root, main))
      : (await resolve(path.join(root, "index"))) ?? (await resolve(path.join(root, "App")));
  if (entry === null) {
    return { kind: "unresolved", reason: "no entry module (package.json main, index or App) was found" };
  }
  return followRegistration(entry, resolve, 0);
}

/**
 * From an entry module to the root component's module: through
 * `AppRegistry.registerComponent(name, () => App)` or
 * `registerRootComponent(App)`, then through plain default re-exports.
 */
async function followRegistration(
  file: string,
  resolve: (base: string) => Promise<string | null>,
  depth: number,
  inspectRegistration = true,
  visited = new Set<string>(),
): Promise<JsRootResolution> {
  if (visited.has(file) || depth > 4) {
    return { kind: "unresolved", reason: `${path.basename(file)} has a cyclic or too-deep default re-export chain` };
  }
  visited.add(file);
  const text = await readTextFile(file);
  const ast = text === null ? null : parseModule(text, file);
  if (ast === null) {
    return { kind: "unresolved", reason: `${file} could not be parsed` };
  }
  const name = path.basename(file);
  const registered = new Set<string>();
  let site: JsRegistrationSite | undefined;
  let unfollowed = false;
  let reexported: string | undefined;
  let hasDefaultExport = false;
  traverse(ast, {
    CallExpression(p) {
      if (!inspectRegistration) return;
      const callee = p.node.callee;
      const isRegistration =
        (callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "AppRegistry" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "registerComponent") ||
        (callee.type === "Identifier" && callee.name === "registerRootComponent");
      if (!isRegistration) return;
      if (site === undefined) {
        const appName = p.node.arguments[0];
        site = {
          file,
          api: callee.type === "Identifier" ? "registerRootComponent" : "registerComponent",
          ...(callee.type !== "Identifier" && appName?.type === "StringLiteral" ? { appName: appName.value } : {}),
        };
      }
      const argument = callee.type === "Identifier" ? p.node.arguments[0] : p.node.arguments[1];
      const component =
        argument?.type === "Identifier"
          ? argument
          : argument?.type === "ArrowFunctionExpression" && argument.body.type === "Identifier"
            ? argument.body
            : undefined;
      if (component === undefined) unfollowed = true;
      else registered.add(component.name);
    },
    ExportDefaultDeclaration() {
      hasDefaultExport = true;
    },
    ExportNamedDeclaration(p) {
      const source = p.node.source?.value;
      if (
        source !== undefined &&
        p.node.specifiers.some(
          (item) =>
            item.type === "ExportSpecifier" &&
            item.local.name === "default" &&
            item.exported.type === "Identifier" &&
            item.exported.name === "default",
        )
      ) {
        reexported = source;
      }
    },
  });
  if (registered.size > 1) {
    return { kind: "unresolved", reason: `${name} registers more than one component: ${[...registered].join(", ")}`, registration: site };
  }
  const [component] = registered;
  if (component !== undefined && site !== undefined) {
    const registration = { ...site, component };
    const imported = importSource(ast, component);
    if (imported === undefined || !imported.isDefault) {
      return { kind: "unresolved", reason: `${name} registers ${component}, which is not a default import; wrap the registered component manually`, registration };
    }
    const source = imported.source;
    const target = source.startsWith(".")
      ? await resolve(path.resolve(path.dirname(file), source))
      : null;
    return target === null
      ? { kind: "unresolved", reason: `the registered component is imported from ${source}, which was not resolved`, registration }
      : followRegistration(target, resolve, depth + 1, false, visited);
  }
  if (unfollowed) {
    return { kind: "unresolved", reason: `${name} registers an expression this tool does not follow`, registration: site };
  }
  if (reexported !== undefined) {
    const target = reexported.startsWith(".")
      ? await resolve(path.resolve(path.dirname(file), reexported))
      : null;
    return target === null
      ? { kind: "unresolved", reason: `${name} re-exports its default from ${reexported}, which was not resolved` }
      : followRegistration(target, resolve, depth + 1, false, visited);
  }
  if (hasDefaultExport) {
    return { kind: "resolved", file, via: `default export of ${name}` };
  }
  return { kind: "unresolved", reason: `${name} neither registers a root component nor exports one` };
}

function importSource(ast: t.File, name: string): { source: string; isDefault: boolean } | undefined {
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
    const specifier = statement.specifiers.find((item) => item.local.name === name);
    if (specifier !== undefined) {
      return {
        source: statement.source.value,
        isDefault: specifier.type === "ImportDefaultSpecifier" ||
          (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" &&
            (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value) === "default"),
      };
    }
  }
  return undefined;
}

/** A file under the project root, by real path, or null. */
async function resolveModule(
  root: string,
  base: string,
  platform: NativePlatform,
): Promise<string | null> {
  for (const candidate of moduleCandidates(base, platform)) {
    if (!(await isFile(candidate))) continue;
    const actual = await realpath(candidate);
    const relative = path.relative(await realpath(root), actual);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return actual;
  }
  return null;
}

// --- The rest of the app ---------------------------------------------------

export type GraphCalls = {
  /** `sync()` / `notifyAppReady()` / `checkForUpdate()` the developer placed themselves, anywhere the entry reaches. */
  startup: JsGraphCall[];
  /** `wrap()` applied somewhere the root transform did not see. */
  wrap: JsGraphCall[];
  /** The walk hit a bound or an unreadable module, so an empty result proves nothing. */
  limited: boolean;
};

/**
 * SDK calls in the entry's bounded local import graph for the platforms a
 * root serves — the same walk and bounds as doctor's `sdk-update-flow`
 * check. A startup call after the app's own bootstrap (`index.js` →
 * `startup.ts`) is not visible from the root module, and wrapping the root
 * would acknowledge readiness before it. Files are real paths.
 */
export async function inspectGraphCalls(
  root: string,
  main: unknown,
  platforms: readonly NativePlatform[],
): Promise<GraphCalls> {
  const result: GraphCalls = { startup: [], wrap: [], limited: false };
  // Any call the walk could find sits in a module that names the SDK package,
  // so a project whose sources never mention it has nothing to preserve, and
  // the walk's bounds (module count, depth, size) must not turn that into an
  // "incomplete" verdict on an ordinary-sized app.
  if (!(await sourcesMentionSdk(root))) return result;
  const read = async (file: string) => {
    const text = await readTextFile(file);
    return text === null ? { state: "missing" } : { state: "resolved", text };
  };
  const seen = new Set<string>();
  for (const platform of platforms) {
    const walk = await walkJsGraph(root, main, platform, read);
    if (walk.limited) result.limited = true;
    for (const call of walk.calls) {
      if (seen.has(`${call.file}:${call.method}`)) continue;
      seen.add(`${call.file}:${call.method}`);
      (STARTUP_METHODS.has(call.method) ? result.startup : result.wrap).push(call);
    }
  }
  return result;
}

/** Top-level directories the graph walk cannot reach an app source through. */
const SCAN_SKIPPED_ROOT_DIRECTORIES = new Set(["ios", "android", "build", "dist", "coverage", "Pods"]);
const SCAN_FILE_LIMIT = 20_000;

/**
 * Whether any JavaScript/TypeScript source under `root` that the graph walk
 * could reach contains the SDK package name. The walk excludes only
 * `node_modules`, so this skips `node_modules` and dot-directories at any
 * depth but native trees and build output only directly under `root`: a
 * nested `src/android/` or `packages/*\/dist/` is ordinary importable source.
 * Symlinks are not followed. A tree too large to scan counts as a mention, so
 * the bounded walk keeps the final say there.
 */
export async function sourcesMentionSdk(root: string): Promise<boolean> {
  const queue = [root];
  let scanned = 0;
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skipped =
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          (dir === root && SCAN_SKIPPED_ROOT_DIRECTORIES.has(entry.name));
        if (!skipped) queue.push(file);
        continue;
      }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      if ((scanned += 1) > SCAN_FILE_LIMIT) return true;
      const text = await readTextFile(file);
      if (text !== null && text.includes(SDK_PACKAGE)) return true;
    }
  }
  return false;
}

// --- The root module -------------------------------------------------------

export type RootTransform =
  | { kind: "changed"; contents: string }
  | { kind: "already-configured" }
  /** A startup call the developer wrote themselves; wrapping would duplicate it. */
  | { kind: "existing-integration"; detail: string }
  | { kind: "manual"; reason: string; exportExpression?: string };

export function transformJsRoot(contents: string, file: string): RootTransform {
  const ast = parseModule(contents, file);
  if (ast === null) return { kind: "manual", reason: `${path.basename(file)} could not be parsed` };

  const sdk = sdkBindings(ast);
  const exportDefault = ast.program.body.find(
    (statement): statement is t.ExportDefaultDeclaration =>
      statement.type === "ExportDefaultDeclaration",
  );
  if (exportDefault === undefined) {
    return { kind: "manual", reason: "no `export default` found; wrap the component you register" };
  }
  const declaration = exportDefault.declaration;

  if (declaration.type === "CallExpression") {
    const callee = declaration.callee;
    if (isSdkWrap(declaration, sdk)) return { kind: "already-configured" };
    return {
      kind: "manual",
      exportExpression: contents.slice(declaration.start!, declaration.end!),
      reason: `the default export is already wrapped by ${contents.slice(callee.start!, callee.end!)}(); add Patch.wrap around the component yourself`,
    };
  }

  const { startupCall, bound } = inspectModule(ast, sdk);
  if (startupCall !== undefined) {
    return { kind: "existing-integration", detail: startupCall };
  }

  const wrapName = wrapReference(sdk, bound);
  if (wrapName === null) {
    return { kind: "manual", reason: "both `Patch` and `CodemagicPatch` are already bound in the module" };
  }
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const semicolon = usesSemicolons(contents) ? ";" : "";
  const edits: Array<{ start: number; end: number; text: string }> = [];
  if (declaration.type === "Identifier") {
    edits.push({ start: declaration.start!, end: declaration.end!, text: `${wrapName.reference}(${declaration.name})` });
  } else if (
    (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
    declaration.id != null &&
    declaration.start! >= exportDefault.start! &&
    !(declaration.type === "ClassDeclaration" && (declaration.decorators?.length ?? 0) > 0)
  ) {
    edits.push({ start: exportDefault.start!, end: declaration.start!, text: "" });
    edits.push({
      start: declaration.end!,
      end: declaration.end!,
      text: `${eol}${eol}export default ${wrapName.reference}(${declaration.id.name})${semicolon}`,
    });
  } else {
    return {
      kind: "manual",
      reason: "the default export is not a plain named component; export the component through Patch.wrap yourself",
    };
  }
  if (wrapName.importName !== undefined) {
    edits.push(importEdit(ast, contents, wrapName.importName, eol, semicolon));
  }
  edits.sort((a, b) => b.start - a.start);
  let edited = contents;
  for (const edit of edits) {
    edited = `${edited.slice(0, edit.start)}${edit.text}${edited.slice(edit.end)}`;
  }
  const verified = parseModule(edited, file);
  const exported = verified?.program.body.find((node) => node.type === "ExportDefaultDeclaration");
  if (verified === null || exported?.type !== "ExportDefaultDeclaration" || !isSdkWrap(exported.declaration, sdkBindings(verified))) {
    return { kind: "manual", reason: "the generated SDK import and wrapped export could not be verified; the source was left unchanged" };
  }
  return { kind: "changed", contents: edited };
}

type SdkBindings = {
  /** Local names bound to the whole module (`import * as Patch`, `const Patch = require(...)`). */
  namespaces: Set<string>;
  /** Local name → exported name for named imports. */
  named: Map<string, string>;
};

function isSdkWrap(node: t.Node, sdk: SdkBindings): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  return (callee.type === "Identifier" && sdk.named.get(callee.name) === "wrap") ||
    (callee.type === "MemberExpression" && !callee.computed &&
      callee.object.type === "Identifier" && sdk.namespaces.has(callee.object.name) &&
      callee.property.type === "Identifier" && callee.property.name === "wrap");
}

function sdkBindings(ast: t.File): SdkBindings {
  const bindings: SdkBindings = { namespaces: new Set(), named: new Map() };
  for (const statement of ast.program.body) {
    if (
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type" &&
      statement.source.value === SDK_PACKAGE
    ) {
      for (const item of statement.specifiers) {
        if (item.type === "ImportNamespaceSpecifier") bindings.namespaces.add(item.local.name);
        if (item.type === "ImportSpecifier" && item.importKind !== "type") {
          bindings.named.set(
            item.local.name,
            item.imported.type === "Identifier" ? item.imported.name : item.imported.value,
          );
        }
      }
    }
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        const init = declarator.init;
        if (
          init?.type !== "CallExpression" ||
          init.callee.type !== "Identifier" ||
          init.callee.name !== "require" ||
          init.arguments[0]?.type !== "StringLiteral" ||
          init.arguments[0].value !== SDK_PACKAGE
        ) {
          continue;
        }
        if (declarator.id.type === "Identifier") bindings.namespaces.add(declarator.id.name);
        if (declarator.id.type === "ObjectPattern") {
          for (const property of declarator.id.properties) {
            if (
              property.type === "ObjectProperty" &&
              property.key.type === "Identifier" &&
              property.value.type === "Identifier"
            ) {
              bindings.named.set(property.value.name, property.key.name);
            }
          }
        }
      }
    }
  }
  return bindings;
}

/**
 * One pass over the module: a `sync()` / `notifyAppReady()` /
 * `checkForUpdate()` call bound to the SDK at module level, and every name
 * bound at module level (values and TypeScript types alike) that a fresh
 * import must not collide with.
 */
function inspectModule(
  ast: t.File,
  sdk: SdkBindings,
): { startupCall?: string; bound: Set<string> } {
  const bound = new Set<string>();
  let startupCall: string | undefined;
  traverse(ast, {
    Program(p) {
      for (const name of Object.keys(p.scope.bindings)) bound.add(name);
      for (const statement of p.node.body) {
        const declaration =
          statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
        if (
          declaration?.type === "TSInterfaceDeclaration" ||
          declaration?.type === "TSTypeAliasDeclaration" ||
          declaration?.type === "TSEnumDeclaration"
        ) {
          bound.add(declaration.id.name);
        }
      }
    },
    CallExpression(p) {
      if (startupCall !== undefined) return;
      const callee = p.node.callee;
      const object =
        callee.type === "Identifier"
          ? callee
          : callee.type === "MemberExpression" && callee.object.type === "Identifier"
            ? callee.object
            : undefined;
      if (object === undefined) return;
      // Only the module-level binding is the SDK's; a same-named local is not.
      if (p.scope.getBinding(object.name)?.scope.block.type !== "Program") return;
      if (callee.type === "Identifier") {
        const exported = sdk.named.get(callee.name);
        if (exported !== undefined && STARTUP_METHODS.has(exported)) startupCall = `${exported}()`;
      } else if (
        callee.type === "MemberExpression" &&
        sdk.namespaces.has(object.name) &&
        callee.property.type === "Identifier" &&
        STARTUP_METHODS.has(callee.property.name)
      ) {
        startupCall = `${object.name}.${callee.property.name}()`;
      }
    },
  });
  return { ...(startupCall !== undefined ? { startupCall } : {}), bound };
}

/**
 * How to spell the wrapper in this module: an existing SDK binding when
 * there is one, otherwise a fresh namespace import under a name nothing
 * else in the module uses.
 */
function wrapReference(
  sdk: SdkBindings,
  bound: Set<string>,
): { reference: string; importName?: string } | null {
  const namespace = [...sdk.namespaces][0];
  if (namespace !== undefined) return { reference: `${namespace}.wrap` };
  for (const [local, exported] of sdk.named) {
    if (exported === "wrap") return { reference: local };
  }
  const name = ["Patch", "CodemagicPatch"].find((candidate) => !bound.has(candidate));
  return name === undefined ? null : { reference: `${name}.wrap`, importName: name };
}

/** The namespace import, on its own line after the last import (or at the top). */
function importEdit(
  ast: t.File,
  contents: string,
  name: string,
  eol: string,
  semicolon: string,
): { start: number; end: number; text: string } {
  const imports = ast.program.body.filter(
    (statement): statement is t.ImportDeclaration => statement.type === "ImportDeclaration",
  );
  const last = imports[imports.length - 1];
  const quote = last?.source.extra?.raw?.toString().startsWith("'") ? "'" : '"';
  const line = `import * as ${name} from ${quote}${SDK_PACKAGE}${quote}${semicolon}`;
  if (last === undefined) {
    const preamble = /^(?:#![^\n]*\n)?(?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)\s*)*(?:['"]use strict['"];?\s*)?/.exec(contents);
    const offset = preamble?.[0].length ?? 0;
    return { start: offset, end: offset, text: `${line}${eol}` };
  }
  const at = last.end!;
  // Insert at the AST boundary, before any trailing comment can span lines.
  const suffix = /^[ \t]*\r?\n/.test(contents.slice(at)) ? "" : eol;
  return { start: at, end: at, text: `${eol}${line}${suffix}` };
}

function usesSemicolons(contents: string): boolean {
  return /^\s*import\b[^\n]*;\s*$/m.test(contents) || /;\s*$/m.test(contents);
}

function parseModule(text: string, file: string): t.File | null {
  try {
    return parse(text, {
      sourceType: "unambiguous",
      plugins: ["jsx", /\.[cm]?tsx?$/.test(file) ? "typescript" : "flow", "decorators-legacy"],
    });
  } catch {
    return null;
  }
}
