import {
  createValidationProblem,
  type ProblemDetails,
  type ProblemFieldError,
} from "../../app/problemDetails";

export type ValidationErrorReason =
  | "duplicate_part"
  | "invalid_archive"
  | "invalid_combination"
  | "invalid_json"
  | "invalid_multipart_order"
  | "invalid_format"
  | "invalid_type"
  | "invalid_value"
  | "out_of_range"
  | "required";

export function headerToSingleValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function parseRequiredTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function validationProblem(
  detail: string,
  errors: ProblemFieldError[],
): ProblemDetails {
  return createValidationProblem(detail, errors);
}

export function singleFieldValidationProblem(
  detail: string,
  field: string,
  reason: ValidationErrorReason,
  message = detail,
): ProblemDetails {
  return validationProblem(detail, [fieldError(field, reason, message)]);
}

export function fieldError(
  field: string,
  reason: ValidationErrorReason,
  message: string,
): ProblemFieldError {
  return {
    field,
    message,
    reason,
  };
}

export function requiredStringFieldError(
  field: string,
  value: unknown,
  message: string,
): ProblemFieldError | null {
  if (typeof value === "string" && value.length > 0) {
    return null;
  }

  return fieldError(field, requiredStringReason(value), message);
}

export function requiredStringReason(value: unknown): ValidationErrorReason {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return "required";
  }

  return "invalid_type";
}

export function numericRangeReason(value: unknown): ValidationErrorReason {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "invalid_type";
  }
  return "out_of_range";
}

export function rolloutPercentageReason(value: unknown): ValidationErrorReason {
  return numericRangeReason(value);
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
