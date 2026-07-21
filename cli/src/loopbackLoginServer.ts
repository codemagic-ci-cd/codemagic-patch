import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { PRODUCT_NAME } from "./branding";

/**
 * Loopback redirect listener for the browser login (RFC 8252 §7.3): a
 * one-shot HTTP server on an ephemeral 127.0.0.1 port. The dashboard's
 * /cli/authorize approve page redirects the browser to
 * `http://127.0.0.1:<port>/callback?code&state` (or `error=access_denied` on
 * deny); the first request with the matching state settles the callback
 * promise. Everything else (favicon probes, stale tabs, state mismatches)
 * gets an error page and the server keeps waiting.
 */

export type LoopbackCallbackResult =
  | {
      kind: "code";
      code: string;
    }
  | {
      kind: "denied";
    }
  | {
      kind: "timeout";
    };

export interface LoopbackLoginServer {
  port: number;
  /**
   * Resolves on the first /callback hit carrying the expected state, or with
   * `timeout` after `timeoutMs`. The timer is unref'd so an abandoned wait
   * never keeps the CLI process alive.
   */
  waitForCallback(timeoutMs: number): Promise<LoopbackCallbackResult>;
  close(): Promise<void>;
}

export interface StartLoopbackLoginServerOptions {
  expectedState: string;
}

export type StartLoopbackLoginServer = (
  options: StartLoopbackLoginServerOptions,
) => Promise<LoopbackLoginServer>;

export const startLoopbackLoginServer: StartLoopbackLoginServer = (options) => {
  let settle: (result: LoopbackCallbackResult) => void;
  const callback = new Promise<LoopbackCallbackResult>((resolve) => {
    settle = resolve;
  });

  const server = createServer((request, reply) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method !== "GET" || url.pathname !== "/callback") {
      reply.writeHead(404, HTML_HEADERS);
      reply.end(page("Not found", "This address only serves the sign-in callback."));
      return;
    }

    if (url.searchParams.get("state") !== options.expectedState) {
      reply.writeHead(400, HTML_HEADERS);
      reply.end(
        page(
          "Sign-in request mismatch",
          `This callback does not match the ${PRODUCT_NAME} CLI login waiting in your terminal. Re-run \`cmpatch login\` and use the newest browser tab.`,
        ),
      );
      return;
    }

    if (url.searchParams.get("error") !== null) {
      reply.writeHead(200, HTML_HEADERS);
      reply.end(
        page(
          "Sign-in denied",
          "The CLI sign-in request was denied. You can close this tab and return to the terminal.",
        ),
      );
      settle({ kind: "denied" });
      return;
    }

    const code = url.searchParams.get("code");
    if (code === null || code.length === 0) {
      reply.writeHead(400, HTML_HEADERS);
      reply.end(
        page(
          "Sign-in incomplete",
          "The callback carried no authorization code. Re-run `cmpatch login`.",
        ),
      );
      return;
    }

    reply.writeHead(200, HTML_HEADERS);
    reply.end(
      page(
        "Sign-in complete",
        "You can close this tab and return to the terminal.",
      ),
    );
    settle({ code, kind: "code" });
  });

  // Loopback interface only — never a routable address. The dashboard
  // redirects to 127.0.0.1 verbatim, so IPv4 loopback is the one address
  // family to bind.
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        close: () => closeServer(server),
        port: (server.address() as AddressInfo).port,
        waitForCallback: (timeoutMs) =>
          Promise.race([callback, timeoutAfter(timeoutMs)]),
      });
    });
  });
};

function timeoutAfter(timeoutMs: number): Promise<LoopbackCallbackResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMs);
    // The listener's open socket is what should keep the process alive while
    // a sign-in is pending — never this timer.
    timer.unref();
  });
}

const HTML_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
} as const;

function page(title: string, message: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${title} — ${PRODUCT_NAME}</title>`,
    "<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0e1a;color:#e8eaf2}main{max-width:420px;padding:40px;text-align:center}h1{font-size:20px}p{color:#9aa1b5;font-size:14px;line-height:1.6}</style>",
    "</head><body><main>",
    `<h1>${title}</h1>`,
    `<p>${message}</p>`,
    "</main></body></html>",
  ].join("");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Idle keep-alive connections would hold `close` open for seconds;
    // dropping them is safe — the one meaningful response has been sent.
    server.closeAllConnections?.();
    server.close(() => {
      resolve();
    });
  });
}
