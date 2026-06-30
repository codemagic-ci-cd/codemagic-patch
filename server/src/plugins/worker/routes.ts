import type { FastifyPluginAsync } from "fastify";

import {
  createProblem,
  createValidationProblem,
  sendProblem,
} from "../../app/problemDetails";
import type {
  WorkerReconcileHandlerResult,
  WorkerReconcileRouteHandler,
} from "../../app/types";

interface ReconcileRequestBody {
  job_id?: string;
}

interface WorkerRoutesOptions {
  mode: "all" | "worker";
  workerReconcileHandler?: WorkerReconcileRouteHandler;
  workerSharedSecret?: string;
}

export const workerRoutes: FastifyPluginAsync<WorkerRoutesOptions> = async (
  app,
  options,
) => {
  app.post<{ Body: ReconcileRequestBody }>(
    "/worker/reconcile",
    async (request, reply) => {
      if (
        options.workerSharedSecret &&
        request.headers["x-codemagic-patch-worker-secret"] !== options.workerSharedSecret
      ) {
        return sendProblem(
          reply,
          createProblem({
            detail: "worker authentication is required",
            status: 401,
            typeSuffix: "authentication-required",
          }),
        );
      }

      const jobId = request.body?.job_id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        return sendProblem(reply, createWorkerValidationProblem("job_id is required"));
      }

      if (options.workerReconcileHandler) {
        const result = await options.workerReconcileHandler(jobId);

        if (result.outcome === "failed" && result.retryable) {
          reply.status(503);
        }

        return {
          job_id: jobId,
          ok: true,
          result: toReconcileResultWire(result),
        };
      }

      return {
        job_id: jobId,
        mode: options.mode,
        ok: true,
      };
    },
  );
};

function createWorkerValidationProblem(detail: string) {
  return createValidationProblem(detail, [
    {
      field: "job_id",
      message: detail,
      reason: "required",
    },
  ]);
}

function toReconcileResultWire(result: WorkerReconcileHandlerResult) {
  if (result.outcome === "succeeded") {
    return {
      outcome: result.outcome,
      plan_summary: {
        bundle_internal_upload: result.planSummary.bundleInternalUpload,
        bundle_public_copy_count: result.planSummary.bundlePublicCopyCount,
        manifest_count: result.planSummary.manifestCount,
        needs_deployment_meta_update: result.planSummary.needsDeploymentMetaUpdate,
        patch_count: result.planSummary.patchCount,
      },
    };
  }

  if (result.outcome === "noop") {
    return {
      outcome: result.outcome,
      reason: result.reason,
    };
  }

  return {
    outcome: result.outcome,
    reason: result.reason,
    ...(result.retryAttemptCount !== undefined
      ? { retry_attempt_count: result.retryAttemptCount }
      : {}),
    retryable: result.retryable,
    stage: result.stage,
  };
}
