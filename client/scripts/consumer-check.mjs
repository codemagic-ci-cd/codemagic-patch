#!/usr/bin/env node
/**
 * Consumer check: does the packed SDK load in a consumer's test runner?
 *
 * Packs this package with `npm pack` (what npm publishes), then for each target
 * creates a minimal throwaway project, installs the target's dependencies at
 * exact versions plus the tarball without a lockfile, copies in the consumer
 * tests under scripts/consumer-check/<runner>/ and runs them.
 *
 * Reproducibility: every dependency a target declares is pinned to an exact
 * version, but there is no lockfile, so their transitive dependencies still
 * resolve to the newest release their own ranges allow. A run can therefore
 * change result without a change here when a transitive release lands. When a
 * target fails, the resolved tree (`npm ls --all --json`) is written to
 * <work dir>/<target>/resolved-tree.json, and the work directory is kept, so
 * such a drift can be told apart from an SDK regression.
 *
 * This checks JS packaging and loading of the test fake (`./jest`,
 * `./jest-setup`, `./vitest`, `./vitest-setup`, `./vitest-plugin`), not native
 * behavior. Before any target runs, it also checks that the tarball carries
 * the build metadata step's files (the `build-step-files` row) and the Swift
 * Package Manager manifest with every path it references (the
 * `swiftpm-manifest` row); both run with `--only` too. The manifest check
 * reads the manifest as text, so it needs no Swift toolchain.
 *
 *   yarn consumer-check                    all targets
 *   yarn consumer-check --only rn-0.73     one target (comma-separated ids)
 *   yarn consumer-check --keep             keep the work directory
 *   yarn consumer-check --work-dir <dir>   use <dir> instead of a temp dir
 *
 * Exits non-zero if any target fails. The work directory is kept on failure.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(clientDir, "scripts", "consumer-check");

const TRANSFORM_IGNORE = [
  "node_modules/(?!((jest-)?react-native|@react-native(-community)?|@codemagic)/)",
];
const JEST_SETUP = ["@codemagic/react-native-patch/jest-setup"];

const jestConfig = (preset) =>
  `module.exports = ${JSON.stringify(
    { preset, setupFiles: JEST_SETUP, transformIgnorePatterns: TRANSFORM_IGNORE },
    null,
    2,
  )};\n`;
const babelConfig = "module.exports = { presets: ['module:@react-native/babel-preset'] };\n";

/**
 * The matrix. Every declared dependency is an exact version (no ranges), so a
 * run says exactly what it covered; bump them here deliberately.
 * rn-0.73 mirrors a `react-native init` 0.73 project (the oldest supported RN,
 * Jest 29 with the `react-native` preset); rn-0.88 is the newest RN with
 * `@react-native/jest-preset`.
 */
const TARGETS = [
  {
    id: "rn-0.73",
    runner: "jest",
    dependencies: { react: "18.2.0", "react-native": "0.73.11" },
    devDependencies: {
      "@babel/core": "7.29.7",
      "@babel/preset-env": "7.29.7",
      "@babel/runtime": "7.29.10",
      "@react-native/babel-preset": "0.73.21",
      "babel-jest": "29.7.0",
      jest: "29.7.0",
      "react-test-renderer": "18.2.0",
    },
    files: { "jest.config.js": jestConfig("react-native"), "babel.config.js": babelConfig },
    runs: [["node_modules/jest/bin/jest.js", "--ci"]],
  },
  {
    id: "rn-0.88",
    runner: "jest",
    dependencies: { react: "19.3.0", "react-native": "0.88.0" },
    devDependencies: {
      "@babel/core": "7.29.7",
      "@babel/preset-env": "7.29.7",
      "@babel/runtime": "7.29.10",
      "@react-native/babel-preset": "0.88.0",
      "@react-native/jest-preset": "0.88.0",
      "babel-jest": "29.7.0",
      jest: "29.7.0",
      "react-test-renderer": "19.3.0",
    },
    files: {
      "jest.config.js": jestConfig("@react-native/jest-preset"),
      "babel.config.js": babelConfig,
    },
    runs: [["node_modules/jest/bin/jest.js", "--ci"]],
  },
  {
    id: "vitest",
    runner: "vitest",
    type: "module",
    dependencies: { react: "19.3.0", "react-dom": "19.3.0", "react-native": "0.88.0" },
    devDependencies: { jsdom: "29.1.1", vitest: "3.2.7" },
    files: {
      "vitest.config.js": [
        "import { defineConfig } from 'vitest/config';",
        "import { codemagicPatch } from '@codemagic/react-native-patch/vitest-plugin';",
        "",
        "export default defineConfig({",
        "  plugins: [codemagicPatch()],",
        "  test: { setupFiles: ['@codemagic/react-native-patch/vitest-setup'] },",
        "});",
        "",
      ].join("\n"),
    },
    runs: [
      // The mounted wrap test needs a DOM, so it runs under jsdom only.
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--environment",
        "node",
        "a-setup-only",
        "b-running",
        "c-update-ready",
      ],
      ["node_modules/vitest/vitest.mjs", "run", "--environment", "jsdom"],
    ],
  },
];

