// `Failed(reason=network)` payload construction — the download-failure payload
// defined in PROTOCOL.md §Metric Event `Failed` Payload.
//
// `code` is the HTTP status of the failed response, or `"0"` when the request
// produced no HTTP response at all. Native knows the status and hands it back
// through the rejection's `userInfo.detail_code`; the public
// `CodemagicPatchError.code` an app catches is deliberately left alone.
// Anything that does not arrive as a plain status becomes `"0"` rather than a
// freely invented value, so the aggregation key space stays the enumerable set
// of HTTP statuses.

import { state } from "./runtime";
import type { MetricsFailurePayload } from "./types";

/** Native's HTTP-status channel on a rejected NativeModule promise. */
const DETAIL_CODE_KEY = "detail_code";

/**
 * The failure text destined for the payload, carried separately from the
 * rejection's own `message`. The two have different jobs: the rejection message
 * is host-facing and may prepend context a developer wants in a stack trace —
 * iOS prefixes the requested URL — while PROTOCOL.md asks the payload to relay
 * what the platform or origin reported and nothing else. Keeping them apart is
 * what stops that URL, deployment key and all, from riding into telemetry on
 * text the SDK was only supposed to pass through.
 */
const DETAIL_MESSAGE_KEY = "detail_message";

/** PROTOCOL.md: no HTTP response was received. */
const NO_RESPONSE_CODE = "0";

/** PROTOCOL.md caps `message` at 512 bytes. */
const MESSAGE_MAX_BYTES = 512;

/** A decimal HTTP status, or the no-response sentinel. */
const CODE_PATTERN = /^[0-9]{1,3}$/;

/**
 * The payload for a reason that has no failure text of its own to relay.
 *
 * Carries only the fields the platform can fill, which today means the
 * previous process's exit reason. Returns undefined when even that is
 * unavailable — a payload with nothing in it is omitted rather than sent as
 * an empty object.
 */
export function commonFailurePayload(): MetricsFailurePayload | undefined {
  const exitReason = state.androidPreviousProcessExit;

  return exitReason === null
    ? undefined
    : { android_previous_process_exit: exitReason };
}

/**
 * Builds the download-failure payload from a rejected native call.
 *
 * `error` is whatever the NativeModule promise rejected with, so every field
 * read from it is defensive: a rejection that carries no status still yields a
 * well-formed payload.
 */
export function networkFailurePayload(error: unknown): MetricsFailurePayload {
  return {
    ...commonFailurePayload(),
    code: normalizeCode(readUserInfoString(error, DETAIL_CODE_KEY)),
    message: truncateUtf8(readMessage(error), MESSAGE_MAX_BYTES),
  };
}

function readUserInfoString(error: unknown, key: string): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const userInfo = (error as { userInfo?: unknown }).userInfo;
  if (typeof userInfo !== "object" || userInfo === null) {
    return null;
  }

  const value = (userInfo as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readMessage(error: unknown): string {
  const detailMessage = readUserInfoString(error, DETAIL_MESSAGE_KEY);
  if (detailMessage !== null) {
    return detailMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return "";
}

/**
 * Anything that is not a plain decimal HTTP status collapses to the
 * no-response sentinel. Enforcing the shape at the boundary — rather than
 * trusting whatever native sent — is what keeps a stray URL or error name out
 * of the dashboard's grouping key.
 */
function normalizeCode(code: string | null): string {
  if (code === null) {
    return NO_RESPONSE_CODE;
  }

  const trimmed = code.trim();
  return CODE_PATTERN.test(trimmed) ? trimmed : NO_RESPONSE_CODE;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

/**
 * Truncates on a code-point boundary so a multi-byte character is never split
 * into an invalid sequence by the byte cap.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) {
    return text;
  }

  let bytes = 0;
  let result = "";
  for (const character of text) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    result += character;
  }

  return result;
}
