import {
  readStoreArtifact,
  StoreArtifactError,
  type StoreArtifactMetadata,
} from "@codemagic/patch-shared/store-artifact";

import type {
  FingerprintArtifactCommand,
  FingerprintCommand,
} from "../commandTypes";
import { PLAIN_PALETTE } from "../output";
import { renderObjectView, type ObjectField } from "../resultView";
import { ensureReadableDirectory, ValidationError, type CommandDeps } from "./shared";

export async function executeFingerprint(
  command: FingerprintCommand,
  deps: CommandDeps,
): Promise<Record<string, unknown> | string> {
  if ("artifact" in command) {
    return executeFingerprintArtifact(command);
  }

  const projectRoot = await ensureReadableDirectory(
    deps,
    command.projectRoot,
    "project root",
  );

  // JSON names the engine that computed the value (the key `--artifact` uses
  // for the same thing), so it needs the details. Text stays the bare
  // fingerprint, and with --verbose the fingerprint followed by one line per
  // source: scripts read both shapes.
  if (command.verbose || command.format === "json") {
    const details = await deps.computeFingerprintDetails({
      platform: command.platform,
      projectRoot,
    });
    const sources = details.sources.map((source) => ({
      ...(source.filePath !== undefined ? { filePath: source.filePath } : {}),
      type: source.type,
    }));

    if (command.format === "json") {
      return {
        fingerprint: details.fingerprint,
        fingerprintEngine: details.engine,
        ...(command.verbose ? { sources } : {}),
      };
    }

    return [
      details.fingerprint,
      ...sources.map((source) =>
        source.filePath === undefined
          ? source.type
          : `${source.type}\t${source.filePath}`,
      ),
    ].join("\n");
  }

  return deps.computeFingerprint({
    platform: command.platform,
    projectRoot,
  });
}

/**
 * Read what a store artifact records — never compute a fallback. A missing
 * metadata file is a successful inspection (`metadataPresent: false`); an
 * unreadable, unsupported or malformed artifact is a ValidationError whose
 * message is `<reader error code>: <reader message>`.
 */
async function executeFingerprintArtifact(
  command: FingerprintArtifactCommand,
): Promise<Record<string, unknown> | string> {
  let metadata: StoreArtifactMetadata;
  try {
    metadata = await readStoreArtifact(command.artifact);
  } catch (error) {
    if (error instanceof StoreArtifactError) {
      // The reader's message already starts with the artifact path.
      throw new ValidationError(`${error.code}: ${error.message}`);
    }
    throw error;
  }

  const result = {
    platform: metadata.platform,
    binaryVersion: metadata.binaryVersion,
    metadataPresent: metadata.metadataPresent,
    fingerprint: metadata.fingerprint,
    fingerprintEngine: metadata.fingerprintEngine,
    embeddedPackageHash: metadata.embeddedPackageHash,
    embeddedFileCount: metadata.embeddedFiles?.length ?? null,
    embeddedFiles: metadata.embeddedFiles,
    sha256: metadata.sha256,
  };

  if (command.format === "text") {
    return renderObjectView(result, PLAIN_PALETTE, FINGERPRINT_ARTIFACT_FIELDS).trimEnd();
  }

  return result;
}

const NO_METADATA_FILE = "none (the artifact has no CodemagicPatchBuild.json)";

/** Recorded value, a null the file recorded, or a value missing with the whole file. */
function recordedCell(
  record: Record<string, unknown>,
  key: string,
  nullMeaning: string,
): unknown {
  if (record.metadataPresent !== true) {
    return NO_METADATA_FILE;
  }
  return record[key] ?? nullMeaning;
}

export const FINGERPRINT_ARTIFACT_FIELDS: readonly ObjectField[] = [
  ["Platform", "platform"],
  ["Binary version", "binaryVersion"],
  {
    cell: (record) =>
      record.metadataPresent === true
        ? "present"
        : "absent (no CodemagicPatchBuild.json in the app)",
    label: "Build metadata",
    reads: ["metadataPresent"],
  },
  {
    cell: (record) => recordedCell(record, "fingerprint", "none recorded"),
    label: "Fingerprint",
    reads: ["fingerprint"],
  },
  {
    cell: (record) => recordedCell(record, "fingerprintEngine", "none recorded"),
    label: "Fingerprint engine",
    reads: ["fingerprintEngine"],
  },
  {
    cell: (record) =>
      recordedCell(record, "embeddedPackageHash", "none recorded (no embedded baseline advertised)"),
    label: "Embedded bundle hash",
    reads: ["embeddedPackageHash"],
  },
  {
    cell: (record) => {
      const count = record.embeddedFileCount;
      return typeof count === "number"
        ? `${count} ${count === 1 ? "file" : "files"}`
        : recordedCell(record, "embeddedFileCount", "none recorded");
    },
    label: "Embedded files",
    reads: ["embeddedFileCount", "embeddedFiles"],
  },
  {
    cell: (record) => record.sha256 ?? "not computed for an .xcarchive directory",
    label: "Artifact SHA-256",
    reads: ["sha256"],
  },
];
