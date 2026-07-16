export const INVALID_BINARY_VERSION_ERROR =
  "binary_version must start with an alphanumeric character, contain only alphanumeric characters, '.', '_', '+', or '-', and be at most 128 characters";
export const INVALID_MULTIPART_ORDER_ERROR =
  "metadata must be the first multipart part";
export const DUPLICATE_METADATA_PART_ERROR = "metadata multipart part must be unique";
export const INVALID_METADATA_PART_ERROR = "metadata must be a JSON multipart field";
export const RELEASE_MULTIPART_REQUIRED_ERROR =
  "release creation requires multipart/form-data";
export const MISSING_RELEASE_MULTIPART_FIELDS_ERROR =
  "metadata and bundle multipart parts are required";
export const MISSING_RELEASE_METADATA_FIELDS_ERROR =
  "release metadata fields are required";
export const INVALID_RELEASE_ROLLOUT_ERROR =
  "rollout_percentage must be an integer between 1 and 100";
export const INVALID_RELEASE_SIGNATURE_HASH_ALGORITHM_ERROR =
  "signature_hash_algorithm requires signature to also be provided";
export const SIGNED_RELEASE_SIGNATURE_HASH_ALGORITHM = "sha256";
export const INVALID_RELEASE_PATCH_STATUS_ERROR =
  "status must be either published or disabled";
export const INVALID_RELEASE_PATCH_STATUS_COMBINATION_ERROR =
  "status cannot be combined with other release patch fields";
export const INVALID_RELEASE_PATCH_NOTES_ERROR =
  "release_notes must be a string or null";
export const MAX_IAM_INVITATION_EXPIRES_IN_DAYS = 90;
export const INVALID_RELEASE_PATCH_MANDATORY_ERROR = "is_mandatory must be a boolean";
export const INVALID_RELEASE_PROMOTE_DISABLED_ERROR = "disabled must be a boolean";
export const INVALID_RELEASE_PROMOTE_NO_DUPLICATE_ERROR =
  "no_duplicate_release_error must be a boolean";
export const INVALID_RELEASE_BUNDLE_ARCHIVE_ERROR = "bundle archive is invalid";
export const INVALID_RELEASE_LIST_LIMIT_ERROR =
  "limit must be an integer between 1 and 100";
export const INVALID_RELEASE_LIST_OFFSET_ERROR =
  "offset must be an integer greater than or equal to 0";
export const UNSUPPORTED_RELEASE_LIST_INCLUDE_ERROR =
  "include must be metrics when provided";
export const INVALID_METRIC_EVENT_BODY_ERROR =
  "metric event must be a JSON object";
export const INVALID_METRIC_EVENTS_BATCH_ERROR =
  "request body must be a JSON object with an events array of metric event envelopes";
export const METRIC_EVENTS_BATCH_LIMIT = 100;
export const METRIC_EVENTS_BATCH_TOO_LARGE_ERROR =
  `events must contain at most ${METRIC_EVENTS_BATCH_LIMIT} metric event envelopes`;
export const INVALID_METRIC_EVENT_NAME_ERROR =
  "event_name must be one of Downloaded, Installed, Success, Failed, or Active";
export const INVALID_METRIC_EVENT_EMITTED_AT_ERROR =
  "emitted_at must be a valid ISO timestamp";
export const INVALID_METRIC_DELIVERY_TYPE_ERROR =
  "attributes.delivery_type must be either patch or full_bundle";
export const INVALID_METRICS_TIMESERIES_FROM_ERROR =
  "from must be a valid ISO timestamp";
export const INVALID_METRICS_TIMESERIES_TO_ERROR =
  "to must be a valid ISO timestamp";
export const DEFAULT_METRICS_TIMESERIES_SERIES_LIMIT = 50;
export const MAX_METRICS_TIMESERIES_SERIES_LIMIT = 50;
export const INVALID_METRICS_TIMESERIES_SERIES_LIMIT_ERROR =
  `series_limit must be an integer between 1 and ${MAX_METRICS_TIMESERIES_SERIES_LIMIT}`;
export const METRICS_TIMESERIES_RANGE_ORDER_ERROR =
  "from must be earlier than to";
export const METRICS_TIMESERIES_RANGE_DAYS_LIMIT = 366;
export const METRICS_TIMESERIES_RANGE_TOO_LARGE_ERROR =
  `from and to must span at most ${METRICS_TIMESERIES_RANGE_DAYS_LIMIT} days after from is truncated to its UTC day`;
export const DUPLICATE_RELEASE_DETAIL =
  "release content is identical to the latest published release";
export const MANAGEMENT_NOT_ENABLED_ERROR = "management api is not enabled";
export const MAX_API_TOKEN_EXPIRATION_DAYS = 3650;
export const INVALID_API_TOKEN_EXPIRATION_DAYS_ERROR =
  `expires_in_days must be a positive integer no greater than ${MAX_API_TOKEN_EXPIRATION_DAYS}`;
export const INVALID_IDEMPOTENCY_KEY_ERROR =
  "Idempotency-Key must be a non-empty string";
export const MAX_OAUTH_PUBLIC_STRING_LENGTH = 4096;
