import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type ConfigPlugin, WarningAggregator, withAppBuildGradle, withXcodeProject } from 'expo/config-plugins';

/**
 * Inserts the "Codemagic Patch build metadata" step (client/specs/build-integration/Spec.md)
 * into the generated native projects. Prebuild only inserts the step; the step
 * computes and writes CodemagicPatchBuild.json during each native build.
 */

type BuildIntegration = {
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

// The file `cmpatch wire` also reads from the installed SDK. It is read at run
// time because this plugin is compiled separately from build-tools/ (its
// tsconfig's rootDir is plugin/src); the relative path is the same from
// plugin/src and plugin/build.
function readBuildIntegration(): BuildIntegration {
  return JSON.parse(
    readFileSync(path.join(__dirname, '../../build-tools/native/build-integration.json'), 'utf8'),
  ) as BuildIntegration;
}

type PbxObject = Record<string, unknown>;
type PbxRef = { value: string; comment?: string };
type XcodeProject = {
  hash: { project: { objects: Record<string, Record<string, PbxObject | string>> } };
  generateUuid(): string;
};

const unquote = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/^"([\s\S]*)"$/, '$1') : value;
const quote = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/**
 * Adds the phase to every application target that has the bundle phase,
 * directly after it, or rewrites it there when a phase of that name already
 * exists. An application target without the bundle phase (a watch or companion
 * app another plugin added) bundles no JS and is left alone. Mutates and
 * returns `project`.
 */
function addIosBuildMetadataPhase(project: XcodeProject): XcodeProject {
  const { ios } = readBuildIntegration();
  const objects = project.hash.project.objects;
  const shellPhases = (objects.PBXShellScriptBuildPhase ??= {}) as Record<string, PbxObject | string>;
  const phaseName = (ref: PbxRef) => unquote((shellPhases[ref.value] as PbxObject | undefined)?.name);

  const applicationTargets = Object.entries(objects.PBXNativeTarget ?? {})
    .filter(([key]) => !key.endsWith('_comment'))
    .map(([, target]) => target as PbxObject & { buildPhases: PbxRef[] })
    .filter((target) => unquote(target.productType) === ios.targetProductType);
  if (applicationTargets.length === 0) {
    throw new Error(
      `[codemagic-patch] the Xcode project has no application target (${ios.targetProductType}); cannot add the "${ios.phaseName}" build phase.`,
    );
  }
  const targets = applicationTargets.filter((target) =>
    target.buildPhases.some((ref) => phaseName(ref) === ios.afterPhaseName),
  );
  if (targets.length === 0) {
    throw new Error(
      `[codemagic-patch] no application target has a "${ios.afterPhaseName}" build phase. The "${ios.phaseName}" phase runs directly after the bundle phase that Expo prebuild generates; without it there is no position to add it at.`,
    );
  }

  for (const target of targets) {
    const existing = target.buildPhases.filter((ref) => phaseName(ref) === ios.phaseName);
    const uuid = existing[0]?.value ?? project.generateUuid();
    for (const ref of existing) {
      target.buildPhases.splice(target.buildPhases.indexOf(ref), 1);
      if (ref.value !== uuid) {
        delete shellPhases[ref.value];
        delete shellPhases[`${ref.value}_comment`];
      }
    }
    shellPhases[uuid] = {
      isa: 'PBXShellScriptBuildPhase',
      alwaysOutOfDate: ios.alwaysOutOfDate,
      buildActionMask: 2147483647,
      files: [],
      inputPaths: ios.inputPaths.map(quote),
      name: quote(ios.phaseName),
      outputPaths: ios.outputPaths.map(quote),
      runOnlyForDeploymentPostprocessing: 0,
      shellPath: ios.shellPath,
      shellScript: quote(ios.shellScript.replaceAll('{{integration}}', 'expo')),
    };
    shellPhases[`${uuid}_comment`] = ios.phaseName;
    const bundleIndex = target.buildPhases.findIndex((ref) => phaseName(ref) === ios.afterPhaseName);
    target.buildPhases.splice(bundleIndex + 1, 0, { value: uuid, comment: ios.phaseName });
  }
  return project;
}

/** Comments and string contents blanked out, line structure kept, so `apply` is only found where it is code. */
function maskGradle(text: string): string {
  return text.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (token) =>
    token.replace(/[^\n]/g, ' '),
  );
}

/**
 * Returns the app module's build script with the build-metadata line, by the
 * rule `cmpatch wire` follows: a line that applies a script of the SDK package
 * is rewritten where it stands, and a new line goes at the end of the script,
 * which is after every `react { }` block (whose Node.js setting the line
 * reads) and after the React Native plugin is applied. Where wire leaves more
 * than one such line to the developer, prebuild keeps one, at the end.
 */
function addAndroidBuildMetadataLine(contents: string, language: string): string {
  const { android } = readBuildIntegration();
  const expected = language === 'kt' ? android.kotlin : android.groovy;
  const lines = contents.split('\n');
  const masked = maskGradle(contents).split('\n');
  const ours = lines.flatMap((line, index) =>
    /\bapply\b/.test(masked[index]) && line.includes('@codemagic/react-native-patch') ? [index] : [],
  );
  if (ours.length === 1) {
    lines[ours[0]] = lines[ours[0]].replace(/^([ \t]*).*?(\r?)$/, (_, indent: string, cr: string) => `${indent}${expected}${cr}`);
    return lines.join('\n');
  }
  const kept = lines.filter((_, index) => !ours.includes(index)).join('\n');
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';
  return kept === '' || kept.endsWith('\n') ? `${kept}${expected}${eol}` : `${kept}${eol}${expected}`;
}

const SKIP_ENV = 'CODEMAGIC_PATCH_SKIP_BUILD_FINGERPRINT';

/**
 * The build-metadata opt-out at prebuild: with the variable the inserted text
 * checks in every build set to `1`, the step is not added, so the opt-out also
 * rescues a prebuild of a project the step has no place in. Checked inside the
 * mod, which only prebuild runs; the plugin itself runs whenever the config is
 * read. A step an earlier prebuild added stays and opts out in the build.
 */
function optedOut(platform: 'ios' | 'android'): boolean {
  if (process.env[SKIP_ENV] !== '1') return false;
  (platform === 'ios' ? WarningAggregator.addWarningIOS : WarningAggregator.addWarningAndroid)(
    '@codemagic/react-native-patch',
    `${SKIP_ENV}=1 opts out: the build metadata step is not added, so builds of this project record no CodemagicPatchBuild.json. This also disables embedded-baseline identification for those binaries.`,
  );
  return true;
}

export const withIosBuildMetadata: ConfigPlugin = (config) =>
  withXcodeProject(config, (cfg) => {
    if (!optedOut('ios')) addIosBuildMetadataPhase(cfg.modResults as unknown as XcodeProject);
    return cfg;
  });

export const withAndroidBuildMetadata: ConfigPlugin = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (!optedOut('android')) {
      cfg.modResults.contents = addAndroidBuildMetadataLine(cfg.modResults.contents, cfg.modResults.language);
    }
    return cfg;
  });
