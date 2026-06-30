import { Readable } from "node:stream";

import type { Multipart } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";

import type { StorageAdapter } from "../../adapters";
import {
  createProblem,
  createValidationProblem,
  type ProblemDetails,
  type ProblemFieldError,
} from "../../app/problemDetails";
import type {
  ReleaseCreationHandlerInput,
  ReleaseCreationPreflightRouteHandler,
} from "../../app/types";
import { MAX_UPLOAD_SIZE_EXCEEDED_DETAIL } from "../../app/upload-size";
import { computePackageHashFromZipBuffer } from "../../packageHash";
import {
  buildReleaseCreationInput,
  createReleaseId,
  createReleaseJobId,
  parseReleaseCreationMetadata,
  problemForReleaseCreationFailure,
  type ReleaseCreationMetadata,
} from "./releaseSupport";
import {
  DUPLICATE_METADATA_PART_ERROR,
  INVALID_METADATA_PART_ERROR,
  INVALID_MULTIPART_ORDER_ERROR,
  INVALID_RELEASE_BUNDLE_ARCHIVE_ERROR,
  MISSING_RELEASE_MULTIPART_FIELDS_ERROR,
} from "./routeSupport";
import { singleFieldValidationProblem } from "./routeValidation";

export function createPayloadTooLargeProblem() {
  return createProblem({
    detail: MAX_UPLOAD_SIZE_EXCEEDED_DETAIL,
    status: 413,
  });
}

export function missingReleaseMultipartFieldsProblem(
  hasMetadata: boolean,
  hasBundle: boolean,
): ProblemDetails {
  const errors = [
    hasMetadata
      ? null
      : fieldError(
          "metadata",
          "required",
          MISSING_RELEASE_MULTIPART_FIELDS_ERROR,
        ),
    hasBundle
      ? null
      : fieldError("bundle", "required", MISSING_RELEASE_MULTIPART_FIELDS_ERROR),
  ].filter((error): error is ProblemFieldError => error !== null);

  return createValidationProblem(MISSING_RELEASE_MULTIPART_FIELDS_ERROR, errors);
}

export async function parseReleaseCreationMultipartInput(
  request: FastifyRequest,
  deploymentId: string,
  createdBy: string | null,
  storage: StorageAdapter | undefined,
  preflightHandler: ReleaseCreationPreflightRouteHandler | undefined,
  maxUploadSizeBytes: number,
): Promise<
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      input: ReleaseCreationHandlerInput;
      stagedBundleStorageKey: string;
      stagedSourceMapStorageKey: string | null;
    }
> {
  if (!storage) {
    return {
      kind: "error",
      problem: createProblem({
        detail: "release creation is not implemented",
        status: 501,
      }),
    };
  }

  let metadata: ReleaseCreationMetadata | null = null;
  let stagedBundleStorageKey: string | null = null;
  let stagedSourceMapStorageKey: string | null = null;
  let partIndex = 0;
  const uploadSizeState = {
    maxBytes: maxUploadSizeBytes,
    totalBytes: 0,
  };
  const releaseId = createReleaseId();
  const jobId = createReleaseJobId();

  try {
    for await (const part of request.parts()) {
      partIndex += 1;

      if (partIndex === 1 && part.fieldname !== "metadata") {
        await drainMultipartPart(part);

        return {
          kind: "error",
          problem: singleFieldValidationProblem(
            INVALID_MULTIPART_ORDER_ERROR,
            "metadata",
            "invalid_multipart_order",
          ),
        };
      }

      if (part.fieldname === "metadata") {
        if (metadata) {
          await drainMultipartPart(part);
          await cleanupReleaseUploadArtifacts(
            storage,
            stagedBundleStorageKey,
            stagedSourceMapStorageKey,
          );

          return {
            kind: "error",
            problem: singleFieldValidationProblem(
              DUPLICATE_METADATA_PART_ERROR,
              "metadata",
              "duplicate_part",
            ),
          };
        }

        if (part.type !== "field") {
          await drainMultipartPart(part);

          return {
            kind: "error",
            problem: singleFieldValidationProblem(
              INVALID_METADATA_PART_ERROR,
              "metadata",
              "invalid_json",
            ),
          };
        }

        try {
          const parsedMetadata = parseMultipartJson(part.value);
          const metadataResult = parseReleaseCreationMetadata(parsedMetadata);
          if (metadataResult.kind === "error") {
            return metadataResult;
          }

          metadata = metadataResult.value;
        } catch {
          return {
            kind: "error",
            problem: singleFieldValidationProblem(
              INVALID_METADATA_PART_ERROR,
              "metadata",
              "invalid_json",
            ),
          };
        }

        if (preflightHandler) {
          const preflight = await preflightHandler({
            deploymentId,
            signature: metadata.signature,
          });

          if (preflight.outcome !== "accepted") {
            const problem = problemForReleaseCreationFailure(preflight);
            if (problem) {
              return {
                kind: "error",
                problem,
              };
            }
          }
        }

        continue;
      }

      if (part.fieldname === "bundle" && part.type === "file") {
        stagedBundleStorageKey = `_internal/uploads/releases/${releaseId}/bundle.zip`;
        await storage.put(
          stagedBundleStorageKey,
          createAggregateSizeLimitedStream(part.file, uploadSizeState),
          {
            contentType: part.mimetype,
          },
        );
        continue;
      }

      if (part.fieldname === "sourcemap" && part.type === "file") {
        const filename = sanitizeUploadFilename(part.filename);
        stagedSourceMapStorageKey = `_internal/uploads/releases/${releaseId}/sourcemap/${filename}`;
        await storage.put(
          stagedSourceMapStorageKey,
          createAggregateSizeLimitedStream(part.file, uploadSizeState),
          {
            contentType: part.mimetype,
          },
        );
        continue;
      }

      await drainMultipartPart(part);
      await cleanupReleaseUploadArtifacts(
        storage,
        stagedBundleStorageKey,
        stagedSourceMapStorageKey,
      );

      return {
        kind: "error",
        problem: missingReleaseMultipartFieldsProblem(
          metadata !== null,
          stagedBundleStorageKey !== null,
        ),
      };
    }
  } catch (error) {
    await cleanupReleaseUploadArtifacts(
      storage,
      stagedBundleStorageKey,
      stagedSourceMapStorageKey,
    );

    if (
      isPayloadTooLargeError(error) ||
      error instanceof AggregateUploadSizeLimitExceededError
    ) {
      return {
        kind: "error",
        problem: createPayloadTooLargeProblem(),
      };
    }

    throw error;
  }

  if (!metadata || !stagedBundleStorageKey) {
    await cleanupReleaseUploadArtifacts(
      storage,
      stagedBundleStorageKey,
      stagedSourceMapStorageKey,
    );

    return {
      kind: "error",
      problem: missingReleaseMultipartFieldsProblem(
        metadata !== null,
        stagedBundleStorageKey !== null,
      ),
    };
  }

  const stagedZip = await storage.getBuffer(stagedBundleStorageKey);
  if (!stagedZip) {
    await cleanupReleaseUploadArtifacts(
      storage,
      stagedBundleStorageKey,
      stagedSourceMapStorageKey,
    );

    throw new Error(
      `Expected staged bundle object to exist: ${stagedBundleStorageKey}`,
    );
  }

  let targetPackageHash: string;
  try {
    targetPackageHash = computePackageHashFromZipBuffer(stagedZip);
  } catch {
    await cleanupReleaseUploadArtifacts(
      storage,
      stagedBundleStorageKey,
      stagedSourceMapStorageKey,
    );

    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_RELEASE_BUNDLE_ARCHIVE_ERROR,
        "bundle",
        "invalid_archive",
      ),
    };
  }

  return {
    kind: "success",
    input: buildReleaseCreationInput(
      deploymentId,
      createdBy,
      metadata,
      releaseId,
      jobId,
      stagedBundleStorageKey,
      stagedSourceMapStorageKey,
      targetPackageHash,
    ),
    stagedBundleStorageKey,
    stagedSourceMapStorageKey,
  };
}

