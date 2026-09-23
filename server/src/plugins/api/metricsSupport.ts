import { randomUUID } from "node:crypto";

import { isValidBinaryVersion } from "./binaryVersion";
import type {
  ProblemDetails,
  ProblemFieldError,
} from "../../app/problemDetails";
import type {
  DeploymentTimeseriesHandlerInput,
  FailureBucketHandlerInput,
  FailureCodesHandlerInput,
  FailureEventsHandlerInput,
  MetricEventIngestHandlerInput,
} from "../../app/types";
import {
  DEFAULT_METRICS_FAILURE_EVENTS_LIMIT,
  DEFAULT_METRICS_TIMESERIES_SERIES_LIMIT,
  INVALID_BINARY_VERSION_ERROR,
  INVALID_METRICS_FAILURE_EVENTS_LIMIT_ERROR,
  MAX_METRICS_FAILURE_EVENTS_LIMIT,
  MISSING_METRICS_FAILURE_REASON_ERROR,
  INVALID_METRIC_DELIVERY_TYPE_ERROR,
  INVALID_METRIC_EVENT_BODY_ERROR,
  INVALID_METRIC_EVENT_EMITTED_AT_ERROR,
  INVALID_METRIC_EVENT_NAME_ERROR,
  INVALID_METRICS_TIMESERIES_FROM_ERROR,
  INVALID_METRICS_TIMESERIES_SERIES_LIMIT_ERROR,
  INVALID_METRICS_TIMESERIES_TO_ERROR,
  MAX_METRICS_TIMESERIES_SERIES_LIMIT,
  METRIC_EVENT_FAILURE_PAYLOAD_MAX_BYTES,
  METRICS_TIMESERIES_RANGE_DAYS_LIMIT,
  METRICS_TIMESERIES_RANGE_ORDER_ERROR,
  METRICS_TIMESERIES_RANGE_TOO_LARGE_ERROR,
} from "./routeSupport";
import type {
  FailureBucketQuery,
  FailureCodesQuery,
  FailureEventsQuery,
  TimeseriesRangeQuery,
} from "./routeTypes";
import {
  isJsonObject,
  parseBoundedIntegerQueryParam,
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

  const eventName = resolveMetricEventName(body.event_name);
  if (eventName === null) {
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
    eventName === "Downloaded" ||
    eventName === "Ready" ||
    eventName === "Applied";
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
      eventName,
      failurePayload: decodeFailurePayload(attributes),
      id: createMetricEventId(),
      platform: platform.value,
      runningPackageHash: runningPackageHash.value,
      sdkVersion: sdkVersion.value,
      targetPackageHash: targetPackageHash.value,
    },
  };
}

/**
 * Decodes `attributes.payload` (PROTOCOL.md §Metric Event `Failed` Payload).
 *
 * Every rejection path returns null rather than a validation problem: the
 * payload is best-effort detail, and dropping a `Failed` event because its
 * detail blob was malformed would lose the count that actually matters. The
 * raw string stays in `attributes` regardless, so an undecodable payload is
 * still recoverable from the stored row.
 */
export function decodeFailurePayload(
  attributes: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const payload = attributes?.payload;
  if (typeof payload !== "string") {
    return null;
  }

  if (Buffer.byteLength(payload, "utf8") > METRIC_EVENT_FAILURE_PAYLOAD_MAX_BYTES) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }

  return isJsonObject(decoded) ? decoded : null;
}

/**
 * Parses the failure-codes drill-down query.
 *
 * `reason` is the only parameter. The code list is returned whole rather than
 * paged: its value space is the enumerable set of HTTP statuses plus two
 * sentinels, so it is bounded by the payload contract rather than by how much
 * data has accumulated, exactly like the reason counts it drills into.
 */
export function parseFailureCodesInput(query: FailureCodesQuery):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: FailureCodesHandlerInput;
    } {
  const reason = typeof query.reason === "string" ? query.reason.trim() : "";
  if (reason.length === 0) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        MISSING_METRICS_FAILURE_REASON_ERROR,
        "reason",
        query.reason === undefined ? "required" : "invalid_value",
      ),
    };
  }

  return { kind: "success", value: { reason } };
}

/**
 * Parses a query addressing one `payload.code` bucket.
 *
 * `code` is genuinely optional: an omitted `code` selects the bucket of
 * failures whose payload carried none, which is a real bucket the reader opens
 * like any other, not a missing parameter. No sentinel value is needed because
 * these endpoints never address "every code at once".
 */
export function parseFailureBucketInput(query: FailureBucketQuery):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: FailureBucketHandlerInput;
    } {
  const base = parseFailureCodesInput(query);
  if (base.kind === "error") {
    return base;
  }

  return {
    kind: "success",
    value: {
      ...base.value,
      code:
        typeof query.code === "string" && query.code.length > 0
          ? query.code
          : null,
    },
  };
}

