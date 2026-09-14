import { scanAndroid } from "./androidScan";
import { lstat, open, opendir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parsePlist } from "plist";

import type { DoctorCommand } from "../commandTypes";
import type { ProjectConfig } from "../configStore";
import { isRecord } from "../output";
import { discoverIosTargets } from "./iosTargets";
import { inspectJsGraph } from "./jsDiscovery";

export type Platform = "ios" | "android";
export type Resolution = "resolved" | "missing" | "invalid" | "unresolved";
export type Evidence = {
  source: string;
  field?: string;
  state: Resolution;
  reason?: string;
  /** Internal evidence only. Never serialize this object directly to CLI output. */
  value?: string;
};
export type SdkSettings = Record<
  "apiUrl" | "downloadBaseUrl" | "deploymentKey",
  Evidence
>;
export type DiscoveryFinding = {
  severity?: "info";
  platform?: Platform;
  id: string;
  status: "pass" | "fail" | "skip" | "warn";
  reason?: string;
  detail: string;
  sources: string[];
  advice?: string[];
};
export type PlatformDiscovery = {
  platform: Platform;
  intent: "configured" | "not_configured" | "unresolved";
  nativePresent: boolean;
  /** Empty when iOS source selection is unresolved; never borrow another target's version. */
  iosVersionSource?: {
    plistFile?: string;
    xcodeProjectFile?: string;
    xcodeTargetName?: string;
  };
  native?: SdkSettings;
  expo?: SdkSettings;
  /** Only these selectors may be compared with this platform's SDK key. */
  binding: {
    state: "resolved" | "unresolved";
    app?: string;
    appId?: string;
    deployment?: string;
    deploymentId?: string;
  };
  findings: DiscoveryFinding[];
};
export type ProjectDiscovery = {
  platforms: PlatformDiscovery[];
  findings: DiscoveryFinding[];
};
type Document = {
  state: Resolution;
  source: string;
  text?: string;
  reason?: string;
};
type Parsed = {
  state: Resolution;
  source: string;
  data?: Record<string, unknown>;
  reason?: string;
};
const SDK = "@codemagic/react-native-patch";
const FIELDS = {
  apiUrl: "CodemagicPatchApiUrl",
  downloadBaseUrl: "CodemagicPatchDownloadBaseUrl",
  deploymentKey: "CodemagicPatchDeploymentKey",
} as const;
const MAX_BYTES = 1024 * 1024;
const EXCLUDED = new Set([
  "Pods",
  "node_modules",
  ".gradle",
  "build",
  ".git",
  "DerivedData",
]);

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Bounded reads, including explicit paths. No parsing exceptions or file content leak. */
export async function readDoctorSource(source: string): Promise<Document> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stats = await lstat(source);
    if (stats.isSymbolicLink() || !stats.isFile())
      return { source, state: "unresolved", reason: "not_regular_file" };
    if (stats.size > MAX_BYTES)
      return { source, state: "unresolved", reason: "size_limit" };
    handle = await open(source, "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES)
      return { source, state: "unresolved", reason: "size_limit" };
    return {
      source,
      state: "resolved",
      text: buffer.subarray(0, length).toString("utf8"),
    };
  } catch (error) {
    return {
      source,
      state: errorCode(error) === "ENOENT" ? "missing" : "unresolved",
      reason: errorCode(error) === "ENOENT" ? "not_found" : "unreadable",
    };
  } finally {
    await handle?.close();
  }
}

const readSource = readDoctorSource;

