"use strict";

function r2Account(endpoint) {
  return /^https:\/\/([a-f0-9]{32})\.r2\.cloudflarestorage\.com\/?$/.exec(
    endpoint || "",
  )?.[1];
}

// R2's authenticated S3 endpoint does not describe its public-domain settings.
async function verifyR2Privacy({
  account,
  publicBucket,
  internalBucket,
  apiToken,
  fetch: fetcher = fetch,
}) {
  if (
    !account ||
    !publicBucket ||
    !internalBucket ||
    publicBucket === internalBucket
  )
    throw new Error(
      "R2 privacy verification requires an account and distinct public/internal buckets.",
    );
  if (!apiToken)
    throw new Error(
      "R2 privacy verification requires CLOUDFLARE_API_TOKEN with Workers R2 Storage Read permission.",
    );
  const get = async (path) => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${path}`,
      {
        headers: {
          authorization: `Bearer ${apiToken}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Could not verify R2 public-domain settings (HTTP ${response.status}).`,
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "Could not verify R2 public-domain settings: invalid API response.",
      );
    }
    if (data?.success !== true || !data.result)
      throw new Error(
        "Could not verify R2 public-domain settings: unsuccessful API response.",
      );
    return data.result;
  };
  await verifyR2Domains(publicBucket, internalBucket, get);
}

async function verifyR2Domains(publicBucket, internalBucket, get) {
  for (const bucket of [publicBucket, internalBucket]) {
    const path = `${encodeURIComponent(bucket)}/domains`;
    const managed = await get(`${path}/managed`);
    if (managed.enabled !== false)
      throw new Error(
        managed.enabled === true
          ? `R2 bucket ${bucket} allows r2.dev public access. Disable its Public Development URL.`
          : `Could not verify r2.dev access settings for R2 bucket ${bucket}.`,
      );
    if (bucket === internalBucket) {
      const custom = await get(`${path}/custom`);
      if (
        !Array.isArray(custom.domains) ||
        custom.domains.some((domain) => typeof domain?.enabled !== "boolean")
      )
        throw new Error(
          `Could not verify custom domain access settings for R2 bucket ${bucket}.`,
        );
      if (custom.domains.some((domain) => domain.enabled))
        throw new Error(
          `Internal R2 bucket ${bucket} allows public custom domain access. Disable its custom domains.`,
        );
    }
  }
}

module.exports = { r2Account, verifyR2Privacy, verifyR2Domains };
