/**
 * Minimal GitHub OAuth + API stub for local dashboard development.
 * Implements the endpoints used by githubAuthNAdapter / githubApi.
 */

import { createServer, type IncomingMessage } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.MOCK_GITHUB_PORT || "4480");
const MOCK_CLIENT_ID =
  process.env.MOCK_GITHUB_CLIENT_ID || "dev-local-github-oauth-client-id";
const MOCK_CLIENT_SECRET =
  process.env.MOCK_GITHUB_CLIENT_SECRET || "secret";
const MOCK_USER_ID = 1;
const MOCK_LOGIN = "local-admin";
const MOCK_DISPLAY_NAME = "Local Admin";
const MOCK_EMAIL = "local-admin@example.com";

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function redirect(
  response: import("node:http").ServerResponse,
  location: string,
) {
  response.writeHead(302, { location });
  response.end();
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function extractBearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length);
}

const server = createServer(async (request, response) => {
  if (!request.url || !request.method) {
    response.writeHead(400);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (request.method === "GET" && path === "/login/oauth/authorize") {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!redirectUri || !state) {
      response.writeHead(400);
      response.end("missing redirect_uri or state");
      return;
    }

    const callback = new URL(redirectUri);
    callback.searchParams.set("code", `mock-github-code-${Date.now()}`);
    callback.searchParams.set("state", state);
    redirect(response, callback.toString());
    return;
  }

  if (request.method === "POST" && path === "/login/oauth/access_token") {
    const body = await readFormBody(request);
    if (body.get("client_id") !== MOCK_CLIENT_ID) {
      sendJson(response, 400, { error: "incorrect_client_credentials" });
      return;
    }
    if (body.get("client_secret") !== MOCK_CLIENT_SECRET) {
      sendJson(response, 400, { error: "incorrect_client_credentials" });
      return;
    }
    if (!body.get("code")) {
      sendJson(response, 400, { error: "bad_verification_code" });
      return;
    }

    sendJson(response, 200, {
      access_token: "mock-github-access-token",
      scope: "read:user user:email",
      token_type: "bearer",
    });
    return;
  }

  if (request.method === "GET" && path === "/user") {
    if (!extractBearerToken(request)) {
      sendJson(response, 401, { message: "Requires authentication" });
      return;
    }
    sendJson(response, 200, {
      id: MOCK_USER_ID,
      login: MOCK_LOGIN,
      name: MOCK_DISPLAY_NAME,
    });
    return;
  }

  if (request.method === "GET" && path === "/user/emails") {
    if (!extractBearerToken(request)) {
      sendJson(response, 401, { message: "Requires authentication" });
      return;
    }
    sendJson(response, 200, [
      {
        email: MOCK_EMAIL,
        primary: true,
        verified: true,
      },
    ]);
    return;
  }

  const workflowDispatchMatch = path.match(
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/,
  );
  if (
    request.method === "POST" &&
    workflowDispatchMatch &&
    extractBearerToken(request)
  ) {
    response.writeHead(204);
    response.end();
    console.log(
      `[mock-github] workflow_dispatch ${workflowDispatchMatch[1]}/${workflowDispatchMatch[2]} workflow=${workflowDispatchMatch[3]}`,
    );
    return;
  }

  response.writeHead(404);
  response.end(`not found: ${request.method} ${path}`);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[mock-github] listening on :${PORT} (client_id=${MOCK_CLIENT_ID}, email=${MOCK_EMAIL})`,
  );
});