async function parseSource(
  source: string,
  kind: "json" | "plist" | "xml",
): Promise<Parsed> {
  const doc = await readSource(source);
  if (doc.state !== "resolved") return doc;
  try {
    let data: unknown;
    if (kind === "json") data = JSON.parse(doc.text!);
    else if (kind === "plist") {
      // plist's XML parser can write malformed input diagnostics to stderr.
      // Reject malformed XML before calling it; report only our sanitized reason.
      if (
        XMLValidator.validate(doc.text!) !== true ||
        !/<plist[\s>]/.test(doc.text!)
      )
        throw new Error("invalid plist");
      data = parsePlist(doc.text!);
    } else {
      if (XMLValidator.validate(doc.text!) !== true)
        throw new Error("invalid XML");
      const parsed: unknown = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: false,
        trimValues: true,
      }).parse(doc.text!);
      if (
        !isRecord(parsed) ||
        (!isRecord(parsed.resources) && parsed.resources !== "")
      )
        throw new Error("missing resources");
      const resources = isRecord(parsed.resources) ? parsed.resources : {};
      const list = (value: unknown): unknown[] =>
        value === undefined ? [] : Array.isArray(value) ? value : [value];
      const nodes = [
        ...list(resources.string),
        ...list(resources.item).filter(
          (node) => isRecord(node) && node["@_type"] === "string",
        ),
      ];
      const strings: Record<string, unknown> = {};
      for (const node of nodes) {
        if (!isRecord(node) || typeof node["@_name"] !== "string") continue;
        if (Object.hasOwn(strings, node["@_name"]))
          throw new Error("duplicate resource");
        strings[node["@_name"]] = node["#text"];
      }
      data = strings;
    }
    if (!isRecord(data)) throw new Error("expected object");
    return { source, state: "resolved", data };
  } catch {
    return { source, state: "invalid", reason: "malformed_document" };
  }
}

function settings(doc: Parsed, native: boolean): SdkSettings {
  return Object.fromEntries(
    Object.entries(FIELDS).map(([name, key]) => {
      const field = native ? key : name;
      const value = doc.data?.[field];
      let state: Resolution = doc.state;
      let reason = doc.reason;
      if (doc.state === "resolved") {
        if (value === undefined) {
          state = "missing";
          reason = "missing_setting";
        } else if (typeof value !== "string" || value.trim() === "") {
          state = "invalid";
          reason = "invalid_setting";
        } else if (/\$\(|\$\{|^@/.test(value)) {
          state = "unresolved";
          reason = "build_time_value";
        } else if (name === "deploymentKey") {
          if (
            /^cm_pat_|^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|BEGIN .*PRIVATE KEY/.test(
              value.trim(),
            )
          ) {
            state = "invalid";
            reason = "credential_in_deployment_key";
          }
        } else {
          try {
            const url = new URL(value);
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password
            )
              throw new Error("invalid URL");
          } catch {
            state = "invalid";
            reason = "invalid_url";
          }
        }
      }
      return [
        name,
        {
          source: doc.source,
          field,
          state,
          reason,
          ...(state === "resolved" && typeof value === "string"
            ? { value: value.trim() }
            : {}),
        },
      ];
    }),
  ) as SdkSettings;
}

type Scan = {
  sourcesLimited?: boolean;
  files: string[];
  limited: boolean;
  present: boolean;
  nativeSources?: string[];
};
/** Platform-specific bounded native discovery. */
async function scan(root: string, platform: Platform): Promise<Scan> {
  let applicationClass = "MainApplication";
  let hostUnknown = false;
  if (platform === "android") {
    // Resolve the application class to a package-relative path when the
    // manifest (fully-qualified name or legacy `package`) or the module's
    // Gradle `namespace` makes it derivable, so the host source is read by
    // path and the bounded walk is only a fallback.
    let packageName: string | undefined;
    let qualifiedName: string | undefined;
    let relativeName = applicationClass;
    const manifest = await readSource(
      path.join(root, "main", "AndroidManifest.xml"),
    );
    if (
      manifest.state === "resolved" &&
      XMLValidator.validate(manifest.text!) === true
    ) {
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(
        manifest.text!,
      );
      const name: unknown = parsed?.manifest?.application?.["@_android:name"];
      const declared: unknown = parsed?.manifest?.["@_package"];
      if (typeof declared === "string" && /^\w+(\.\w+)*$/.test(declared))
        packageName = declared;
      if (typeof name === "string" && /^[.\w]+$/.test(name)) {
        applicationClass = name.split(".").at(-1)!;
        if (/^\w+(\.\w+)+$/.test(name)) qualifiedName = name;
        else relativeName = name.replace(/^\./, "");
      } else if (name !== undefined) hostUnknown = true;
    }
    if (qualifiedName === undefined && packageName === undefined) {
      for (const gradle of ["build.gradle", "build.gradle.kts"]) {
        const doc = await readSource(path.join(root, "..", gradle));
        const match = doc.state === "resolved"
          ? /^\s*namespace\s*(?:=\s*)?["']([\w.]+)["']/m.exec(withoutComments(doc.text!))
          : null;
        if (match) { packageName = match[1]; break; }
      }
    }
    if (qualifiedName === undefined && packageName !== undefined && !hostUnknown)
      qualifiedName = `${packageName}.${relativeName}`;
    const hostPath = qualifiedName?.replace(/\./g, "/");
    return scanAndroid(root, applicationClass, hostUnknown, hostPath);
  }
  const result: Scan = { files: [], limited: false, present: false };
  // The iOS filesystem fallback remains independent of Xcode target discovery.
  const maxDepth = 4;
  let visited = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        result.limited = true;
        return;
      }
      entries = await opendir(dir, { bufferSize: 32 });
      result.present = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") result.limited = true;
      return;
    }
    for await (const entry of entries) {
      if (++visited > 200) {
        result.limited = true;
        return;
      }
      if (EXCLUDED.has(entry.name)) continue;
      if (
        platform === "ios" &&
        /\.(xcodeproj|xcworkspace|xcassets)$/.test(entry.name)
      )
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        result.limited = true;
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= maxDepth) {
          result.limited = true;
          continue;
        }
        await walk(file, depth + 1);
      } else if (
        entry.isFile() &&
        /^(Info\.plist|AppDelegate\.(swift|mm))$/.test(entry.name)
      ) {
        if (result.files.length === 20) {
          result.limited = true;
          continue;
        }
        result.files.push(file);
      }
      if (visited > 200) break;
    }
  }
  await walk(root, 0);
  result.files.sort();
  return result;
}

