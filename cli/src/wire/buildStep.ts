// The "Codemagic Patch build metadata" step (client/specs/build-integration/Spec.md):
// an Xcode run-script phase and a Gradle line whose text the installed SDK
// defines in build-tools/native/build-integration.json. Wire never carries its
// own copy.
// Both files are edited as text, so every byte outside the step stays as it
// was; the parsed project is only used to find where the step goes.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "../output";
import { parseXcodeProject, unquoteXcode, xcodeRefs } from "../xcodeProject";

export type BuildIntegration = {
  ios: {
    phaseName: string;
    targetProductType: string;
    afterPhaseName: string;
    shellPath: string;
    /** The phase script, with `{{integration}}` standing for `rn` or `expo`. */
    shellScript: string;
    inputPaths: string[];
    outputPaths: string[];
    alwaysOutOfDate: number;
  };
  android: { groovy: string; kotlin: string };
};

/** The build step name of build-metadata §1, for messages written before any definition is loaded. */
export const BUILD_STEP_NAME = "Codemagic Patch build metadata";
/** The bundle phase the step runs after and the target type it goes into, for the same use. */
export const BUNDLE_PHASE_NAME = "Bundle React Native code and images";
/**
 * Said wherever cmpatch proposes the edit: the step's text is in a hashed
 * native file, so a release to a binary built before the edit would no longer
 * match that binary's fingerprint.
 */
export const BUILD_STEP_EDIT_NOTE = "The edit changes the native fingerprint, so ship it with the next store build.";
const APPLICATION_PRODUCT_TYPE = "com.apple.product-type.application";

export type BuildIntegrationLookup =
  | { kind: "available"; definition: BuildIntegration }
  /**
   * `predates`: the installed SDK does not define the step at all (a registry
   * release before MIN_BUILD_METADATA_SDK_VERSION, or a package without the
   * definition file), as opposed to one this cmpatch cannot read.
   */
  | { kind: "unavailable"; reason: string; predates?: true };

/** Where the SDK package keeps the definition, the directory the inserted text also names. */
const DEFINITION_FILE = "build-tools/native/build-integration.json";
/** The definition format this cmpatch reads (the file's `formatVersion`). */
const DEFINITION_FORMAT = 1;
const INTEGRATION_PLACEHOLDER = "{{integration}}";

/** The phase script `ios` defines for a project of `integration`. */
function phaseScript(ios: BuildIntegration["ios"], integration: "rn" | "expo"): string {
  return ios.shellScript.replaceAll(INTEGRATION_PLACEHOLDER, integration);
}

/** The build metadata step definition of the SDK package at `packageRoot`, read from its file. */
export function loadBuildIntegration(packageRoot: string, sdkLabel: string): BuildIntegrationLookup {
  let definition: unknown;
  try {
    definition = JSON.parse(readFileSync(path.join(packageRoot, DEFINITION_FILE), "utf8"));
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT"
      ? { kind: "unavailable", reason: `${sdkLabel} does not define the build metadata step (no ${DEFINITION_FILE})`, predates: true }
      : { kind: "unavailable", reason: `the build metadata step definition of ${sdkLabel} could not be read: ${firstLine(error)}` };
  }
  if (!isRecord(definition) || definition.formatVersion !== DEFINITION_FORMAT) {
    const format = isRecord(definition) ? String(definition.formatVersion) : "unknown";
    return {
      kind: "unavailable",
      reason: `${sdkLabel} defines the build metadata step in format ${format}; this cmpatch reads format ${DEFINITION_FORMAT}. Update cmpatch`,
    };
  }
  return isBuildIntegration(definition)
    ? { kind: "available", definition }
    : { kind: "unavailable", reason: `${sdkLabel} has a build metadata step definition this cmpatch cannot read. Update cmpatch` };
}

