import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import type { ResolvedWebhookTarget } from "./target";

export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

export type WebhookSendResult =
  | { kind: "response"; status: number }
  | { kind: "error"; error: "timeout" | "network_error" };

export interface WebhookSendInput {
  body: string;
  headers: Record<string, string>;
  /** The addresses the target check approved. The request connects to one of them. */
  targets: readonly ResolvedWebhookTarget[];
  timeoutMs?: number;
  url: URL;
}

export type WebhookSender = (input: WebhookSendInput) => Promise<WebhookSendResult>;

/**
 * One POST. Connects to the addresses that were checked rather than resolving
 * the host again, so the name cannot be re-pointed between the check and the
 * connection; the host name is still what TLS verifies. When the host has
 * several addresses Node tries them in turn, so one that cannot be connected
 * to (a stale AAAA record, say) does not fail the attempt. Redirects are not
 * followed, and the response body is discarded unread.
 */
export const sendWebhookRequest: WebhookSender = (input) => {
  const timeoutMs = input.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS;
  const send = input.url.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise<WebhookSendResult>((resolve) => {
    let settled = false;
    const settle = (result: WebhookSendResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const request = send(
      input.url,
      {
        headers: {
          ...input.headers,
          "content-length": String(Buffer.byteLength(input.body, "utf8")),
        },
        lookup: pinnedLookup(input.targets),
        method: "POST",
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        settle({ kind: "response", status });
        request.destroy();
      },
    );

    // One deadline for the whole exchange: connect, TLS, send, status line.
    const deadline = setTimeout(() => {
      settle({ error: "timeout", kind: "error" });
      request.destroy();
    }, timeoutMs);

    request.on("error", () => {
      settle({ error: "network_error", kind: "error" });
    });
    request.end(input.body, "utf8");
  });
};

function pinnedLookup(targets: readonly ResolvedWebhookTarget[]): LookupFunction {
  return (_hostname, options, callback) => {
    // Node asks for every address when it is going to try them in turn
    // (`autoSelectFamily`, its default).
    if (typeof options === "object" && options.all) {
      callback(null, targets.map(({ address, family }) => ({ address, family })));
      return;
    }

    const first = targets[0];
    if (!first) {
      callback(new Error("webhook target has no address"), "", 4);
      return;
    }
    callback(null, first.address, first.family);
  };
}