function finding(
  id: string,
  status: DiscoveryFinding["status"],
  detail: string,
  sources: string[],
  reason?: string,
  advice?: string[],
): DiscoveryFinding {
  return {
    id,
    status,
    detail,
    sources,
    ...(reason ? { reason } : {}),
    ...(advice ? { advice } : {}),
  };
}

function hasPatchKeys(doc: Parsed): boolean {
  return Object.keys(doc.data ?? {}).some((key) =>
    key.startsWith("CodemagicPatch"),
  );
}

/** Merge only the SDK keys, preserving unrelated translations and per-field uncertainty. */
function androidResources(
  documents: Parsed[],
  root: string,
): { doc: Parsed; values: SdkSettings; intent: boolean; uncertain: boolean } {
  const base = documents.filter(
    (doc) =>
      path.dirname(doc.source) === path.join(root, "main", "res", "values"),
  );
  const doc: Parsed = {
    source: base[0]?.source ?? root,
    state: "resolved",
    data: {},
  };
  const values = settings(doc, true);
  let uncertain = documents.some((item) => item.state !== "resolved");
  for (const [name, field] of Object.entries(FIELDS)) {
    const primary = base.filter((item) =>
      Object.hasOwn(item.data ?? {}, field),
    );
    const overrides = documents.filter(
      (item) => !base.includes(item) && Object.hasOwn(item.data ?? {}, field),
    );
    let evidence: Evidence;
    if (documents.some((item) => item.state !== "resolved")) {
      evidence = {
        source: root,
        field,
        state: "unresolved",
        reason: "unreadable_resources",
      };
    } else if (primary.length > 1) {
      evidence = {
        source: primary[0].source,
        field,
        state: "invalid",
        reason: "duplicate_resource",
      };
    } else if (
      overrides.some((item) => item.data?.[field] !== primary[0]?.data?.[field])
    ) {
      evidence = {
        source: overrides[0].source,
        field,
        state: "unresolved",
        reason: "resource_override",
      };
      uncertain = true;
    } else if (primary.length === 1) {
      evidence = settings(primary[0], true)[name as keyof SdkSettings];
    } else {
      evidence = {
        source: root,
        field,
        state: "missing",
        reason: "missing_setting",
      };
    }
    values[name as keyof SdkSettings] = evidence;
  }
  return { doc, values, uncertain, intent: documents.some(hasPatchKeys) };
}