function isBuildIntegration(value: unknown): value is BuildIntegration {
  if (!isRecord(value) || !isRecord(value.ios) || !isRecord(value.android)) return false;
  const { ios, android } = value;
  const strings = (record: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof record[key] === "string");
  const list = (item: unknown) => Array.isArray(item) && item.every((entry) => typeof entry === "string");
  return (
    strings(ios, ["phaseName", "targetProductType", "afterPhaseName", "shellPath", "shellScript"]) &&
    (ios.shellScript as string).includes(INTEGRATION_PLACEHOLDER) &&
    list(ios.inputPaths) && list(ios.outputPaths) && typeof ios.alwaysOutOfDate === "number" &&
    strings(android, ["groovy", "kotlin"])
  );
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
}

/** What the project carries now, and the file with the step in place when wire can put it there. */
export type BuildStepFinding =
  /** `targets` (iOS): the application targets the edit touches. */
  | { kind: "absent"; contents: string; targets?: string[] }
  | { kind: "current" }
  | { kind: "outdated"; contents: string; targets?: string[] }
  | { kind: "conflict"; reason: string; manual: string[] };

// --- Xcode ------------------------------------------------------------------

/** The bundle phase's script tells which integration's environment the phase must apply. */
function bundleIntegration(script: string): "expo" | "rn" | undefined {
  const expoMarkers = [
    script.includes(".xcode.env.updates"),
    script.includes("expo/scripts/resolveAppEntry"),
    script.includes("export:embed"),
    /\*Debug\*[\s\S]*SKIP_BUNDLING=1/.test(script),
  ];
  if (expoMarkers.every(Boolean)) return "expo";
  if (expoMarkers.some(Boolean)) return undefined;
  return script.includes("react-native-xcode.sh") ? "rn" : undefined;
}

type ParsedXcodeProject = ReturnType<typeof parseXcodeProject>;

/** The application targets of the project, in project order, with their build phase ids. */
function applicationTargets(
  parsed: ParsedXcodeProject,
  productType: string,
): Array<{ id: string; name: string; phaseIds: string[] }> {
  return xcodeRefs(parsed.project.targets).flatMap((id) => {
    const target = parsed.record("PBXNativeTarget", id);
    return unquoteXcode(target.productType) === productType
      ? [{ id, name: unquoteXcode(target.name), phaseIds: xcodeRefs(target.buildPhases) }]
      : [];
  });
}

function shellPhaseName(parsed: ParsedXcodeProject, id: string): string {
  return decodePbx(parsed.record("PBXShellScriptBuildPhase", id).name);
}

/**
 * The step goes into every application target that bundles JS, which is one
 * that has a phase named `afterPhaseName`. An application target without that
 * phase (a watch or companion app) is left alone.
 */
