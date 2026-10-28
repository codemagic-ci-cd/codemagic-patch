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
 * behavior.
 *
 *   yarn consumer-check                    all targets
 *   yarn consumer-check --only rn-0.73     one target (comma-separated ids)
 *   yarn consumer-check --keep             keep the work directory
 *   yarn consumer-check --work-dir <dir>   use <dir> instead of a temp dir
 *
 * Exits non-zero if any target fails. The work directory is kept on failure.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