async function nativeSettings(
  root: string,
  platform: Platform,
  command: DoctorCommand,
): Promise<{
  scan: Scan;
  doc: Parsed;
  intent: boolean;
  uncertain: boolean;
  values?: SdkSettings;
  buildInfo?: boolean;
  iosTarget?: { xcodeProjectFile: string; xcodeTargetName: string };
}> {
  const nativeRoot = path.resolve(
    root,
    platform === "ios"
      ? "ios"
      : command.gradleFile
        ? path.join(path.dirname(command.gradleFile), "src")
        : "android/app/src",
  );
  if (platform === "ios") {
    let targetRoot = nativeRoot;
    let targets = await discoverIosTargets(targetRoot, readSource);
    if (!targets.present) {
      targetRoot = path.join(root, "iOS");
      targets = await discoverIosTargets(targetRoot, readSource);
    }
    if (targets.present) {
      const explicit = command.plistFile
        ? path.resolve(root, command.plistFile)
        : undefined;
      const candidates = explicit
        ? targets.targets.filter((t) => t.plist === explicit)
        : targets.targets;
      const selected =
        candidates.length === 1 && !targets.limited ? candidates[0] : undefined;
      const source = explicit ?? selected?.plist;
      const doc: Parsed = source
        ? await parseSource(source, "plist")
        : {
            source: targetRoot,
            state: "unresolved",
            reason: targets.limited ? "discovery_limit" : "ambiguous_target",
          };
      return {
        doc,
        ...(selected ? {
          iosTarget: {
            xcodeProjectFile: selected.project,
            xcodeTargetName: selected.name,
          },
        } : {}),
        intent: hasPatchKeys(doc),
        uncertain: !selected || selected.settingsUnresolved,
        scan: {
          present: true,
          limited: !selected || selected.sourcesUnresolved,
          files: targets.targets.flatMap((t) => (t.plist ? [t.plist] : [])),
          nativeSources: selected?.sources ?? [],
        },
      };
    }
  }
  let scanned = await scan(nativeRoot, platform);
  if (platform === "ios" && !scanned.present && !scanned.limited)
    scanned = await scan(path.join(root, "iOS"), platform);
  const explicit =
    platform === "ios" ? command.plistFile : command.androidStringsFile;
  let customAndroidLayout = false;
  if (platform === "android" && !scanned.present) {
    try {
      const androidRoot = await lstat(path.join(root, "android"));
      if (androidRoot.isDirectory()) {
        scanned.present = true;
        customAndroidLayout = true;
      }
    } catch {
      /* an absent native root is handled as a lifecycle condition */
    }
  }
  const candidates = scanned.files.filter((file) =>
    platform === "ios" ? file.endsWith("Info.plist") : file.endsWith(".xml"),
  );
  const parsed = await Promise.all(
    candidates.map((file) =>
      parseSource(file, platform === "ios" ? "plist" : "xml"),
    ),
  );
  // Test/extension resources cannot establish OTA intent for the app.
  const apps =
    platform === "ios"
      ? parsed.filter(
          (doc) =>
            doc.data?.CFBundlePackageType !== "BNDL" &&
            doc.data?.NSExtension === undefined,
        )
      : parsed;
  const intent = apps.some(hasPatchKeys);
  let gradleUnresolved = false;
  let gradleSelectionUnresolved = false;
  if (platform === "android") {
    for (const file of [
      "android/app/build.gradle",
      "android/app/build.gradle.kts",
      ...(command.gradleFile ? [command.gradleFile] : []),
    ]) {
      const build = await readSource(path.resolve(root, file));
      if (build.state !== "resolved" && build.state !== "missing") {
        gradleUnresolved = true;
        gradleSelectionUnresolved = true;
      }
      if (/\b(productFlavors|sourceSets)\b/.test(withoutComments(build.text ?? "")))
        gradleSelectionUnresolved = true;
      if (
        /\b(resValue|productFlavors|sourceSets|apply\s+from)\b/.test(
          withoutComments(build.text ?? ""),
        )
      )
        gradleUnresolved = true;
    }
  }
  if (platform === "android" && !customAndroidLayout && !scanned.limited) {
    const merged = androidResources(parsed, nativeRoot);
    const values = merged.values;
    // Report source assertions independently of final Gradle evaluation.
    // Only a resValue affecting a setting invalidates that setting's static selection.
    for (const file of [
      "android/app/build.gradle",
      "android/app/build.gradle.kts",
      ...(command.gradleFile ? [command.gradleFile] : []),
    ]) {
      const build = await readSource(path.resolve(root, file));
      const code = withoutComments(build.text ?? "");
      for (const [name, field] of Object.entries(FIELDS)) {
        if (
          new RegExp(`\\bresValue\\s*\\(?[^\\n;{}]*["']${field}["']`).test(code)
        ) {
          values[name as keyof SdkSettings] = {
            source: path.resolve(root, file),
            field,
            state: "unresolved",
            reason: "build_configuration",
          };
        }
      }
    }
    if (gradleUnresolved) {
      for (const evidence of Object.values(values)) {
        if (evidence.state === "missing") {
          evidence.state = "unresolved";
          evidence.reason = "build_configuration";
        }
      }
    }
    if (explicit !== undefined) {
      const doc = await parseSource(path.resolve(root, explicit), "xml");
      return {
        doc,
        scan: scanned,
        intent: intent || hasPatchKeys(doc),
        uncertain: gradleUnresolved || merged.uncertain,
      };
    }
    return {
      doc: merged.doc,
      scan: scanned,
      intent: intent || merged.intent,
      values,
      buildInfo: gradleUnresolved && !gradleSelectionUnresolved && !merged.uncertain &&
        Object.values(values).every((evidence) => evidence.state === "resolved"),
      uncertain: gradleUnresolved || merged.uncertain,
    };
  }
  if (explicit !== undefined) {
    const doc = await parseSource(
      path.resolve(root, explicit),
      platform === "ios" ? "plist" : "xml",
    );
    return {
      scan: scanned,
      doc,
      intent: intent || hasPatchKeys(doc),
      uncertain:
        platform === "android" &&
        (gradleUnresolved || scanned.limited || candidates.length > 1),
    };
  }
  if (
    customAndroidLayout ||
    gradleUnresolved ||
    scanned.limited ||
    apps.length > 1 ||
    (platform === "android" &&
      apps.length === 1 &&
      !apps[0].source.endsWith(
        path.join("main", "res", "values", "strings.xml"),
      ))
  ) {
    return {
      scan: scanned,
      intent,
      uncertain: true,
      doc: {
        source: nativeRoot,
        state: "unresolved",
        reason: customAndroidLayout
          ? "custom_android_layout"
          : scanned.limited
            ? "discovery_limit"
            : gradleUnresolved
              ? "build_configuration"
              : "ambiguous_target",
      },
    };
  }
  return {
    scan: scanned,
    intent,
    uncertain: apps.some((doc) => doc.state !== "resolved"),
    doc: apps[0] ?? {
      source: nativeRoot,
      state: "missing",
      reason: "missing_native_config",
    },
  };
}