function inspectXcodeBuildStep(text: string, ios: BuildIntegration["ios"]): BuildStepFinding {
  const conflict = (reason: string, manual: string[]): BuildStepFinding => ({ kind: "conflict", reason, manual });
  let parsed: ParsedXcodeProject;
  try {
    parsed = parseXcodeProject(text);
  } catch {
    return conflict("the Xcode project could not be parsed", [`Add the "${ios.phaseName}" phase yourself, or fix the project and run \`cmpatch wire\` again.`]);
  }
  const shell = (id: string) => parsed.record("PBXShellScriptBuildPhase", id);
  const nameOf = (id: string) => shellPhaseName(parsed, id);
  const targets = applicationTargets(parsed, ios.targetProductType)
    .map((target) => ({
      ...target,
      bundles: target.phaseIds.filter((id) => nameOf(id) === ios.afterPhaseName),
      ours: target.phaseIds.filter((id) => nameOf(id) === ios.phaseName),
    }))
    .filter((target) => target.bundles.length > 0);
  if (targets.length === 0) {
    return conflict(
      `no application target has a "${ios.afterPhaseName}" phase, which the build metadata phase runs after`,
      [`Restore that phase and run \`cmpatch wire\` again, or add a "${ios.phaseName}" run-script phase directly after it yourself.`],
    );
  }

  const placed = targets.flatMap((target) => target.ours);
  const shellPhases = isRecord(parsed.objects.PBXShellScriptBuildPhase) ? parsed.objects.PBXShellScriptBuildPhase : {};
  const elsewhere = Object.keys(shellPhases).filter(
    (id) => !id.endsWith("_comment") && nameOf(id) === ios.phaseName && !placed.includes(id),
  );
  if (elsewhere.length > 0) {
    return conflict(
      `a "${ios.phaseName}" phase exists outside the build phases of the application targets that have a "${ios.afterPhaseName}" phase`,
      [`Remove that "${ios.phaseName}" phase in Xcode, then run \`cmpatch wire\` again.`],
    );
  }

  // One edit per target that needs one, applied in order to the text the previous edit left.
  const edits: Array<{ kind: "absent" | "outdated"; target: string; apply: (current: string) => string | null; failure: BuildStepFinding }> = [];
  for (const target of targets) {
    const position = `directly after "${ios.afterPhaseName}" in the ${target.name} target`;
    if (target.bundles.length > 1) {
      return conflict(
        `the ${target.name} target has more than one "${ios.afterPhaseName}" phase`,
        [`Keep one and run \`cmpatch wire\` again, or add a "${ios.phaseName}" run-script phase ${position} yourself.`],
      );
    }
    const bundleId = target.bundles[0]!;
    const integration = bundleIntegration(decodePbx(shell(bundleId).shellScript));
    if (integration === undefined) {
      return conflict(
        `the "${ios.afterPhaseName}" phase of the ${target.name} target runs neither React Native's nor Expo's bundle script, so wire cannot tell which build metadata script fits`,
        [`Add the "${ios.phaseName}" phase ${position} yourself with the script for your bundle phase (\`--integration rn\` or \`--integration expo\`).`],
      );
    }
    if (target.ours.length > 1) {
      return conflict(
        `the ${target.name} target has ${target.ours.length} "${ios.phaseName}" phases`,
        [`Keep one "${ios.phaseName}" phase ${position}, then run \`cmpatch wire\` again.`],
      );
    }
    const script = phaseScript(ios, integration);
    const id = target.ours[0];
    if (id === undefined) {
      edits.push({
        kind: "absent",
        target: target.name,
        apply: (current) => insertPhase(current, { targetId: target.id, bundleId, ios, script }),
        failure: conflict(
          `the ${target.name} target's build phases are not laid out the way Xcode writes them, so wire cannot insert the phase safely`,
          [`Add a "${ios.phaseName}" run-script phase ${position} yourself, or open and save the project in Xcode and run \`cmpatch wire\` again.`],
        ),
      });
      continue;
    }
    if (target.phaseIds.indexOf(id) !== target.phaseIds.indexOf(bundleId) + 1) {
      return conflict(
        `the "${ios.phaseName}" phase is not ${position}`,
        [`Move it ${position} in Xcode (Build Phases), then run \`cmpatch wire\` again.`],
      );
    }
    if (phaseMatches(shell(id), ios, script)) continue;
    edits.push({
      kind: "outdated",
      target: target.name,
      apply: (current) => replaceObject(current, id, (indent) => serializePhase(id, ios, script, indent)),
      failure: conflict(
        `the "${ios.phaseName}" phase of the ${target.name} target could not be located in the project text`,
        [`Update its script yourself, or delete it and run \`cmpatch wire\` again.`],
      ),
    });
  }

  if (edits.length === 0) return { kind: "current" };
  let contents = text;
  for (const edit of edits) {
    const next = edit.apply(contents);
    if (next === null) return edit.failure;
    contents = next;
  }
  return {
    kind: edits.some((edit) => edit.kind === "absent") ? "absent" : "outdated",
    contents,
    targets: edits.map((edit) => edit.target),
  };
}

/** One application target's build configurations that set ENABLE_USER_SCRIPT_SANDBOXING = YES. */
export type SandboxedTarget = { target: string; configurations: string[] };

/**
 * The application targets the step goes into whose build configurations set
 * ENABLE_USER_SCRIPT_SANDBOXING = YES, in the target or at project level.
 * An xcconfig file can override either; only inline settings are read.
 * Read before any definition is loaded, so the target rule uses the constants.
 */
