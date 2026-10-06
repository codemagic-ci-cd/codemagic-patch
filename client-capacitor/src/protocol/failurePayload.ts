// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/failurePayload.ts (Apache-2.0). One change from upstream, documented in
// specs/UPSTREAM-DIVERGENCE.md and verified against ionic-team/capacitor@main rather than
// assumed: where a rejected native call carries extra structured detail, RN nests it
// under `error.userInfo.<key>`; Capacitor nests it under `error.data.<key>` instead.
//
// Verified by reading the actual bridge code on both platforms:
//   - Android `PluginCall.reject(msg, code, ex, data)` — PluginCall.java —
//     `errorResult.put("data", data)`, i.e. nested under a `data` key, not flattened.
//   - iOS `CAPPluginCallError.init(message:code:error:data:)` — PluginCallResult.swift —
//     `resultData = .dictionary(["data": data])`, same nesting.
//   - The JS-side native bridge (`native-bridge.ts`) copies every key of the arriving
//     `result.error` object onto a `new cap.Exception('')` — so a Capacitor plugin
//     rejection surfaces in JS as an Error/Exception whose own `.data` property is
//     whatever dictionary the native `reject()` call passed, unchanged.
//
// This is a Phase 4 concern in practice (native downloadUpdate()/fetchManifest() are
// still `UNIMPLEMENTED` stubs as of Phase 1) but is ported now so the contract is fixed
// before Phase 4's native implementations are written against it: whoever implements
// downloadUpdate() on each platform must reject with `data: { detail_code, detail_message }`
// to satisfy this file. That obligation is recorded in
// specs/PROTOCOL-CONFORMANCE.md and specs/OPEN-QUESTIONS.md.
//
// `Failed(reason=network)` payload construction — the download-failure payload
// defined in PROTOCOL.md §Metric Event `Failed` Payload.
//
// `code` is the HTTP status of the failed response, or `"0"` when the request
// produced no HTTP response at all. Native knows the status and hands it back
// through the rejection's `data.detail_code`; the public
// `CodemagicPatchError.code` an app catches is deliberately left alone.
// Anything that does not arrive as a plain status becomes `"0"` rather than a
// freely invented value, so the aggregation key space stays the enumerable set
// of HTTP statuses.

import { state } from './runtime';
import type { MetricsFailurePayload } from './types';

/** Native's HTTP-status channel on a rejected plugin call — see the file header. */
const DETAIL_CODE_KEY = 'detail_code';

/**
 * The failure text destined for the payload, carried separately from the
 * rejection's own `message`. The two have different jobs: the rejection message
 * is host-facing and may prepend context a developer wants in a stack trace —
 * iOS prefixes the requested URL — while PROTOCOL.md asks the payload to relay
 * what the platform or origin reported and nothing else. Keeping them apart is
 * what stops that URL, deployment key and all, from riding into telemetry on
 * text the SDK was only supposed to pass through.
 */
const DETAIL_MESSAGE_KEY = 'detail_message';

/** PROTOCOL.md: no HTTP response was received. */
const NO_RESPONSE_CODE = '0';

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

  return exitReason === null ? undefined : { android_previous_process_exit: exitReason };
}

/**
 * Builds the download-failure payload from a rejected native call.
 *
 * `error` is whatever the plugin call rejected with, so every field
 * read from it is defensive: a rejection that carries no status still yields a
 * well-formed payload.
 */
export function networkFailurePayload(error: unknown): MetricsFailurePayload {
  return {
    ...commonFailurePayload(),
    code: normalizeCode(readDataString(error, DETAIL_CODE_KEY)),
    message: truncateUtf8(readMessage(error), MESSAGE_MAX_BYTES),
  };
}

/**
 * Reads a string field off a rejected native call's `error.data`. Exported so
 * other call sites can read a native rejection's own `data` fields the same
 * way this file does for `detail_code`/`detail_message`, without duplicating
 * this same defensive unwrapping — see `checkForUpdate.ts`'s use for
 * `deployment_key`/`binary_version`, attached to a rejected `fetchManifest()`
 * call so its `Failed(reason=network)` event can carry them even though
 * `state.deploymentKey`/`state.binaryVersion` have no other source before a
 * manifest fetch first succeeds.
 */
export function readDataString(error: unknown, key: string): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const data = (error as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function readMessage(error: unknown): string {
  const detailMessage = readDataString(error, DETAIL_MESSAGE_KEY);
  if (detailMessage !== null) {
    return detailMessage;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return '';
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
  let result = '';
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
