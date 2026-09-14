import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await import("./build.mjs");

const scratch = await mkdtemp(join(tmpdir(), "cmpatch-install-global-"));
try {
  // build.mjs already produced dist; skip the prepack hook's second build.
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: cliRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
  execFileSync("npm", ["install", "--global", join(scratch, packed[0].filename)], {
    cwd: cliRoot,
    stdio: "inherit",
  });
  console.log("Installed the local CLI as cmpatch in the active npm global prefix.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
