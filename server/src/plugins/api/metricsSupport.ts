import { randomUUID } from "node:crypto";

import { isValidBinaryVersion } from "./binaryVersion";
import type {
  ProblemDetails,
  ProblemFieldError,
} from "../../app/problemDetails";
import type { MetricEventIngestHandlerInput } from "../../app/types";
import {
  INVALID_BINARY_VERSION_ERROR,
  INVALID_METRIC_DELIVERY_TYPE_ERROR,
  INVALID_METRIC_EVENT_BODY_ERROR,
  INVALID_METRIC_EVENT_EMITTED_AT_ERROR,
  INVALID_METRIC_EVENT_NAME_ERROR,
} from "./routeSupport";
import {
  isJsonObject,
  requiredStringFieldError,
  singleFieldValidationProblem,
  validationProblem,
} from "./routeValidation";

export function parseMetricEventInput(body: unknown):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: MetricEventIngestHandlerInput;
    } {
  if (!isJsonObject(body)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_METRIC_EVENT_BODY_ERROR,
        "body",
        "invalid_type",
      ),
    };
  }

  const requiredErrors = [
    requiredStringFieldError("event_id", body.event_id, "event_id is required"),
    requiredStringFieldError(
      "event_name",
      body.event_name,
      "event_name is required",
    ),
    requiredStringFieldError(
      "emitted_at",
      body.emitted_at,
      "emitted_at is required",
    ),
    requiredStringFieldError(
      "deployment_key",
      body.deployment_key,
      "deployment_key is required",
    ),
    requiredStringFieldError(
      "device_id",
      body.device_id,
      "device_id is required",
    ),
  ].filter((error): error is ProblemFieldError => error !== null);

  if (requiredErrors.length > 0) {
    return {
      kind: "error",
      problem: validationProblem("metric event is missing required fields", requiredErrors),
    };
  }

  if (!isMetricEventName(body.event_name)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_METRIC_EVENT_NAME_ERROR,
        "event_name",
        typeof body.event_name === "string" ? "invalid_value" : "invalid_type",
      ),
    };
  }

  const emittedAt = new Date(body.emitted_at as string);
  if (Number.isNaN(emittedAt.getTime())) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_METRIC_EVENT_EMITTED_AT_ERROR,
        "emitted_at",
        "invalid_value",
      ),
    };
  }

  const binaryVersion = parseOptionalStringField(body.binary_version);
  if (binaryVersion.kind === "error") {
    return metricOptionalStringProblem("binary_version");
  }
  if (
    binaryVersion.value !== null &&
    !isValidBinaryVersion(binaryVersion.value)
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_BINARY_VERSION_ERROR,
        "binary_version",
        "invalid_format",
      ),
    };
  }

  const attributes = body.attributes ?? null;
  if (attributes !== null && !isJsonObject(attributes)) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        "attributes must be a JSON object or null",
        "attributes",
        "invalid_type",
      ),
    };
  }

  const deliveryType = attributes?.delivery_type;
  const deliveryTypeRequired =
    body.event_name === "Downloaded" ||
    body.event_name === "Installed" ||
    body.event_name === "Success";
  if (
    (deliveryTypeRequired || deliveryType !== undefined) &&
    deliveryType !== "patch" &&
    deliveryType !== "full_bundle"
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        INVALID_METRIC_DELIVERY_TYPE_ERROR,
        "attributes.delivery_type",
        deliveryType === undefined ? "required" : "invalid_value",
      ),
    };
  }

  const runningPackageHash = parseOptionalStringField(
    body.running_package_hash,
  );
  if (runningPackageHash.kind === "error") {
    return metricOptionalStringProblem("running_package_hash");
  }

  const targetPackageHash = parseOptionalStringField(body.target_package_hash);
  if (targetPackageHash.kind === "error") {
    return metricOptionalStringProblem("target_package_hash");
  }

  const sdkVersion = parseOptionalStringField(body.sdk_version);
  if (sdkVersion.kind === "error") {
    return metricOptionalStringProblem("sdk_version");
  }

  const platform = parseOptionalStringField(body.platform);
  if (platform.kind === "error") {
    return metricOptionalStringProblem("platform");
  }

  return {
    kind: "success",
    value: {
      attributes,
      binaryVersion: binaryVersion.value,
      deploymentKey: body.deployment_key as string,
      deviceId: body.device_id as string,
      emittedAt,
      eventId: body.event_id as string,
      eventName: body.event_name,
      id: createMetricEventId(),
      platform: platform.value,
      runningPackageHash: runningPackageHash.value,
      sdkVersion: sdkVersion.value,
      targetPackageHash: targetPackageHash.value,
    },
  };
}

/**
 * Extracts the event_id from an envelope that failed validation so the route
 * can acknowledge-and-drop it: the client's only other drop path is a
 * whole-batch 4xx, and an unacknowledged event would be retried until the
 * 7-day retention window expires even though retrying cannot fix it.
 */
export function extractAcknowledgeableEventId(body: unknown): string | null {
  if (!isJsonObject(body)) {
    return null;
  }

  return typeof body.event_id === "string" && body.event_id.length > 0
    ? body.event_id
    : null;
}

export function isMetricEventName(
  value: unknown,
): value is MetricEventIngestHandlerInput["eventName"] {
  return (
    value === "Downloaded" ||
    value === "Installed" ||
    value === "Success" ||
    value === "Failed" ||
    value === "Active"
  );
}

export function parseOptionalStringField(value: unknown):
  | {
      kind: "success";
      value: string | null;
    }
  | {
      kind: "error";
    } {
  if (value === undefined || value === null) {
    return {
      kind: "success",
      value: null,
    };
  }

  if (typeof value !== "string") {
    return {
      kind: "error",
    };
  }

  return {
    kind: "success",
    value: value.length > 0 ? value : null,
  };
}

export function metricOptionalStringProblem(field: string): {
  kind: "error";
  problem: ProblemDetails;
} {
  return {
    kind: "error",
    problem: singleFieldValidationProblem(
      `${field} must be a string or null`,
      field,
      "invalid_type",
    ),
  };
}

export function createMetricEventId(): string {
  return `me_${randomUUID().replace(/-/g, "")}`;
}