export class AggregateUploadSizeLimitExceededError extends Error {
  constructor() {
    super(MAX_UPLOAD_SIZE_EXCEEDED_DETAIL);
    this.name = "AggregateUploadSizeLimitExceededError";
  }
}

export interface ReleaseUploadSizeState {
  maxBytes: number;
  totalBytes: number;
}

export function createAggregateSizeLimitedStream(
  stream: Readable,
  state: ReleaseUploadSizeState,
): Readable {
  return Readable.from(limitAggregateUploadSize(stream, state));
}

async function* limitAggregateUploadSize(
  stream: AsyncIterable<unknown>,
  state: ReleaseUploadSizeState,
): AsyncGenerator<Buffer | string | Uint8Array> {
  for await (const chunk of stream) {
    state.totalBytes += chunkByteLength(chunk);

    if (state.totalBytes > state.maxBytes) {
      throw new AggregateUploadSizeLimitExceededError();
    }

    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      yield chunk;
      continue;
    }

    if (chunk instanceof Uint8Array) {
      yield chunk;
      continue;
    }

    throw new Error("unsupported multipart upload chunk type");
  }
}

export function chunkByteLength(chunk: unknown): number {
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }

  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }

  throw new Error("unsupported multipart upload chunk type");
}

export function isPayloadTooLargeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
      error.code === "FST_REQ_FILE_TOO_LARGE" ||
      error.code === "FST_FILES_LIMIT" ||
      error.code === "FST_PARTS_LIMIT")
  );
}

export function parseMultipartJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("multipart JSON field must be a string");
  }

  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("multipart JSON field must contain an object");
  }

  return parsed as Record<string, unknown>;
}

export function sanitizeUploadFilename(filename: string | undefined): string {
  if (!filename) {
    return "upload.bin";
  }

  const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "upload.bin";
}

export async function cleanupReleaseUploadArtifacts(
  storage: StorageAdapter,
  stagedBundleStorageKey: string | null,
  stagedSourceMapStorageKey: string | null,
): Promise<void> {
  await Promise.all([
    stagedBundleStorageKey
      ? storage.delete(stagedBundleStorageKey).catch(() => undefined)
      : Promise.resolve(),
    stagedSourceMapStorageKey
      ? storage.delete(stagedSourceMapStorageKey).catch(() => undefined)
      : Promise.resolve(),
  ]);
}

export async function drainMultipartPart(part: Multipart): Promise<void> {
  if (part.type !== "file") {
    return;
  }

  for await (const chunk of part.file) {
    void chunk;
    // Drain discarded file streams so Fastify can continue parsing.
  }
}

function fieldError(
  field: string,
  reason: "required",
  message: string,
): ProblemFieldError {
  return {
    field,
    message,
    reason,
  };
}