function parseArgs(argv) {
  const args = { only: null, keep: false, workDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") args.keep = true;
    else if (arg === "--only") args.only = argv[++i].split(",").map((s) => s.trim());
    else if (arg === "--work-dir") args.workDir = resolve(argv[++i]);
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function run(command, args, cwd) {
  console.log(`\n$ ${[command, ...args].join(" ")}   (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CI: "true" } });
  return result.status === 0;
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `name@version` for every dependency a target declares; throws on a range. */
function pinnedMatrix(target) {
  return Object.entries({ ...target.dependencies, ...target.devDependencies }).map(
    ([name, version]) => {
      if (!EXACT_VERSION.test(version)) {
        throw new Error(`${target.id}: ${name} is "${version}", not an exact version`);
      }
      return `${name}@${version}`;
    },
  );
}

/** Keep what npm resolved, for telling a dependency drift from a regression. */
function writeResolvedTree(dir) {
  const result = spawnSync("npm", ["ls", "--all", "--json"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const file = join(dir, "resolved-tree.json");
  // `npm ls` exits non-zero on any problem it finds, which is when the tree
  // matters most, so the output is kept whatever the status.
  writeFileSync(file, result.stdout || JSON.stringify({ error: result.stderr }, null, 2));
  console.log(`resolved dependency tree written to ${file}`);
}

function pack(workDir) {
  const packDir = join(workDir, "pack");
  mkdirSync(packDir, { recursive: true });
  // `npm pack` runs `prepare`, so the tarball carries a fresh dist/.
  if (!run("npm", ["pack", "--pack-destination", packDir, "--loglevel=warn"], clientDir)) {
    throw new Error("npm pack failed");
  }
  const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack left no tarball in ${packDir}`);
  return join(packDir, tarball);
}

// --- What the tarball must carry -------------------------------------------------

/** The tarball's contents, as a consumer's node_modules gets them. */
function extract(tarball, workDir) {
  const extracted = join(workDir, "extracted");
  rmSync(extracted, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });
  if (!run("tar", ["-xzf", tarball, "-C", extracted], workDir)) throw new Error("could not extract the tarball");
  return join(extracted, "package");
}

/**
 * The files of the build metadata step: the text `cmpatch wire` and the Expo
 * plugin insert, the two scripts that text runs from the installed package,
 * and the writer those scripts run. No target builds a native app, so a file
 * dropped from package.json `files` would first show up in a customer's build.
 */
const BUILD_STEP_FILES = [
  "build-tools/native/build-integration.json",
  "build-tools/native/build-metadata-phase.sh",
  "build-tools/native/build-metadata.gradle",
  "dist/build-tools/fingerprint.js",
];

function checkBuildStepFiles(packageRoot) {
  const missing = BUILD_STEP_FILES.filter((file) => !existsSync(join(packageRoot, file)));
  return missing.length === 0 ? null : `missing from the tarball (package.json files): ${missing.join(", ")}`;
}

// --- Swift Package Manager manifest in the tarball ------------------------------

/** Strips `//` and `/* *\/` comments, leaving string literals intact. */
function stripSwiftComments(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return out;
}

/** The argument text of every `.target(` call, matched by parentheses. */
function targetBlocks(manifest) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const start = manifest.indexOf(".target(", from);
    if (start === -1) return blocks;
    let depth = 0;
    let i = start + ".target".length;
    for (; i < manifest.length; i++) {
      if (manifest[i] === '"') i = manifest.indexOf('"', i + 1);
      else if (manifest[i] === "(") depth++;
      else if (manifest[i] === ")" && --depth === 0) break;
    }
    blocks.push(manifest.slice(start, i + 1));
    from = i + 1;
  }
}

