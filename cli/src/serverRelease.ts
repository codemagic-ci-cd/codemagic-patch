/**
 * Which server release a self-host install or upgrade checks out, and which
 * published image goes with it.
 *
 * The image path reads the public repo's GitHub Releases: the highest server
 * release at or above `MINIMUM_IMAGE_INSTALL_TAG` whose release carries the
 * `server-image.json` asset the publish workflow uploads as its last step.
 * The asset is cross-checked against the release (tag, tag commit, image
 * repository, digest shape, platforms) before its digest is trusted.
 *
 * The `--image` path only needs the checkout tag, so it reads
 * `git ls-remote --tags` and never looks at assets: matching the image to
 * the tag is the operator's call there.
 */

import {
  SERVER_IMAGE_REPOSITORY,
  SOURCE_REPO_SLUG,
  SOURCE_REPO_URL,
} from "./branding";
import { UsageError } from "./commands/shared";
import { compareServerTags, isServerTag, listServerTags } from "./flySetup";
import { runProcessWithSpawn, type RunProcess } from "./remoteExec";

/**
 * The first server release whose checkout carries the pull-based install
 * scripts, compose file and Caddyfiles. Older tags build from source and must
 * never be checked out by the image path, even if an image was backfilled for
 * them. Bump it whenever a release changes the checkout shape the CLI drives.
 */
export const MINIMUM_IMAGE_INSTALL_TAG = "codemagic-patch-server-v0.10.0";

export const SERVER_IMAGE_ASSET = "server-image.json";

const SERVER_TAG_PREFIX = "codemagic-patch-server-v";
const GITHUB_API_BASE_URL = "https://api.github.com";
const RELEASES_PER_PAGE = 100;
/** A runaway guard: the public repo is nowhere near 5000 releases. */
const MAX_RELEASE_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const LS_REMOTE_TIMEOUT_MS = 60_000;
const REQUIRED_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

// Test-only: points the CLI at a scratch fork (`owner/name`) so the whole
// publish → install path can run end to end before a real release. Not
// documented for users.
const TEST_SOURCE_REPO_ENV = "CMPATCH_TEST_SOURCE_REPO";
const REPO_SLUG_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u;

export type ServerSourceRepo = {
  /** `owner/name`. */
  slug: string;
  /** The clone and download URL, `https://github.com/owner/name`. */
  url: string;
  /** `https://api.github.com/repos/owner/name`. */
  apiUrl: string;
  /** The image repository the release asset must name. */
  imageRepository: string;
};

/**
 * The repository the server is installed from: the public repo, or the
 * scratch repo `CMPATCH_TEST_SOURCE_REPO` names. The clone URL, the releases
 * API and the image repository always move together.
 */
export function serverSourceRepo(
  env: Record<string, string | undefined>,
): ServerSourceRepo {
  const override = env[TEST_SOURCE_REPO_ENV];
  if (override === undefined || override === "") {
    return {
      apiUrl: `${GITHUB_API_BASE_URL}/repos/${SOURCE_REPO_SLUG}`,
      imageRepository: SERVER_IMAGE_REPOSITORY,
      slug: SOURCE_REPO_SLUG,
      url: SOURCE_REPO_URL,
    };
  }

  if (!REPO_SLUG_PATTERN.test(override)) {
    throw new UsageError(
      `${TEST_SOURCE_REPO_ENV} must be owner/name, got "${override}".`,
    );
  }

  return {
    apiUrl: `${GITHUB_API_BASE_URL}/repos/${override}`,
    imageRepository: `ghcr.io/${override.toLowerCase()}-server`,
    slug: override,
    url: `https://github.com/${override}`,
  };
}

export type ServerImageRelease = {
  /** `codemagic-patch-server-v0.10.0`. */
  tag: string;
  /** `0.10.0`. */
  version: string;
  /** `ghcr.io/…/codemagic-patch-server:0.10.0@sha256:…`, the value `.env.selfhost` pins. */
  imageRef: string;
  /** The commit the tag points at, 40 hex characters. */
  revision: string;
};

export type ServerImageReleaseErrorKind =
  /** The releases API, the git refs API or the asset download failed or answered non-2xx. */
  | "unreachable"
  /** No server release at or above the minimum carries the asset yet (the first cycle). */
  | "no-image-release"
  /** The asset names a schemaVersion this CLI does not know. */
  | "unsupported-schema"
  /** The asset is not JSON, or a field is missing or has the wrong type. */
  | "invalid-manifest"
  /** A field disagrees with the release; `field` names it. */
  | "mismatch";

export type ServerImageManifestField =
  | "digest"
  | "image"
  | "platforms"
  | "revision"
  | "tag";

export class ServerImageReleaseError extends UsageError {
  constructor(
    readonly kind: ServerImageReleaseErrorKind,
    message: string,
    readonly field?: ServerImageManifestField,
  ) {
    super(message);
    this.name = "ServerImageReleaseError";
  }
}

const WAYS_AROUND =
  "Pass --image <ref> to use a server image you choose, or --build-from-source to build it on the server.";

