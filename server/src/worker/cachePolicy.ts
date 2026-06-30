export const DEFAULT_MANIFEST_CACHE_CONTROL = "no-cache, must-revalidate";

/**
 * Cache-Control for immutable, content-addressed artifacts (full bundle
 * `bundle.tar.zst` and patch `.zst` objects).
 *
 * Per infra-tech-spec.md (Caching Policy): "Patch and full bundle artifacts:
 * `Cache-Control: public, max-age=31536000, immutable`". These keys are
 * addressed by package hash and never overwritten, so they can be cached
 * indefinitely. Unlike the mutable manifest policy this value is fixed by the
 * content-addressed immutability invariant and is not operator-configurable.
 */
export const DEFAULT_ARTIFACT_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