const quoted = (text) => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
const stringArgument = (block, label) => block.match(new RegExp(`${label}:\\s*"([^"]*)"`))?.[1];
const arrayArgument = (block, label) => {
  const match = block.match(new RegExp(`${label}:\\s*\\[([^\\]]*)\\]`));
  return match ? quoted(match[1]) : [];
};

/** Expands `{a,b}` in a podspec glob into one pattern per alternative. */
function expandBraces(pattern) {
  const match = pattern.match(/\{([^}]*)\}/);
  if (!match) return [pattern];
  return match[1]
    .split(",")
    .flatMap((alt) => expandBraces(pattern.replace(match[0], alt)));
}

/** Files a single-directory podspec glob (`dir/*.c`, `dir/name.c`) matches. */
function globOneDirectory(root, pattern) {
  if (pattern.includes("**")) throw new Error(`unsupported podspec glob under libs/: ${pattern}`);
  const dir = dirname(pattern);
  const name = new RegExp(`^${pattern.slice(dir.length + 1).replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`);
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((entry) => name.test(entry))
    .map((entry) => `${dir}/${entry}`);
}

/** The `.c` files the podspec compiles under libs/, relative to libs/. */
function podspecLibsCSources(packageRoot) {
  const podspec = readFileSync(join(packageRoot, "CodemagicPatchClient.podspec"), "utf8");
  const sourceFiles = podspec.match(/s\.source_files\s*=\s*\[([\s\S]*?)\]/);
  if (!sourceFiles) throw new Error("podspec has no s.source_files array");
  const patterns = quoted(sourceFiles[1].replace(/#.*$/gm, ""))
    .filter((entry) => entry.startsWith("libs/"))
    .flatMap(expandBraces)
    .filter((entry) => entry.endsWith(".c"));
  return new Set(patterns.flatMap((pattern) => globOneDirectory(packageRoot, pattern)).map((file) => file.slice("libs/".length)));
}

/**
 * Checks the manifest the tarball ships: it exists, every path a `.target(`
 * names (target path, sources, public headers, header search paths) exists in
 * the tarball and stays inside it, the zstd prefix header (built from
 * #filePath, so not a literal) exists, and CodemagicPatchNativeLibs compiles
 * the same C files as the podspec. `.package(path:)` entries point into the
 * app's autolinking tree by design and are not checked.
 */
function checkSwiftPackageManifest(packageRoot) {
  const manifestPath = join(packageRoot, "Package.swift");
  if (!existsSync(manifestPath)) return "Package.swift is missing from the tarball (package.json files)";

  const problems = [];
  const inPackage = (absolute) => !relative(packageRoot, absolute).startsWith("..");
  const requirePath = (absolute, what, directory) => {
    const shown = relative(packageRoot, absolute);
    if (!inPackage(absolute)) problems.push(`${what} ${shown} is outside the package`);
    else if (!existsSync(absolute)) problems.push(`${what} ${shown} is missing from the tarball`);
    else if (directory && !statSync(absolute).isDirectory()) problems.push(`${what} ${shown} is not a directory`);
  };

  let nativeLibsSources = null;
  for (const block of targetBlocks(stripSwiftComments(readFileSync(manifestPath, "utf8")))) {
    const name = stringArgument(block, "name") ?? "(unnamed target)";
    const targetPath = stringArgument(block, "path");
    if (targetPath === undefined) {
      problems.push(`target ${name} has no explicit path`);
      continue;
    }
    const base = resolve(packageRoot, targetPath);
    requirePath(base, `target ${name} path`, true);
    const sources = arrayArgument(block, "sources");
    for (const source of sources) requirePath(resolve(base, source), `target ${name} source`, false);
    const publicHeaders = stringArgument(block, "publicHeadersPath");
    if (publicHeaders !== undefined) requirePath(resolve(base, publicHeaders), `target ${name} publicHeadersPath`, true);
    for (const match of block.matchAll(/\.headerSearchPath\(\s*"([^"]*)"/g)) {
      requirePath(resolve(base, match[1]), `target ${name} headerSearchPath`, true);
    }
    if (name === "CodemagicPatchNativeLibs") nativeLibsSources = new Set(sources);
  }
  requirePath(join(packageRoot, "libs/zstd/codemagic_patch_zstd_prefix.h"), "zstd prefix header", false);

  if (nativeLibsSources === null) {
    problems.push("Package.swift has no CodemagicPatchNativeLibs target");
  } else {
    const podspec = podspecLibsCSources(packageRoot);
    const onlyManifest = [...nativeLibsSources].filter((file) => !podspec.has(file)).sort();
    const onlyPodspec = [...podspec].filter((file) => !nativeLibsSources.has(file)).sort();
    if (onlyManifest.length > 0) problems.push(`compiled by Package.swift but not the podspec: ${onlyManifest.join(", ")}`);
    if (onlyPodspec.length > 0) problems.push(`compiled by the podspec but not Package.swift: ${onlyPodspec.join(", ")}`);
  }

  for (const problem of problems) console.error(`swiftpm-manifest: ${problem}`);
  return problems.length === 0 ? null : `${problems.length} problem(s): ${problems.join("; ")}`;
}

function checkTarget(target, tarball, workDir) {
  const dir = join(workDir, target.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const packageJson = {
    name: `consumer-check-${target.id.replace(/\./g, "")}`,
    private: true,
    version: "0.0.0",
    ...(target.type ? { type: target.type } : {}),
    dependencies: { ...target.dependencies, "@codemagic/react-native-patch": `file:${tarball}` },
    devDependencies: target.devDependencies,
  };
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const [name, content] of Object.entries(target.files)) {
    writeFileSync(join(dir, name), content);
  }
  cpSync(join(templatesDir, target.runner), join(dir, "__tests__"), { recursive: true });

  const install = [
    "install",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--loglevel=error",
  ];
  if (!run("npm", install, dir)) {
    writeResolvedTree(dir);
    return "install failed";
  }
  for (const args of target.runs) {
    if (!run(process.execPath, args, dir)) {
      writeResolvedTree(dir);
      return `failed: ${args.slice(1).join(" ")}`;
    }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const targets = args.only ? TARGETS.filter((t) => args.only.includes(t.id)) : TARGETS;
if (targets.length === 0) {
  console.error(`no target matches --only ${args.only.join(",")}; known: ${TARGETS.map((t) => t.id).join(", ")}`);
  process.exit(2);
}

// Validate the pins before any work, so a range never reaches an install.
const matrix = new Map(targets.map((t) => [t.id, pinnedMatrix(t)]));

const workDir = args.workDir ?? mkdtempSync(join(tmpdir(), "codemagic-patch-consumer-check-"));
mkdirSync(workDir, { recursive: true });
console.log(`consumer check work directory: ${workDir}`);

const results = [];
try {
  const tarball = pack(workDir);
  const packageRoot = extract(tarball, workDir);
  results.push({ id: "build-step-files", failure: checkBuildStepFiles(packageRoot) });
  results.push({ id: "swiftpm-manifest", failure: checkSwiftPackageManifest(packageRoot) });
  for (const target of targets) {
    results.push({ id: target.id, failure: checkTarget(target, tarball, workDir) });
  }
} catch (error) {
  results.push({ id: "pack", failure: error.message });
}

console.log("\nconsumer check summary");
for (const { id, failure } of results) {
  console.log(`  ${failure ? "FAIL" : "ok  "}  ${id}${failure ? `  (${failure})` : ""}`);
  for (const pin of matrix.get(id) ?? []) console.log(`          ${pin}`);
}
const failed = results.some((r) => r.failure);
if (failed || args.keep || args.workDir) {
  console.log(`work directory kept: ${workDir}`);
} else {
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
