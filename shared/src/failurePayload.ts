// The `Failed` metric event payload — root `PROTOCOL.md` §Metric Event
// `Failed` Payload.
//
// One shape for every reason. The uniformity is the point: a dashboard that
// drills reason → code → messages works identically whichever failure it is
// looking at, and a reason that gains a payload later needs no new UI. A
// reason with nothing to report omits `payload` entirely rather than inventing
// a different shape.
//
// This module is the definition server and dashboard share. The React Native
// SDK cannot import it — it ships as a standalone npm package with no
// workspace dependency — so `client/src/failurePayload.ts` mirrors it and says
// so; PROTOCOL.md is what both answer to.

/**
 * Every field is optional. A reason reports what it can and omits the rest —
 * a download failure has a status and text to relay, a crash rollback has
 * neither but does have the platform's account of why the previous process
 * died. Requiring a field would force one of them to send a placeholder, and
 * an empty required field reads worse than an absent optional one.
 *
 * A payload with nothing to put in any field is not sent at all: `payload` is
 * omitted rather than serialized as `{}`.
 */
export interface FailurePayload {
  /**
   * The failure's machine-readable discriminator, and the key every
   * server-side and dashboard breakdown groups on. Per-reason meaning:
   * `network` carries the HTTP status of the failed response as a decimal
   * string, or `"0"` when no response was received.
   */
  code?: string;
  /**
   * Failure text relayed from whatever reported it — the platform's raw error
   * for a transport failure, the origin's error document for an HTTP status.
   * Never composed by the client; omitted when nothing could be relayed.
   */
  message?: string;
  /**
   * Why this app's previous process ended, as an Android `ApplicationExitInfo`
   * reason constant name. **Android only**, and only on API 30+; iOS and older
   * Android have no platform API that answers the question, so the field is
   * simply absent there.
   */
  android_previous_process_exit?: string;
}

/**
 * Narrows a decoded payload to {@link FailurePayload}.
 *
 * Every field being optional makes this a shape check rather than a presence
 * check: any object qualifies, and a field only fails it by being present with
 * the wrong type. That tolerance is deliberate — PROTOCOL.md §Backward
 * Compatibility Is Mandatory obliges every reader to accept payloads an older
 * or newer SDK wrote, so unknown keys pass through untouched.
 */
export function isFailurePayload(value: unknown): value is FailurePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (["android_previous_process_exit", "code", "message"] as const).every(
    (field) =>
      candidate[field] === undefined || typeof candidate[field] === "string",
  );
}