export function xcodeSandboxedTargets(text: string): SandboxedTarget[] {
  let parsed: ParsedXcodeProject;
  try {
    parsed = parseXcodeProject(text);
  } catch {
    return [];
  }
  const { record, project } = parsed;
  const configurations = (owner: Record<string, unknown>) =>
    xcodeRefs(record("XCConfigurationList", String(owner.buildConfigurationList)).buildConfigurations)
      .map((id) => record("XCBuildConfiguration", id));
  const projectLevel = configurations(project);
  const setting = (config: Record<string, unknown> | undefined) =>
    isRecord(config?.buildSettings) ? config.buildSettings.ENABLE_USER_SCRIPT_SANDBOXING : undefined;
  return applicationTargets(parsed, APPLICATION_PRODUCT_TYPE)
    .filter((target) => target.phaseIds.some((id) => shellPhaseName(parsed, id) === BUNDLE_PHASE_NAME))
    .map((target) => ({
      target: target.name,
      configurations: configurations(record("PBXNativeTarget", target.id))
        .filter((config) => {
          const own = setting(config);
          const inherited = setting(projectLevel.find((item) => unquoteXcode(item.name) === unquoteXcode(config.name)));
          return unquoteXcode(own ?? inherited) === "YES";
        })
        .map((config) => unquoteXcode(config.name)),
    }))
    .filter((entry) => entry.configurations.length > 0);
}

/** "(Debug, Release) in the App target and (Debug) in the Staging target", for a message. */
export function describeSandboxedTargets(sandboxed: SandboxedTarget[]): string {
  return sandboxed.map((entry) => `(${entry.configurations.join(", ")}) in the ${entry.target} target`).join(" and ");
}

function phaseMatches(phase: Record<string, unknown>, ios: BuildIntegration["ios"], script: string): boolean {
  const list = (value: unknown) => (Array.isArray(value) ? value.map(decodePbx) : []);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
  return (
    decodePbx(phase.shellPath) === ios.shellPath &&
    decodePbx(phase.shellScript) === script &&
    same(list(phase.inputPaths), ios.inputPaths) &&
    same(list(phase.outputPaths), ios.outputPaths) &&
    list(phase.inputFileListPaths).length === 0 &&
    list(phase.outputFileListPaths).length === 0 &&
    decodePbx(phase.alwaysOutOfDate) === String(ios.alwaysOutOfDate) &&
    ["", "0"].includes(decodePbx(phase.runOnlyForDeploymentPostprocessing))
  );
}

/** A parsed pbxproj value as Xcode means it: quotes removed, escapes resolved. */
function decodePbx(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return "";
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  return value.slice(1, -1).replace(/\\(.)/gs, (_, char: string) =>
    char === "n" ? "\n" : char === "t" ? "\t" : char === "r" ? "\r" : char,
  );
}

function encodePbx(value: string): string {
  if (/^[A-Za-z0-9_$/:.]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

type Indent = { object: string; property: string; item: string; eol: string };

function serializePhase(id: string, ios: BuildIntegration["ios"], script: string, indent: Indent): string {
  const { object, property, item, eol } = indent;
  const list = (key: string, values: string[]) =>
    [`${property}${key} = (`, ...values.map((value) => `${item}${encodePbx(value)},`), `${property});`];
  return [
    `${object}${id} /* ${ios.phaseName} */ = {`,
    `${property}isa = PBXShellScriptBuildPhase;`,
    `${property}alwaysOutOfDate = ${ios.alwaysOutOfDate};`,
    `${property}buildActionMask = 2147483647;`,
    ...list("files", []),
    ...list("inputPaths", ios.inputPaths),
    `${property}name = ${encodePbx(ios.phaseName)};`,
    ...list("outputPaths", ios.outputPaths),
    `${property}runOnlyForDeploymentPostprocessing = 0;`,
    `${property}shellPath = ${encodePbx(ios.shellPath)};`,
    `${property}shellScript = ${encodePbx(script)};`,
    `${object}};`,
  ].join(eol) + eol;
}

/**
 * The text with string contents and comments blanked out, offsets kept, so
 * braces, parentheses and ids are only found where they are syntax.
 */
function maskPbx(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (token) => token.replace(/[^\n]/g, " "));
}

function matching(masked: string, open: number): number {
  const pair = masked[open] === "{" ? ["{", "}"] : ["(", ")"];
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === pair[0]) depth += 1;
    else if (masked[index] === pair[1] && --depth === 0) return index;
  }
  return -1;
}