async function expoConfig(root: string): Promise<{
  doc: Parsed;
  blocks: Record<string, unknown>;
  dynamic: boolean;
  declared: boolean;
}> {
  const doc = await parseSource(path.join(root, "app.json"), "json");
  const dynamicFiles = await Promise.all(
    ["app.config.js", "app.config.ts"].map((file) =>
      readSource(path.join(root, file)),
    ),
  );
  const dynamic = dynamicFiles.some((file) => file.state !== "missing");
  const config = isRecord(doc.data?.expo) ? doc.data.expo : doc.data;
  const plugins = config?.plugins;
  const entries = Array.isArray(plugins)
    ? plugins.filter(
        (entry) => entry === SDK || (Array.isArray(entry) && entry[0] === SDK),
      )
    : [];
  const entry = entries[0];
  const blocks = Array.isArray(entry) && isRecord(entry[1]) ? entry[1] : {};
  const pluginDoc: Parsed =
    entries.length > 1
      ? { ...doc, state: "unresolved", reason: "duplicate_plugin" }
      : entries.length === 1 &&
          !Object.hasOwn(blocks, "ios") &&
          !Object.hasOwn(blocks, "android")
        ? { ...doc, state: "invalid", reason: "missing_platform_blocks" }
        : doc;
  return { doc: pluginDoc, blocks, dynamic, declared: entries.length > 0 };
}

