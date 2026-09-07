/**
 * "Latest published server release" lookup against the public GitHub
 * releases feed, built once per runtime so its cache lives with the process
 * rather than the module.
 *
 * Successful lookups are cached for a long window (releases are rare);
 * failures are cached briefly too, so a GitHub outage or an exhausted
 * unauthenticated rate limit (60 requests/hour per IP) costs one failed call
 * per window instead of one per dashboard load. Concurrent callers share a
 * single in-flight request.
 */

import { GITHUB_API_VERSION } from "./githubApi";
import type { ServerStatusLatestReleaseDetails } from "./types";

export const PATCH_SERVER_RELEASE_TAG_PREFIX = "codemagic-patch-server-v";

const DEFAULT_REPOSITORY = "codemagic-ci-cd/codemagic-patch";
const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;
const DEFAULT_SUCCESS_TTL_MS = 15 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 60 * 1000;

export type LatestServerRelease = ServerStatusLatestReleaseDetails;

export type LatestServerReleaseLookup = () => Promise<LatestServerRelease | null>;

export interface LatestServerReleaseLookupOptions {
  /** GitHub REST origin, e.g. `https://api.github.com` (no trailing slash). */
  apiBaseUrl: string;
  failureTtlMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  /** `owner/name` whose releases carry the server tags. */
  repository?: string;
  requestTimeoutMs?: number;
  successTtlMs?: number;
}

interface GithubReleaseListing {
  draft?: boolean;
  html_url?: string;
  prerelease?: boolean;
  published_at?: string | null;
  tag_name?: string;
}

type CachedLookup =
  | { at: number; error: unknown; ok: false }
  | { at: number; ok: true; value: LatestServerRelease | null };

export function createLatestServerReleaseLookup(
  options: LatestServerReleaseLookupOptions,
): LatestServerReleaseLookup {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const url = `${options.apiBaseUrl}/repos/${repository}/releases?per_page=30`;

  let cached: CachedLookup | undefined;
  let inflight: Promise<LatestServerRelease | null> | null = null;

  const fetchLatest = async (): Promise<LatestServerRelease | null> => {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "codemagic-patch-server",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      method: "GET",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub releases HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      throw new Error("GitHub releases response was not a list");
    }
    return pickLatestServerRelease(body as GithubReleaseListing[]);
  };

  return async () => {
    const at = now();
    if (cached !== undefined) {
      const ttl = cached.ok ? successTtlMs : failureTtlMs;
      if (at - cached.at < ttl) {
        if (cached.ok) {
          return cached.value;
        }
        throw cached.error;
      }
    }

    inflight ??= fetchLatest()
      .then((value) => {
        cached = { at: now(), ok: true, value };
        return value;
      })
      .catch((error: unknown) => {
        cached = { at: now(), error, ok: false };
        throw error;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/**
 * First published (non-draft, non-prerelease) release carrying the server tag
 * prefix, in the order GitHub lists them (newest first).
 */
export function pickLatestServerRelease(
  releases: GithubReleaseListing[],
): LatestServerRelease | null {
  for (const release of releases) {
    if (release.draft === true || release.prerelease === true) {
      continue;
    }
    const tag = release.tag_name;
    const htmlUrl = release.html_url;
    if (
      typeof tag === "string" &&
      tag.startsWith(PATCH_SERVER_RELEASE_TAG_PREFIX) &&
      typeof htmlUrl === "string" &&
      htmlUrl.length > 0
    ) {
      const publishedAt =
        typeof release.published_at === "string" &&
        release.published_at.length > 0
          ? release.published_at
          : null;
      return {
        html_url: htmlUrl,
        published_at: publishedAt,
        tag,
        version: tag.slice(PATCH_SERVER_RELEASE_TAG_PREFIX.length),
      };
    }
  }
  return null;
}