type FetchLike = typeof globalThis.fetch;

/** The latest server release with a published image, cross-checked against its release. */
export async function resolveLatestServerImageRelease(input: {
  env: Record<string, string | undefined>;
  fetch?: FetchLike;
}): Promise<ServerImageRelease> {
  const repo = serverSourceRepo(input.env);
  const fetchFn = input.fetch ?? globalThis.fetch;

  const tag = await latestTagWithImageAsset(fetchFn, repo);
  if (tag === null) {
    throw new ServerImageReleaseError(
      "no-image-release",
      `There is no published server image yet (no ${SERVER_TAG_PREFIX}* release at or above ${MINIMUM_IMAGE_INSTALL_TAG} carries ${SERVER_IMAGE_ASSET}). Use --build-from-source, or wait for the next server release.`,
    );
  }

  const version = tag.slice(SERVER_TAG_PREFIX.length);
  const manifest = parseManifest(
    tag,
    await fetchText(
      fetchFn,
      `${repo.url}/releases/download/${tag}/${SERVER_IMAGE_ASSET}`,
      `${SERVER_IMAGE_ASSET} of ${tag}`,
    ),
  );

  expectField(tag, "tag", manifest.tag, version);
  expectField(tag, "image", manifest.image, repo.imageRepository);
  if (!DIGEST_PATTERN.test(manifest.digest)) {
    throw mismatch(tag, "digest", manifest.digest, "sha256:<64 hex characters>");
  }
  if (!REQUIRED_PLATFORMS.every((platform) => manifest.platforms.includes(platform))) {
    throw mismatch(
      tag,
      "platforms",
      manifest.platforms.join(", ") || "none",
      REQUIRED_PLATFORMS.join(" and "),
    );
  }
  const commit = await tagCommit(fetchFn, repo, tag);
  expectField(tag, "revision", manifest.revision.toLowerCase(), commit);

  return {
    imageRef: `${manifest.image}:${manifest.tag}@${manifest.digest}`,
    revision: commit,
    tag,
    version,
  };
}

/**
 * The checkout tag for an install that brings its own `--image`: the highest
 * server tag at or above the minimum, from `git ls-remote --tags`, with no
 * asset check. Null before the first such release, so the caller can fall
 * back to the default branch.
 */
export async function resolveLatestServerTagForImage(input: {
  env: Record<string, string | undefined>;
  runProcess?: RunProcess;
}): Promise<string | null> {
  const repo = serverSourceRepo(input.env);
  const runProcess = input.runProcess ?? runProcessWithSpawn;
  let output = "";
  let exitCode: number | null;
  try {
    ({ exitCode } = await runProcess({
      args: ["ls-remote", "--tags", repo.url],
      command: "git",
      onOutput: (chunk) => {
        output += chunk;
      },
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    }));
  } catch (error) {
    throw new ServerImageReleaseError(
      "unreachable",
      `Could not run git ls-remote --tags ${repo.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (exitCode !== 0) {
    const detail = output.trim().split("\n").slice(-5).join("\n");
    throw new ServerImageReleaseError(
      "unreachable",
      [`git ls-remote --tags ${repo.url} failed, so the server release to check out is unknown.`, detail]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }

  return highestEligibleTag(listServerTags(output));
}

/** The highest tag at or above the minimum, or null. Every input must be a server tag. */
function highestEligibleTag(tags: readonly string[]): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if ((compareServerTags(tag, MINIMUM_IMAGE_INSTALL_TAG) ?? -1) < 0) {
      continue;
    }
    if (best === null || (compareServerTags(tag, best) ?? 0) > 0) {
      best = tag;
    }
  }
  return best;
}

/**
 * Pages through every release. GitHub orders them by creation date, not by
 * version, so a patch release cut for an older line can sit above a newer
 * one: no page can be skipped on the strength of what an earlier page held.
 */
async function latestTagWithImageAsset(
  fetchFn: FetchLike,
  repo: ServerSourceRepo,
): Promise<string | null> {
  const candidates: string[] = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_RELEASE_PAGES) {
      throw new ServerImageReleaseError(
        "unreachable",
        `GitHub kept returning release pages past page ${MAX_RELEASE_PAGES} for ${repo.slug}. ${WAYS_AROUND}`,
      );
    }
    const body = await fetchJson(
      fetchFn,
      `${repo.apiUrl}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      `the ${repo.slug} releases`,
    );
    if (!Array.isArray(body)) {
      throw new ServerImageReleaseError(
        "unreachable",
        `GitHub answered the ${repo.slug} releases request with something other than a list. ${WAYS_AROUND}`,
      );
    }
    for (const release of body as unknown[]) {
      const tag = eligibleReleaseTag(release);
      if (tag !== null) {
        candidates.push(tag);
      }
    }
    if (body.length < RELEASES_PER_PAGE) {
      return highestEligibleTag(candidates);
    }
  }
}

