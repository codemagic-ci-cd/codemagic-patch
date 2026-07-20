import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Security headers for the dashboard origin. The app is the single owner of
 * these values: with the SPA served from the server process there is no
 * fronting layer left to inject them.
 */
export const DASHBOARD_CSP =
  "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
export const DASHBOARD_HSTS = "max-age=31536000; includeSubDomains";

/**
 * Path prefixes that keep API semantics under the SPA fallback: an unknown
 * path below them is an API 404, not a dashboard route.
 */
const API_PATH_PREFIXES = ["/v1", "/health", "/worker"];

export function isApiPath(pathname: string): boolean {
  return API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Serves the built dashboard SPA next to the API routes:
 *
 *  - static assets and `/` come from `rootDir` (`index.html` for `/`);
 *  - unknown non-API GET/HEAD paths fall back to `index.html` so SPA
 *    client-side routes (including `/auth/callback`) deep-link correctly;
 *  - unknown API paths keep Fastify's JSON 404 shape;
 *  - every response gets the dashboard CSP and HSTS headers.
 */
export function registerDashboardStatic(
  app: FastifyInstance,
  rootDir: string,
): void {
  app.register(fastifyStatic, {
    index: "index.html",
    root: rootDir,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("content-security-policy", DASHBOARD_CSP);
    reply.header("strict-transport-security", DASHBOARD_HSTS);
  });

  app.setNotFoundHandler((request, reply) => {
    const method = request.raw.method ?? "";
    const pathname = request.url.split("?")[0] ?? "";

    if ((method === "GET" || method === "HEAD") && !isApiPath(pathname)) {
      return reply.sendFile("index.html");
    }

    return reply.status(404).send({
      error: "Not Found",
      message: `Route ${method}:${request.url} not found`,
      statusCode: 404,
    });
  });
}
