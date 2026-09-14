import { buildDownloadUrl } from "../delivery";
import { isRecord } from "../output";
import { isPathSafeBinaryVersion } from "../targetBinaryVersion";
import type { DoctorCheckResult } from "../commands/doctor";
import { buildApiUrl, normalizeBearerToken } from "../commands/shared";
import { httpUrl, safeUrl } from "./connectivity";

type JsonResult = { status: number; body?: unknown; error?: string };
class LimitError extends Error {}

/** Bounded redirects and bodies for doctor only; no change to release/download helpers. */
async function probe(
  fetcher: typeof fetch,
  value: string,
  signal: AbortSignal,
  json: boolean,
  token?: string,
): Promise<JsonResult> {
  let url = httpUrl(value);
  if (!url) return { status: 0, error: "invalid_url" };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let method = json ? "GET" : "HEAD";
  let redirects = 0;
  try {
    for (;;) {
      deadline.throwIfAborted();
      const response = await fetcher(url.toString(), {
        method,
        signal: deadline,
        redirect: "manual",
        credentials: "omit",
        headers: token
          ? { authorization: `Bearer ${normalizeBearerToken(token)}` }
          : method === "GET" && !json
            ? { Range: "bytes=0-1023" }
            : {},
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (token || redirects++ >= 5)
          return { status: response.status, error: "redirect_limit" };
        const location = response.headers.get("location");
        if (!location)
          return { status: response.status, error: "invalid_redirect" };
        url = httpUrl(new URL(location, url).toString());
        if (
          !url ||
          /\/(login|signin|sign-in|oauth|authorize)(\/|$)/i.test(url.pathname)
        )
          return { status: response.status, error: "access_redirect" };
        continue;
      }
      if (!json || !response.ok) {
        await response.body?.cancel();
        if (
          !json &&
          method === "HEAD" &&
          [403, 405, 501].includes(response.status)
        ) {
          method = "GET";
          continue;
        }
        if (
          !json &&
          (response.status === 204 ||
            response.status === 205 ||
            response.headers.get("content-length") === "0")
        ) {
          return { status: response.status, error: "empty_artifact" };
        }
        return {
          status: response.status,
          ...(!json &&
          response.headers.get("content-type")?.includes("text/html")
            ? { error: "unexpected_html" }
            : {}),
        };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: response.status, error: "invalid_json" };
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          deadline.throwIfAborted();
          const { done, value: chunk } = await reader.read();
          if (done) break;
          length += chunk.byteLength;
          if (length > 1024 * 1024) throw new LimitError();
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      try {
        return {
          status: response.status,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
      } catch {
        return { status: response.status, error: "invalid_json" };
      }
    }
  } catch (error) {
    return {
      status: 0,
      error:
        error instanceof LimitError
          ? "size_limit"
          : deadline.aborted
            ? "deadline"
            : "network",
    };
  }
}

type ReleaseEvidence = {
  id: string;
  version: string;
  status: string;
  job?: string;
  updated: string;
};
type History = {
  entries: ReleaseEvidence[];
  complete: boolean;
  reason?: string;
  observedAt: string;
};
export type PublicationCache = Map<string, Promise<History>>;

async function history(
  fetcher: typeof fetch,
  server: string,
  token: string,
  deployment: string,
  signal: AbortSignal,
): Promise<History> {
  const result: History = {
    entries: [],
    complete: false,
    observedAt: new Date().toISOString(),
  };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 0; page < 10; page++) {
    const offset = page * 100;
    const url = buildApiUrl(
      server,
      `/v1/deployments/${encodeURIComponent(deployment)}/releases?limit=100&offset=${offset}`,
    );
    const response = await probe(fetcher, url, deadline, true, token);
    const body = response.body;
    if (
      response.error ||
      response.status !== 200 ||
      !isRecord(body) ||
      !Array.isArray(body.releases) ||
      !isRecord(body.pagination)
    )
      return { ...result, reason: response.error ?? "unavailable_history" };
    const pagination = body.pagination;
    if (
      !Number.isSafeInteger(pagination.total) ||
      (pagination.total as number) < 0 ||
      pagination.offset !== offset ||
      pagination.limit !== 100 ||
      (total !== undefined && total !== pagination.total) ||
      body.releases.length !==
        Math.min(100, (pagination.total as number) - offset)
    )
      return { ...result, reason: "unstable_pagination" };
    total = pagination.total as number;
    for (const entry of body.releases) {
      if (!isRecord(entry) || !isRecord(entry.release))
        return { ...result, reason: "invalid_history" };
      const release = entry.release;
      if (
        typeof release.id !== "string" ||
        seen.has(release.id) ||
        typeof release.target_binary_version !== "string" ||
        typeof release.status !== "string" ||
        !["uploaded", "processing", "published", "failed", "disabled"].includes(
          release.status,
        ) ||
        release.deployment_id !== deployment ||
        typeof release.updated_at !== "string"
      )
        return { ...result, reason: "unstable_history" };
      if (
        entry.job !== null &&
        (!isRecord(entry.job) ||
          entry.job.release_id !== release.id ||
          entry.job.deployment_id !== deployment ||
          !["queued", "running", "succeeded", "failed", "dead_letter"].includes(
            String(entry.job.status),
          ))
      )
        return { ...result, reason: "invalid_job" };
      seen.add(release.id);
      result.entries.push({
        id: release.id,
        version: release.target_binary_version,
        status: release.status,
        updated: release.updated_at,
        ...(isRecord(entry.job) ? { job: String(entry.job.status) } : {}),
      });
    }
    if (offset + body.releases.length === total)
      return { ...result, complete: true };
  }
  return { ...result, reason: "history_limit" };
}

type Descriptor = { hash: string; bundle?: string; patch?: string };
export type ManifestValidation =
  | { valid: false; issue: string }
  | {
      valid: true;
      embedded: boolean;
      descriptors: Descriptor[];
      target?: string;
      rollout?: number;
    };
/** PROTOCOL.md field/descriptor rules, including fallback's no-patch contract. */
export function validateDoctorManifest(
  body: unknown,
  fallback: boolean,
): ManifestValidation {
  const invalid = (issue: string): ManifestValidation => ({
    valid: false,
    issue,
  });
  if (!isRecord(body) || !Object.hasOwn(body, "target_package_hash"))
    return invalid("target_package_hash is required");
  const descriptors: Descriptor[] = [];
  const size = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const descriptor = (
    entry: Record<string, unknown>,
    hash: unknown,
  ): string | undefined => {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      return "package hash must be a SHA-256 hex string";
    if (typeof entry.full_bundle_url !== "string")
      return "full_bundle_url is required for an OTA descriptor";
    if (typeof entry.release_label !== "string" || !entry.release_label.trim())
      return "release_label is required for an OTA target";
    if (
      typeof entry.is_mandatory !== "boolean" ||
      typeof entry.rollout_percentage !== "number" ||
      !Number.isFinite(entry.rollout_percentage) ||
      entry.rollout_percentage < 0 ||
      entry.rollout_percentage > 100
    )
      return "is_mandatory/rollout_percentage are invalid";
    if (
      entry.release_notes !== undefined &&
      entry.release_notes !== null &&
      typeof entry.release_notes !== "string"
    )
      return "release_notes must be a string or null";
    if (entry.signature !== undefined && typeof entry.signature !== "string")
      return "signature must be a string";
    if (fallback && Object.hasOwn(entry, "patch_url"))
      return "fallback manifest must omit patch_url, including predecessor descriptors";
    for (const field of ["full_bundle_url", "patch_url"] as const)
      if (
        entry[field] !== undefined &&
        (typeof entry[field] !== "string" || !httpUrl(entry[field]))
      )
        return `${field} must be an HTTP(S) URL without credentials`;
    if (entry.full_bundle_url !== undefined && !size(entry.full_bundle_size))
      return "full_bundle_size is required and must be a non-negative integer";
    if (entry.patch_size !== undefined && !size(entry.patch_size))
      return "patch_size must be a non-negative integer";
    descriptors.push({
      hash,
      ...(typeof entry.full_bundle_url === "string"
        ? { bundle: entry.full_bundle_url }
        : {}),
      ...(typeof entry.patch_url === "string"
        ? { patch: entry.patch_url }
        : {}),
    });
    return undefined;
  };
  if (body.target_package_hash === null) {
    if (
      Object.hasOwn(body, "release_label") ||
      Object.hasOwn(body, "patch_url") ||
      Object.hasOwn(body, "full_bundle_url") ||
      Object.hasOwn(body, "previous_package_info")
    )
      return invalid("embedded target must not advertise an OTA descriptor");
    return { valid: true, embedded: true, descriptors };
  }
  const error = descriptor(body, body.target_package_hash);
  if (error) return invalid(error);
  if (body.previous_package_info !== undefined) {
    if (!isRecord(body.previous_package_info))
      return invalid("previous_package_info must be a descriptor");
    const previousError = descriptor(
      body.previous_package_info,
      body.previous_package_info.package_hash,
    );
    if (previousError)
      return invalid(`previous_package_info: ${previousError}`);
    if (!size(body.previous_package_info.full_bundle_size))
      return invalid("previous_package_info.full_bundle_size is required");
  }
  return {
    valid: true,
    embedded: false,
    descriptors,
    target: String(body.target_package_hash),
    rollout: body.rollout_percentage as number,
  };
}

export type VerificationInput = {
  fetch: typeof fetch;
  downloadBaseUrl?: string;
  deploymentKey?: string;
  version?: string;
  currentHash?: string;
  serverUrl?: string;
  token?: string;
  deploymentId?: string;
  cache: PublicationCache;
};
export async function verifyDoctorDelivery(
  input: VerificationInput,
): Promise<DoctorCheckResult[]> {
  const checks: DoctorCheckResult[] = [];
  const add = (
    id: string,
    status: DoctorCheckResult["status"],
    detail: string,
    reason?: string,
    evidence?: Record<string, unknown>,
  ) =>
    checks.push({
      id,
      title: id.replace(/-/g, " "),
      status,
      detail,
      ...(reason ? { reason } : {}),
      ...(evidence ? { evidence } : {}),
    });
  const key = input.deploymentKey;
  if (
    !input.downloadBaseUrl ||
    !httpUrl(input.downloadBaseUrl) ||
    !key ||
    !/^[A-Za-z0-9_-]+$/.test(key) ||
    key.startsWith("cm_pat_") ||
    !input.version ||
    !isPathSafeBinaryVersion(input.version)
  ) {
    add(
      "delivery-prerequisites",
      "skip",
      "Delivery needs a resolved download URL, client deployment key, and exact binary version.",
      "unresolved",
    );
    checks[0]!.advice = [
      "Select a platform/source or supply --download-base-url, --deployment-key and --target-binary-version for this probe.",
    ];
    return checks;
  }
  if (input.currentHash && !/^[A-Za-z0-9_-]+$/.test(input.currentHash)) {
    add(
      "delivery-baseline",
      "fail",
      "Current package hash is not a safe path segment.",
    );
    return checks;
  }
  const deadline = AbortSignal.timeout(60_000);
  const url = (...segments: string[]) =>
    buildDownloadUrl(input.downloadBaseUrl!, [key, ...segments]);
  let scan: History | undefined;
  if (input.serverUrl && input.token && input.deploymentId) {
    const cacheKey = `${input.serverUrl}\n${input.deploymentId}`;
    let pending = input.cache.get(cacheKey);
    if (!pending) {
      pending = history(
        input.fetch,
        input.serverUrl,
        input.token,
        input.deploymentId,
        deadline,
      );
      input.cache.set(cacheKey, pending);
    }
    scan = await pending;
  }
  const relevant =
    scan?.entries.filter((entry) => entry.version === input.version) ?? [];
  const pending = relevant.some(
    (entry) =>
      ["uploaded", "processing"].includes(entry.status) ||
      entry.job === "queued" ||
      entry.job === "running",
  );
  const published = relevant.filter((entry) => entry.status === "published");
  const absent = scan?.complete === true && !pending && published.length === 0;
  const publication = {
    deploymentId: input.deploymentId,
    binaryVersion: input.version,
    reason: scan?.reason,
    observedAt: scan?.observedAt,
    complete: scan?.complete ?? false,
    published: published.map((entry) => ({
      id: entry.id,
      job: entry.job,
      updatedAt: entry.updated,
    })),
    pending,
  };
  add(
    "delivery-publication",
    scan?.complete ? (pending ? "warn" : "pass") : "warn",
    pending
      ? "Publication work is pending; any older usable delivery path is checked independently."
      : scan?.complete
        ? "Release history inspected for the exact binary version. API success does not confirm CDN propagation."
        : "Release history could not be established completely; absence of files is not evidence of no releases.",
    scan?.complete ? undefined : "unresolved",
    publication,
  );
  const pendingRelease = relevant.find(
    (entry) =>
      ["uploaded", "processing"].includes(entry.status) ||
      entry.job === "queued" ||
      entry.job === "running",
  );
  if (pendingRelease && /^[A-Za-z0-9_-]+$/.test(pendingRelease.id)) {
    checks[checks.length - 1]!.nextCommands = [
      `cmpatch release inspect --release-id ${pendingRelease.id} --wait`,
    ];
  }
  const meta = await probe(input.fetch, url("meta.json"), deadline, true);
  add(
    "deployment-meta",
    meta.status === 200 &&
      isRecord(meta.body) &&
      typeof meta.body.latest_binary_version === "string"
      ? "pass"
      : "warn",
    meta.status === 200 &&
      isRecord(meta.body) &&
      typeof meta.body.latest_binary_version === "string"
      ? "Deployment metadata is readable; it does not determine OTA applicability."
      : "Metadata/store-update hint is unavailable; the manifest path is checked independently.",
    undefined,
    { status: meta.status, error: meta.error },
  );
  const requestedAt = new Date().toISOString();
  let fallback = !input.currentHash;
  let manifest = await probe(
    input.fetch,
    fallback
      ? url(input.version, "manifest.json")
      : url(input.version, input.currentHash!, "manifest.json"),
    deadline,
    true,
  );
  if (!fallback && manifest.status === 404) {
    add(
      "primary-manifest",
      "pass",
      "No optimized manifest for this baseline; following the protocol fallback.",
    );
    fallback = true;
    manifest = await probe(
      input.fetch,
      url(input.version, "manifest.json"),
      deadline,
      true,
    );
  }
  const manifestId = fallback ? "fallback-manifest" : "primary-manifest";
  if (manifest.status === 404) {
    // Worker finalizes DB success BEFORE best-effort CDN purge. No exposed field proves public propagation.
    add(
      manifestId,
      absent ? "skip" : "warn",
      absent
        ? "No eligible published OTA was observed for this version; fallback 404 is an expected client no-op."
        : pending
          ? "No manifest is available yet; publication is pending."
          : "Manifest is unavailable. Origin reconciliation/CDN propagation cannot be established from the API, so no publication failure is inferred.",
      absent ? "no_artifact" : pending ? "deferred" : "unresolved",
      { ...publication, status: 404, requestedAt },
    );
    return checks;
  }
  if (manifest.error || manifest.status < 200 || manifest.status >= 300) {
    add(
      manifestId,
      manifest.error === "size_limit" || manifest.error === "deadline"
        ? "skip"
        : "fail",
      "The requested manifest could not be read as a usable delivery response.",
      manifest.error === "size_limit" || manifest.error === "deadline"
        ? "unresolved"
        : undefined,
      {
        status: manifest.status,
        error: manifest.error,
        requestedAt,
        binaryVersion: input.version,
      },
    );
    return checks;
  }
  const validation = validateDoctorManifest(manifest.body, fallback);
  if (!validation.valid) {
    add(manifestId, "fail", validation.issue);
    return checks;
  }
  add(
    manifestId,
    "pass",
    validation.embedded
      ? "The manifest explicitly selects the embedded binary bundle; device reversion was not verified."
      : validation.target === input.currentHash
        ? "Target equals the supplied current hash: protocol no-op. Advertised paths are inspected separately."
        : "Manifest is valid. Device identity/rollout selection is not predicted.",
  );
  if (validation.embedded) {
    add(
      "delivery-artifacts",
      "skip",
      "An embedded target has no OTA artifact to verify.",
      "embedded_target",
    );
    return checks;
  }
  const artifacts = new Map<string, Promise<JsonResult>>();
  let probed = 0;
  const access = async (value: string): Promise<JsonResult> => {
    let cached = artifacts.get(value);
    if (cached) return cached;
    if (artifacts.size >= 8) return { status: 0, error: "artifact_limit" };
    cached = probe(input.fetch, value, deadline, false);
    artifacts.set(value, cached);
    probed++;
    return cached;
  };
  // At most two descriptor artifacts concurrently; descriptors are processed sequentially.
  for (const [index, descriptor] of validation.descriptors.entries()) {
    const [bundle, patch] = await Promise.all([
      descriptor.bundle ? access(descriptor.bundle) : undefined,
      descriptor.patch ? access(descriptor.patch) : undefined,
    ]);
    const usable = (result?: JsonResult) =>
      result !== undefined &&
      !result.error &&
      result.status >= 200 &&
      result.status < 300;
    const limited = [bundle, patch].some(
      (result) =>
        result?.error === "artifact_limit" || result?.error === "deadline",
    );
    const good = usable(bundle) || usable(patch);
    add(
      `delivery-artifact-${index}`,
      limited
        ? "skip"
        : good
          ? (bundle && !usable(bundle)) || (patch && !usable(patch))
            ? "warn"
            : "pass"
          : "fail",
      limited
        ? "Artifact work or time limit reached."
        : good
          ? "An advertised delivery artifact is accessible; unavailable alternative paths are degraded."
          : "No advertised artifact for this descriptor is accessible.",
      limited ? "unresolved" : undefined,
      {
        descriptor: index === 0 ? "target" : "predecessor",
        bundle: bundle && {
          status: bundle.status,
          error: bundle.error,
          url: safeUrl(descriptor.bundle!),
        },
        patch: patch && {
          status: patch.status,
          error: patch.error,
          url: safeUrl(descriptor.patch!),
        },
      },
    );
  }
  if (!probed)
    add(
      "delivery-artifacts",
      "skip",
      "No OTA artifact was advertised for accessibility verification.",
      "no_artifact",
    );
  add(
    "delivery-runtime-boundary",
    "skip",
    "Accessibility does not verify signatures, content integrity, patch application, installation, or rollback on a device.",
    "not_applicable",
  );
  return checks;
}
