import path from "node:path";

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
 * Cache lifetimes for dashboard files. Vite names every file it emits into
 * `assets/` as `[name]-[hash].[ext]`, with an 8-character base64url content
 * hash, so a changed file always gets a new URL and can be cached for a
 * year. Everything else (`index.html`, the SPA fallback, unhashed files
 * copied from `public/`) must be revalidated, or a deploy would leave
 * browsers on a stale `index.html` that points at the old bundle.
 */
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const UNHASHED_FILE_CACHE_CONTROL = "public, max-age=0";
const HASHED_ASSET_PATTERN = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9.]+$/;

/** `relativePath` is relative to the dashboard root, `/`-separated. */
function isHashedDashboardAsset(relativePath: string): boolean {
  return HASHED_ASSET_PATTERN.test(relativePath);
}

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
 *  - content-hashed files under `assets/` are cached as immutable; every
 *    other file is revalidated (ETag/Last-Modified, a 304 when unchanged);
 *  - every response gets the dashboard CSP and HSTS headers.
 */
export function registerDashboardStatic(
  app: FastifyInstance,
  rootDir: string,
): void {
  const root = path.resolve(rootDir);

  app.register(fastifyStatic, {
    // Cache-Control is chosen per file below, from the file actually sent
    // rather than the request URL, so the index.html fallback for a missing
    // /assets/name-12345678.js is never cached as immutable.
    cacheControl: false,
    index: "index.html",
    root,
    setHeaders: (res, filePath) => {
      const relativePath = path
        .relative(root, filePath)
        .split(path.sep)
        .join("/");
      res.setHeader(
        "cache-control",
        isHashedDashboardAsset(relativePath)
          ? HASHED_ASSET_CACHE_CONTROL
          : UNHASHED_FILE_CACHE_CONTROL,
      );
    },
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