/**
 * Parses the raw-event feed query.
 *
 * `cursor` is opaque and echoed back unvalidated: the repository restarts the
 * feed on anything it cannot parse, which is a better answer than an error
 * page for a scroll position that can only be wrong if a client invented it.
 */
export function parseFailureEventsInput(query: FailureEventsQuery):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: FailureEventsHandlerInput;
    } {
  const base = parseFailureBucketInput(query);
  if (base.kind === "error") {
    return base;
  }

  const limit = parseBoundedIntegerQueryParam(query.limit, {
    defaultValue: DEFAULT_METRICS_FAILURE_EVENTS_LIMIT,
    field: "limit",
    max: MAX_METRICS_FAILURE_EVENTS_LIMIT,
    min: 1,
    problemDetail: INVALID_METRICS_FAILURE_EVENTS_LIMIT_ERROR,
  });
  if (limit.kind === "error") {
    return limit;
  }

  return {
    kind: "success",
    value: {
      ...base.value,
      cursor:
        typeof query.cursor === "string" && query.cursor.length > 0
          ? query.cursor
          : null,
      limit: limit.value,
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMESERIES_RANGE_DAYS = 30;

/**
 * Parses the `from` / `to` range of the timeseries endpoint. `from` is
 * truncated down to its UTC day boundary so the first bucket is never
 * partial, and the 366-day range cap is measured on that effective range.
 */
export function parseDeploymentTimeseriesInput(
  deploymentId: string,
  query: TimeseriesRangeQuery,
  now: Date = new Date(),
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: DeploymentTimeseriesHandlerInput;
    } {
  const seriesLimit = parseBoundedIntegerQueryParam(query.series_limit, {
    defaultValue: DEFAULT_METRICS_TIMESERIES_SERIES_LIMIT,
    field: "series_limit",
    max: MAX_METRICS_TIMESERIES_SERIES_LIMIT,
    min: 1,
    problemDetail: INVALID_METRICS_TIMESERIES_SERIES_LIMIT_ERROR,
  });
  if (seriesLimit.kind === "error") {
    return seriesLimit;
  }

  const to = parseDatetimeQueryParam(
    query.to,
    "to",
    INVALID_METRICS_TIMESERIES_TO_ERROR,
    now,
  );
  if (to.kind === "error") {
    return to;
  }

  const from = parseDatetimeQueryParam(
    query.from,
    "from",
    INVALID_METRICS_TIMESERIES_FROM_ERROR,
    new Date(to.value.getTime() - DEFAULT_TIMESERIES_RANGE_DAYS * DAY_MS),
  );
  if (from.kind === "error") {
    return from;
  }

  const truncatedFrom = new Date(
    Date.UTC(
      from.value.getUTCFullYear(),
      from.value.getUTCMonth(),
      from.value.getUTCDate(),
    ),
  );

  if (from.value.getTime() >= to.value.getTime()) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        METRICS_TIMESERIES_RANGE_ORDER_ERROR,
        "from",
        "out_of_range",
      ),
    };
  }

  if (
    to.value.getTime() - truncatedFrom.getTime() >
    METRICS_TIMESERIES_RANGE_DAYS_LIMIT * DAY_MS
  ) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(
        METRICS_TIMESERIES_RANGE_TOO_LARGE_ERROR,
        "from",
        "out_of_range",
      ),
    };
  }

  return {
    kind: "success",
    value: {
      deploymentId,
      from: truncatedFrom,
      seriesLimit: seriesLimit.value,
      to: to.value,
    },
  };
}

function parseDatetimeQueryParam(
  value: unknown,
  field: string,
  errorDetail: string,
  defaultValue: Date,
):
  | {
      kind: "error";
      problem: ProblemDetails;
    }
  | {
      kind: "success";
      value: Date;
    } {
  if (value === undefined) {
    return {
      kind: "success",
      value: defaultValue,
    };
  }

  if (typeof value !== "string") {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(errorDetail, field, "invalid_type"),
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return {
      kind: "error",
      problem: singleFieldValidationProblem(errorDetail, field, "invalid_value"),
    };
  }

  return {
    kind: "success",
    value: parsed,
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

/**
 * SDK releases before the Ready/Applied rename (0.4.x and earlier) still emit
 * `Installed` and `Success`. Ingest stores them under the new names so a server
 * upgrade does not drop metrics from apps already in the field (PROTOCOL.md
 * §Metric Lifecycle Names). Remove the aliases once those SDKs are unsupported.
 */
function resolveMetricEventName(
  value: unknown,
): MetricEventIngestHandlerInput["eventName"] | null {
  if (isMetricEventName(value)) {
    return value;
  }
  if (value === "Installed") {
    return "Ready";
  }
  if (value === "Success") {
    return "Applied";
  }
  return null;
}

export function isMetricEventName(
  value: unknown,
): value is MetricEventIngestHandlerInput["eventName"] {
  return (
    value === "Downloaded" ||
    value === "Ready" ||
    value === "Applied" ||
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