function depthAt(masked: string, index: number): number {
  let depth = 0;
  for (let at = 0; at < index; at += 1) {
    if (masked[at] === "{") depth += 1;
    else if (masked[at] === "}") depth -= 1;
  }
  return depth;
}

/**
 * The single `id = {` object definition in the `objects` table (depth 2; an
 * id also keys entries such as `TargetAttributes`): where its line starts,
 * its `{` and its `}`.
 */
function findObject(masked: string, id: string): { lineStart: number; open: number; close: number; indent: string } | null {
  const matches = [...masked.matchAll(new RegExp(`(^|\\n)([ \\t]*)${id}\\s*=\\s*\\{`, "g"))]
    .filter((match) => depthAt(masked, match.index) === 2);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const lineStart = match.index + match[1]!.length;
  const open = match.index + match[0].length - 1;
  const close = matching(masked, open);
  return close < 0 ? null : { lineStart, open, close, indent: match[2]! };
}

function lineEnd(text: string, index: number): number {
  const end = text.indexOf("\n", index);
  return end < 0 ? text.length : end + 1;
}

function indentOf(text: string, object: { lineStart: number; open: number; indent: string }): Indent | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const firstProperty = /^\r?\n([ \t]+)\S/.exec(text.slice(object.open + 1));
  if (firstProperty === null || !firstProperty[1]!.startsWith(object.indent) || firstProperty[1] === object.indent) return null;
  const property = firstProperty[1]!;
  return { object: object.indent, property, item: property + property.slice(object.indent.length), eol };
}

function replaceObject(text: string, id: string, render: (indent: Indent) => string): string | null {
  const masked = maskPbx(text);
  const object = findObject(masked, id);
  if (object === null || masked[object.close + 1] !== ";") return null;
  const indent = indentOf(text, object);
  if (indent === null) return null;
  return `${text.slice(0, object.lineStart)}${render(indent)}${text.slice(lineEnd(text, object.close))}`;
}

/** A 24-hex object id derived from the target, unused anywhere in the file. */
function newObjectId(text: string, targetId: string, phaseName: string): string {
  for (let attempt = 0; ; attempt += 1) {
    const id = createHash("sha256").update(`${targetId}\0${phaseName}\0${attempt}`).digest("hex").slice(0, 24).toUpperCase();
    if (!text.toUpperCase().includes(id)) return id;
  }
}