/** Read-only, local evidence. No remote URL is fetched and project config is never executed. */
export async function discoverDoctorProject(
  command: DoctorCommand,
  config: ProjectConfig,
): Promise<ProjectDiscovery> {
  const root = path.resolve(command.projectRoot);
  const pkg = await parseSource(path.join(root, "package.json"), "json");
  const expo = await expoConfig(root);
  const platforms = command.platform
    ? [command.platform]
    : (["ios", "android"] as const);
  const result: ProjectDiscovery = { platforms: [], findings: [] };
  const dependencies = {
    ...(isRecord(pkg.data?.dependencies) ? pkg.data.dependencies : {}),
    ...(isRecord(pkg.data?.devDependencies) ? pkg.data.devDependencies : {}),
  };
  const recognized =
    Object.hasOwn(dependencies, "react-native") ||
    Object.hasOwn(dependencies, "expo") ||
    Object.hasOwn(dependencies, SDK);
  let installed = false;
  try {
    createRequire(path.join(root, "package.json")).resolve(SDK);
    installed = true;
  } catch {
    /* resolution never executes the package */
  }
  result.findings.push(
    finding(
      "sdk-dependency",
      installed ? "pass" : recognized ? "fail" : "skip",
      installed
        ? "SDK package resolves from this project; native linking is not verified."
        : "SDK package could not be resolved from this project.",
      [pkg.source],
      installed ? undefined : recognized ? "sdk_unavailable" : "unresolved",
      installed
        ? undefined
        : [
            "Check the workspace dependency installation for @codemagic/react-native-patch.",
          ],
    ),
  );
  if (installed && !Object.hasOwn(dependencies, SDK))
    result.findings.push(
      finding(
        "sdk-declaration",
        "warn",
        "The SDK resolves but is not declared directly in this app's dependencies; check workspace ownership.",
        [pkg.source],
        "inherited_dependency",
      ),
    );
  if (pkg.state !== "resolved")
    result.findings.push(
      finding(
        "project-package",
        pkg.state === "invalid" ? "fail" : "skip",
        "Project package metadata could not be inspected.",
        [pkg.source],
        pkg.reason,
      ),
    );
  if (
    expo.dynamic ||
    expo.doc.state === "invalid" ||
    expo.doc.state === "unresolved"
  )
    result.findings.push(
      finding(
        "expo-config",
        "skip",
        "Expo configuration cannot be resolved statically; no project code was executed.",
        [expo.doc.source],
        "unresolved",
      ),
    );
  if (expo.declared && expo.doc.state === "invalid" && !expo.dynamic)
    result.findings.push(
      finding(
        "sdk-expo-plugin",
        "fail",
        "The Patch Expo plugin requires at least one configured platform block.",
        [expo.doc.source],
        "invalid_plugin",
      ),
    );

  for (const platform of platforms) {
    const native = await nativeSettings(root, platform, command);
    const declared = Object.hasOwn(expo.blocks, platform);
    const intended =
      command.platform === platform ||
      config.apps?.[platform] !== undefined ||
      declared ||
      native.intent;
    const uncertain =
      native.uncertain ||
      expo.dynamic ||
      expo.doc.state === "invalid" ||
      expo.doc.state === "unresolved";
    const item: PlatformDiscovery = {
      platform,
      intent: intended
        ? "configured"
        : uncertain
          ? "unresolved"
          : "not_configured",
      nativePresent: native.scan.present,
      ...(platform === "ios" ? {
        iosVersionSource: {
          ...native.iosTarget,
          ...(command.plistFile !== undefined
            ? { plistFile: path.resolve(root, command.plistFile) }
            : native.doc.state === "resolved" && !native.uncertain
              ? { plistFile: native.doc.source }
              : {}),
        },
      } : {}),
      binding: { state: "unresolved" },
      findings: [],
    };
    result.platforms.push(item);
    if (native.doc.state === "unresolved" && native.scan.files.length > 0) {
      item.findings.push(
        finding(
          "sdk-target-candidates",
          "skip",
          "Native target selection is unresolved; inspect these candidate sources.",
          native.scan.files.filter((file) =>
            platform === "ios"
              ? file.endsWith("Info.plist")
              : file.endsWith(".xml"),
          ),
          native.doc.reason,
          [
            platform === "ios"
              ? "Use --platform ios --plist-file <app-plist-path>."
              : "Use --platform android --android-strings-file <resource-path>; merged build values remain unverified.",
          ],
        ),
      );
    }
    if (declared && !expo.dynamic) {
      const data = expo.blocks[platform];
      item.expo = settings(
        {
          source: expo.doc.source,
          state:
            expo.doc.state !== "resolved"
              ? expo.doc.state
              : isRecord(data)
                ? "resolved"
                : "invalid",
          data: isRecord(data) ? data : undefined,
          reason: expo.doc.reason,
        },
        false,
      );
    }
    if (!intended) {
      item.findings.push(
        finding(
          "sdk-platform",
          "skip",
          uncertain
            ? "OTA intent or native target could not be determined."
            : "This platform is not configured for OTA.",
          [native.doc.source],
          uncertain ? "unresolved" : "not_configured",
          uncertain
            ? [
                `Select --platform ${platform} and inspect the app configuration.`,
              ]
            : undefined,
        ),
      );
      continue;
    }
    const prebuildAbsent =
      (platform === "ios" ? command.plistFile : command.androidStringsFile) ===
        undefined &&
      !native.scan.present &&
      (declared || expo.dynamic || Object.hasOwn(dependencies, "expo"));
    if (prebuildAbsent)
      item.findings.push(
        finding(
          "sdk-native",
          "skip",
          "Native resources have not been verified; generate or inspect the native project after prebuild.",
          [native.doc.source],
          "deferred",
        ),
      );
    else item.native = native.values ?? settings(native.doc, true);
    for (const [origin, values] of [
      ["native", item.native],
      ["expo", item.expo],
    ] as const) {
      if (!values) continue;
      for (const [name, evidence] of Object.entries(values)) {
        const status =
          evidence.state === "resolved"
            ? "pass"
            : evidence.state === "unresolved"
              ? "skip"
              : "fail";
        item.findings.push(
          finding(
            `sdk-${origin}-${name}`,
            status,
            `${origin === "native" ? "Native" : "Expo"} ${name}: ${evidence.state}.`,
            [evidence.source],
            evidence.reason,
            status === "pass"
              ? undefined
              : [
                  evidence.state === "unresolved"
                    ? `Inspect ${evidence.field} in the selected configuration; use an explicit file selector when applicable.`
                    : `Configure ${evidence.field} in the selected application source.`,
                ],
          ),
        );
      }
    }
    if (native.uncertain)
      item.findings.push({
        ...finding(
          "sdk-build-selection",
          "skip",
          native.buildInfo
            ? "Patch resource settings were inspected. Final Gradle build values were not evaluated; this is a verification boundary, not a detected configuration problem."
            : "Effective target/build resource selection is not verified.",
          [native.doc.source],
          native.buildInfo ? "build_not_evaluated" : "unresolved",
        ),
        ...(native.buildInfo ? { severity: "info" as const } : {}),
      });
    if (expo.declared && !declared && !expo.dynamic)
      item.findings.push(
        finding(
          "sdk-expo-platform",
          "warn",
          "No plugin block exists for this selected platform; inspect manual integration or add its plugin settings.",
          [expo.doc.source],
          "unresolved",
        ),
      );
    if (item.native && item.expo) {
      const different = (
        Object.keys(FIELDS) as Array<keyof SdkSettings>
      ).filter(
        (key) =>
          item.native![key].state === "resolved" &&
          item.expo![key].state === "resolved" &&
          item.native![key].value !== item.expo![key].value,
      );
      if (different.length)
        item.findings.push(
          finding(
            "sdk-config-drift",
            "warn",
            `Plugin and generated resources differ for ${different.join(", ")}; the build's effective values are unresolved.`,
            [native.doc.source, expo.doc.source],
            "unresolved",
            [
              "Regenerate or reconcile native resources deliberately; local prebuild files may be stale.",
            ],
          ),
        );
    }
    item.findings.push(
      await inspectNativeIntegration(
        native.scan,
        platform,
        native.doc.source,
        prebuildAbsent,
      ),
    );
  }
  bindPlatforms(result.platforms, command, config);
  if (!result.platforms.some((item) => item.intent === "configured"))
    result.findings.push(
      finding(
        "sdk-ota-intent",
        "skip",
        "No OTA platform could be selected with confidence.",
        [root],
        "unresolved",
        [
          "Configure the intended platform or pass --platform ios or --platform android.",
        ],
      ),
    );
  const configured = result.platforms
    .filter((item) => item.intent === "configured")
    .map((item) => item.platform);
  for (const platform of configured.length ? configured : platforms) {
    result.findings.push({
      ...(await inspectJsGraph(root, pkg.data?.main, [platform], readSource)),
      platform,
    });
  }
  return result;
}

