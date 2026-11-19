// Production build for the published CLI — the same shape as cli/scripts/build.mjs.
// esbuild bundles the `cmpatch-capacitor` bin into a single self-contained file,
// inlining our own source AND the private `@codemagic/patch-shared` workspace
// (resolved from its TypeScript source via the alias below) so the shipped package
// has no unpublishable workspace dependency.
//
// Every package in `dependencies` stays external (installed from the registry). The
// parsers `doctor` reads projects with (@babel/parser, fast-xml-parser, plist, xcode)
// are devDependencies, so they are bundled too and `fflate` stays the one install
// (specs/doctor/Spec.md › Decisions, 2). The output lives at dist/cmpatch-capacitor.js
// (one level under dist/) so version.ts's `join(__dirname, "..", "package.json")`
// resolves to the package root from both src/ and dist/.

import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(resolve(cliRoot, "package.json"), "utf8"));

// package.json publishes the whole dist/, so start from an empty one: a file a
// previous build layout left behind would otherwise ship in the tarball.
await rm(resolve(cliRoot, "dist"), { recursive: true, force: true });

await build({
  // update-check.js is the detached process behind the "newer version" notice
  // (src/updateNotice.ts), which finds it next to cmpatch-capacitor.js.
  entryPoints: [
    resolve(cliRoot, "src/bin/cmpatch-capacitor.ts"),
    resolve(cliRoot, "src/bin/update-check.ts"),
  ],
  outdir: resolve(cliRoot, "dist"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // Must not exceed the package.json engines floor (node ^20.19.0 || >=22.12.0).
  target: "node20",
  sourcemap: true,
  // Keep published runtime deps external; bundle first-party code and devDependencies.
  external: Object.keys(pkg.dependencies ?? {}),
  alias: {
    "@codemagic/patch-shared": resolve(cliRoot, "../shared/src/index.ts"),
  },
  logLevel: "info",
});
