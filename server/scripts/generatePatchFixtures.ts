import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  hdiffPatchDiffEngine,
  readBundleTreeFromZipBuffer,
} from "../src/worker";
import {
  PATCH_FIXTURE_CORPUS_MANIFEST_PATH,
  loadPatchFixtureCorpus,
  readPatchFixtureBuffer,
} from "../test/helpers/patchFixtureCorpus";
import { readRnFixtureArchive } from "../test/helpers/rnFixtureCorpus";

async function main(): Promise<void> {
  const corpus = loadPatchFixtureCorpus(PATCH_FIXTURE_CORPUS_MANIFEST_PATH, {
    allowIncompleteMetadata: true,
  });
  const nextManifest = {
    version: 1,
    fixtures: [],
  } as {
    version: number;
    fixtures: Array<Record<string, unknown>>;
  };

  for (const fixture of corpus.fixtures) {
    const sourceTree = readBundleTreeFromZipBuffer(readRnFixtureArchive(fixture.sourceFixture));
    const targetTree = readBundleTreeFromZipBuffer(readRnFixtureArchive(fixture.targetFixture));
    const patchBuffer = await hdiffPatchDiffEngine.createPatch({
      source: sourceTree,
      target: targetTree,
    });

    if (!patchBuffer) {
      if (fixture.absolutePatchPath) {
        await rm(path.dirname(fixture.absolutePatchPath), { force: true, recursive: true });
      }

      nextManifest.fixtures.push({
        description: fixture.description,
        diffEngine: fixture.diffEngine,
        id: fixture.id,
        scenarioId: fixture.scenarioId,
        sourceFixtureId: fixture.sourceFixtureId,
        targetFixtureId: fixture.targetFixtureId,
      });
      continue;
    }

    if (!fixture.patchPath) {
      throw new Error(`Patch fixture ${fixture.id} must declare patchPath in the manifest`);
    }

    const patchPath = path.resolve(corpus.rootDir, fixture.patchPath);
    await mkdir(path.dirname(patchPath), { recursive: true });
    await writeFile(patchPath, patchBuffer);

    nextManifest.fixtures.push({
      description: fixture.description,
      diffEngine: fixture.diffEngine,
      id: fixture.id,
      patchPath: fixture.patchPath,
      patchSha256: sha256Hex(patchBuffer),
      patchSize: patchBuffer.length,
      scenarioId: fixture.scenarioId,
      sourceFixtureId: fixture.sourceFixtureId,
      targetFixtureId: fixture.targetFixtureId,
    });
  }

  await writeFile(
    PATCH_FIXTURE_CORPUS_MANIFEST_PATH,
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    "utf8",
  );

  for (const fixture of loadPatchFixtureCorpus().fixtures) {
    if (fixture.absolutePatchPath) {
      const patchBuffer = readPatchFixtureBuffer(fixture);
      if (!patchBuffer) {
        throw new Error(`Expected generated patch buffer for ${fixture.id}`);
      }
      console.log(`${fixture.id}: ${patchBuffer.length} bytes ${sha256Hex(patchBuffer)}`);
    } else {
      console.log(`${fixture.id}: no-op`);
    }
  }
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
