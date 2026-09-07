/**
 * Cache-Control for mutable delivery JSON (`manifest.json`, `meta.json`) when
 * no CDN sits in front of the origin — the `base-url` delivery adapter.
 *
 * `BaseUrlDeliveryAdapter.purge` is a no-op, so nothing can shorten a shared
 * cache's TTL after a publish, rollback, or disable. Every cache on the path
 * must revalidate instead.
 */
export const DIRECT_MANIFEST_CACHE_CONTROL = "no-cache, must-revalidate";

/**
 * Cache-Control for mutable delivery JSON behind a purging delivery adapter
 * (Cloudflare, CloudFront).
 *
 * Clients still revalidate on every request (`max-age=0`). Shared caches get a
 * five-minute window, which is what makes edge caching worthwhile and what
 * bounds staleness when a best-effort purge fails.
 */
export const CDN_MANIFEST_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, must-revalidate";

/**
 * Fallback for callers that upload manifests without a resolved runtime config
 * (direct `executeReconcilePlan` use, tests). Stays with the conservative
 * policy: a caller that cannot state its delivery topology must not be given
 * a shared-cache TTL it may have no way to purge.
 */
export const DEFAULT_MANIFEST_CACHE_CONTROL = DIRECT_MANIFEST_CACHE_CONTROL;

/**
 * Cache-Control for immutable, content-addressed artifacts (full bundle
 * `bundle.tar.zst` and patch `.zst` objects).
 *
 * These keys are addressed by package hash and never overwritten, so they can
 * be cached indefinitely. Unlike the mutable manifest policy this value is
 * fixed by the content-addressed immutability invariant and is not
 * operator-configurable.
 */
export const DEFAULT_ARTIFACT_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