function insertPhase(
  text: string,
  { targetId, bundleId, ios, script }: { targetId: string; bundleId: string; ios: BuildIntegration["ios"]; script: string },
): string | null {
  const masked = maskPbx(text);
  const target = findObject(masked, targetId);
  const bundle = findObject(masked, bundleId);
  if (target === null || bundle === null) return null;
  const indent = indentOf(text, bundle);
  if (indent === null) return null;

  // The reference goes on its own line right under the bundle phase's.
  const phasesAt = [...masked.slice(target.open, target.close).matchAll(/buildPhases\s*=\s*\(/g)];
  if (phasesAt.length !== 1) return null;
  const listOpen = target.open + phasesAt[0]!.index + phasesAt[0]![0].length - 1;
  const listClose = matching(masked, listOpen);
  const list = masked.slice(listOpen, listClose);
  const references = [...list.matchAll(new RegExp(`(^|\\n)([ \\t]*)${bundleId}[ \\t]*,[ \\t]*(?=\\r?\\n)`, "g"))];
  if (listClose < 0 || references.length !== 1) return null;
  const reference = references[0]!;
  const referenceLineEnd = lineEnd(text, listOpen + reference.index + reference[0].length);
  const id = newObjectId(text, targetId, ios.phaseName);
  const referenceLine = `${reference[2]}${id} /* ${ios.phaseName} */,${indent.eol}`;

  // The object goes where Xcode itself would write it: its section, sorted by id.
  const sectionEnd = text.indexOf("/* End PBXShellScriptBuildPhase section */");
  const sectionStart = text.indexOf("/* Begin PBXShellScriptBuildPhase section */");
  if (sectionStart < 0 || sectionEnd < sectionStart || bundle.lineStart < sectionStart || bundle.lineStart > sectionEnd) return null;
  const objectLines = [...masked.slice(sectionStart, sectionEnd).matchAll(new RegExp(`(^|\\n)${indent.object}([0-9A-Za-z_]+)\\s*=\\s*\\{`, "g"))];
  const following = objectLines.find((match) => match[2]! > id);
  const objectAt = following === undefined
    ? text.lastIndexOf("\n", sectionEnd) + 1
    : sectionStart + following.index + following[1]!.length;
  const phase = serializePhase(id, ios, script, indent);

  // Two insertions, the later offset first so the earlier one stays valid.
  const insertions = [[referenceLineEnd, referenceLine], [objectAt, phase]] as const;
  return [...insertions]
    .sort((a, b) => b[0] - a[0])
    .reduce((result, [at, line]) => `${result.slice(0, at)}${line}${result.slice(at)}`, text);
}

/** The step as it stands in one platform's file, against the given definition. */
export function inspectBuildStep(
  where: { platform: "ios" | "android"; file: string },
  text: string,
  definition: BuildIntegration,
): BuildStepFinding {
  return where.platform === "ios"
    ? inspectXcodeBuildStep(text, definition.ios)
    : inspectGradleBuildStep(text, where.file.endsWith(".kts") ? "kotlin" : "groovy", definition.android);
}

// --- Gradle -----------------------------------------------------------------

/** Comments and string contents blanked out, line structure kept. */
function maskGradle(text: string): string {
  return text.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (token) =>
    token.startsWith("/") ? token.replace(/[^\n]/g, " ") : token[0] + token.slice(1, -1).replace(/[^\n]/g, " ") + token.slice(-1),
  );
}

/**
 * A new line goes at the end of the script: that is after every `react { }`
 * block, whose Node.js setting the line reads, and after the statement that
 * applies the React Native plugin, whatever shape the script has. A line that
 * is already there is compared and rewritten where it stands.
 */
function inspectGradleBuildStep(
  text: string,
  language: "groovy" | "kotlin",
  android: BuildIntegration["android"],
): BuildStepFinding {
  const expected = language === "kotlin" ? android.kotlin : android.groovy;
  const lines = text.split("\n");
  const masked = maskGradle(text).split("\n");
  // Ours is a line that applies a script of the SDK package, whatever statement it starts with.
  const ours = lines.flatMap((line, index) =>
    /\bapply\b/.test(masked[index]!) && line.includes("@codemagic/react-native-patch") ? [index] : [],
  );
  if (ours.length > 1) {
    return {
      kind: "conflict",
      reason: "the app build script applies @codemagic/react-native-patch build tools more than once",
      manual: ["Keep one line:", `  ${expected}`],
    };
  }
  if (ours.length === 1) {
    const index = ours[0]!;
    const [, indent, statement, cr] = /^([ \t]*)(.*?)(\r?)$/.exec(lines[index]!)!;
    if (statement!.trimEnd() === expected) return { kind: "current" };
    const next = [...lines];
    next[index] = `${indent}${expected}${cr}`;
    return { kind: "outdated", contents: next.join("\n") };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // A script without a final newline gets the line without one either.
  return { kind: "absent", contents: text === "" || text.endsWith("\n") ? `${text}${expected}${eol}` : `${text}${eol}${expected}` };
}