export function bindPlatforms(
  platforms: PlatformDiscovery[],
  command: DoctorCommand,
  config: ProjectConfig,
): void {
  const intended = platforms.filter((item) => item.intent === "configured");
  const single =
    command.platform !== undefined ||
    (intended.length === 1 &&
      platforms.every((item) => item.intent !== "unresolved"));
  for (const item of intended) {
    const mapping = config.apps?.[item.platform];
    const hasGlobalApp =
      command.app !== undefined || command.appId !== undefined;
    const globalId =
      command.deploymentId !== undefined || command.deploymentKey !== undefined;
    if (!single && (hasGlobalApp || globalId)) {
      item.binding = { state: "unresolved" };
    } else {
      const appSelector =
        single && hasGlobalApp
          ? { app: command.app, appId: command.appId }
          : (mapping ?? (single ? config : {}));
      const app = appSelector.app;
      const appId = appSelector.appId;
      const deploymentId = single ? command.deploymentId : undefined;
      const deployment = deploymentId
        ? undefined
        : (command.deployment ??
          mapping?.deployment ??
          (single ? config.deployment : undefined));
      item.binding = {
        state:
          (app !== undefined || appId !== undefined) &&
          !(app !== undefined && appId !== undefined) &&
          (deployment !== undefined || deploymentId !== undefined)
            ? "resolved"
            : "unresolved",
        ...(app ? { app } : {}),
        ...(appId ? { appId } : {}),
        ...(deployment ? { deployment } : {}),
        ...(deploymentId ? { deploymentId } : {}),
      };
    }
    if (item.binding.state === "unresolved")
      item.findings.push(
        finding(
          "sdk-platform-binding",
          "skip",
          "App/deployment selectors are not bound to this platform; key comparison is not safe yet.",
          [],
          "unresolved",
          [
            `Select --platform ${item.platform} with its app/deployment, or configure apps.${item.platform}.`,
          ],
        ),
      );
  }
}