function eligibleReleaseTag(release: unknown): string | null {
  if (typeof release !== "object" || release === null) {
    return null;
  }
  const { assets, draft, prerelease, tag_name: tag } = release as Record<string, unknown>;
  if (draft === true || prerelease === true || typeof tag !== "string" || !isServerTag(tag)) {
    return null;
  }
  const hasAsset = Array.isArray(assets) && assets.some(
    (asset) => typeof asset === "object" && asset !== null &&
      (asset as Record<string, unknown>).name === SERVER_IMAGE_ASSET,
  );
  return hasAsset ? tag : null;
}

/**
 * The commit a tag points at, via the git refs API. An annotated tag's ref
 * points at a tag object, which is peeled until a commit turns up.
 */
async function tagCommit(
  fetchFn: FetchLike,
  repo: ServerSourceRepo,
  tag: string,
): Promise<string> {
  let target = readGitObject(
    await fetchJson(fetchFn, `${repo.apiUrl}/git/ref/tags/${tag}`, `the ${tag} tag`),
    tag,
  );
  // Tags of tags are legal git; a few levels is plenty.
  for (let depth = 0; target.type === "tag" && depth < 5; depth += 1) {
    target = readGitObject(
      await fetchJson(fetchFn, `${repo.apiUrl}/git/tags/${target.sha}`, `the ${tag} tag object`),
      tag,
    );
  }
  if (target.type !== "commit") {
    throw new ServerImageReleaseError(
      "unreachable",
      `GitHub did not resolve ${tag} to a commit (it points at a ${target.type}). ${WAYS_AROUND}`,
    );
  }
  return target.sha.toLowerCase();
}

function readGitObject(body: unknown, tag: string): { sha: string; type: string } {
  const object = (body as { object?: { sha?: unknown; type?: unknown } } | null)?.object;
  if (typeof object?.sha !== "string" || typeof object.type !== "string") {
    throw new ServerImageReleaseError(
      "unreachable",
      `GitHub's answer for the ${tag} tag has no object. ${WAYS_AROUND}`,
    );
  }
  return { sha: object.sha, type: object.type };
}

type ServerImageManifest = {
  digest: string;
  image: string;
  platforms: string[];
  revision: string;
  tag: string;
};

function parseManifest(releaseTag: string, text: string): ServerImageManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(releaseTag, "it is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(releaseTag, "it is not a JSON object");
  }
  const record = value as Record<string, unknown>;

  if (record.schemaVersion !== 1) {
    throw new ServerImageReleaseError(
      "unsupported-schema",
      `This CLI does not understand the image manifest on ${releaseTag} (schemaVersion ${JSON.stringify(record.schemaVersion ?? null)}). Upgrade the CLI and try again.`,
    );
  }

  for (const field of ["image", "tag", "digest", "revision"] as const) {
    if (typeof record[field] !== "string") {
      throw invalid(releaseTag, `"${field}" is missing or not a string`);
    }
  }
  const { platforms } = record;
  if (!Array.isArray(platforms) || !platforms.every((entry) => typeof entry === "string")) {
    throw invalid(releaseTag, `"platforms" is missing or not a list of strings`);
  }

  return {
    digest: record.digest as string,
    image: record.image as string,
    platforms: platforms as string[],
    revision: record.revision as string,
    tag: record.tag as string,
  };
}

function invalid(releaseTag: string, reason: string): ServerImageReleaseError {
  return new ServerImageReleaseError(
    "invalid-manifest",
    `${SERVER_IMAGE_ASSET} on ${releaseTag} is unusable: ${reason}. ${WAYS_AROUND}`,
  );
}

function expectField(
  releaseTag: string,
  field: ServerImageManifestField,
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    throw mismatch(releaseTag, field, actual, expected);
  }
}

function mismatch(
  releaseTag: string,
  field: ServerImageManifestField,
  actual: string,
  expected: string,
): ServerImageReleaseError {
  return new ServerImageReleaseError(
    "mismatch",
    `${SERVER_IMAGE_ASSET} on ${releaseTag} does not match the release: "${field}" is ${actual}, expected ${expected}. ${WAYS_AROUND}`,
    field,
  );
}

async function fetchJson(fetchFn: FetchLike, url: string, what: string): Promise<unknown> {
  const text = await fetchText(fetchFn, url, what, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServerImageReleaseError(
      "unreachable",
      `GitHub answered the request for ${what} with something other than JSON. ${WAYS_AROUND}`,
    );
  }
}

/** GET with redirects followed: release asset downloads land on GitHub's CDN. */
async function fetchText(
  fetchFn: FetchLike,
  url: string,
  what: string,
  headers: Record<string, string> = {},
): Promise<string> {
  let response: Response;
  let text: string;
  try {
    response = await fetchFn(url, {
      headers: { "User-Agent": "cmpatch", ...headers },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new ServerImageReleaseError(
      "unreachable",
      `Could not reach GitHub for ${what} (${error instanceof Error ? error.message : String(error)}). ${WAYS_AROUND}`,
    );
  }
  if (!response.ok) {
    throw new ServerImageReleaseError(
      "unreachable",
      `GitHub answered ${response.status} for ${what}. ${WAYS_AROUND}`,
    );
  }
  return text;
}