function withoutComments(text: string): string {
  // Preserve string literals so comment markers in URLs cannot erase source.
  return text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal: string | undefined) => literal ?? " ",
  );
}

function withoutLiterals(text: string): string {
  return withoutComments(text).replace(
    /"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (literal) => " ".repeat(literal.length),
  );
}

async function inspectNativeIntegration(
  scanResult: Scan,
  platform: Platform,
  configSource: string,
  deferred: boolean,
): Promise<DiscoveryFinding> {
  if (deferred)
    return finding(
      "sdk-native-hook",
      "skip",
      "Native bundle selection awaits generated source.",
      [configSource],
      "deferred",
    );
  const candidates =
    scanResult.nativeSources ??
    scanResult.files.filter((file) =>
      platform === "ios"
        ? /AppDelegate\.(swift|mm)$/.test(file) &&
          path.dirname(file) === path.dirname(configSource)
        : /MainApplication\.(kt|java)$/.test(file),
    );
  if (
    (scanResult.sourcesLimited ?? scanResult.limited) ||
    candidates.length === 0 ||
    (!scanResult.nativeSources && candidates.length !== 1)
  )
    return finding(
      "sdk-native-hook",
      "skip",
      "Native bundle-selection source is ambiguous or outside the bounded scan.",
      candidates,
      "unresolved",
    );
  const docs = await Promise.all(candidates.map(readSource));
  const text = docs.map((doc) => withoutLiterals(doc.text ?? "")).join("\n");
  const signal =
    platform === "ios"
      ? /CodemagicPatch\s*\.\s*bundleURL\s*\(|\[CodemagicPatch\s+bundleURL\]/.test(
          text,
        )
      : /CodemagicPatch\s*\.\s*getJSBundleFile\s*\(/.test(text);
  const embeddedOnly =
    platform === "ios"
      ? /override\s+func\s+bundleURL\s*\(\s*\)\s*->\s*URL\?\s*\{[^{}]*#else\s*(?:return\s+)?Bundle\.main\.url\([^)]*\)\s*#endif\s*\}/.test(
          text,
        )
      : /override\s+fun\s+getJSBundleFile\s*\(\s*\)\s*:\s*String\?\s*=\s*null(?!\s*(?:\?:|\?\.))[ \t]*(?:\r?\n|;|$)/.test(
          text,
        );
  if (!signal && embeddedOnly && docs.every((doc) => doc.state === "resolved"))
    return finding(
      "sdk-native-hook",
      "fail",
      "The inspected native bundle-selection hook uses only the embedded bundle rather than the Patch SDK.",
      candidates,
      "missing_bundle_hook",
      ["Wire the SDK bundle-selection hook in this app target."],
    );
  return finding(
    "sdk-native-hook",
    signal ? "pass" : "skip",
    signal
      ? "SDK bundle-selection source signal found; built linkage and runtime execution are not verified."
      : "Supported native bundle-selection flow could not be established statically.",
    candidates,
    signal ? undefined : "unresolved",
    signal
      ? undefined
      : [
          "Inspect the selected app delegate/host using the SDK integration instructions.",
        ],
  );
}
