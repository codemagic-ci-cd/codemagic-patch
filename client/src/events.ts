import type { MetricsEvent, RuntimePackage } from "./types";
import NativeCodemagicPatch from "./NativeCodemagicPatch";
import { nowIso, nowMs, state } from "./runtime";

// package.json is the single source of truth for the SDK version (the iOS
// podspec reads the same field). require (not import) keeps package.json out of
// the emitted program so the build's rootDir (./src) constraint stays satisfied.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg: { version?: string } = require("../package.json");
const SDK_VERSION = pkg.version ?? "0.0.0";

const ACTIVE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function createMetricEvent(
  name: string,
  fields: Omit<MetricsEvent, "name" | "at">,
): MetricsEvent {
  return {
    name,
    at: nowIso(),
    ...fields,
  };
}

function serializeMetricEvent(event: MetricsEvent): string {
  const attributes: Record<string, string> = {};
  const deploymentKey =
    event.deploymentKey !== undefined ? event.deploymentKey : state.deploymentKey;
  const binaryVersion =
    event.binaryVersion !== undefined ? event.binaryVersion : state.binaryVersion;
  const runningPackageHash =
    event.runningPackageHash !== undefined
      ? event.runningPackageHash
      : state.runningPackage?.packageHash ?? null;

  if (event.deliveryType) attributes.delivery_type = event.deliveryType;
  if (event.status) attributes.status = event.status;
  if (event.reason) attributes.reason = event.reason;
  if (event.failureSubtype) attributes.failure_subtype = event.failureSubtype;

  return JSON.stringify({
    event_id: `${event.name}-${event.at.replace(/[^A-Za-z0-9._-]/g, "_")}-${Math.random().toString(16).slice(2)}`,
    event_name: event.name,
    emitted_at: event.at,
    device_id: state.deviceId,
    deployment_key: deploymentKey,
    binary_version: binaryVersion,
    running_package_hash: runningPackageHash,
    target_package_hash: event.packageHash ?? null,
    platform: "react-native",
    sdk_version: SDK_VERSION,
    attributes,
  });
}

export async function enqueueMetricEvent(
  event: MetricsEvent,
): Promise<void> {
  try {
    await NativeCodemagicPatch.enqueueMetricEvent(serializeMetricEvent(event));
  } catch {
    // Metrics are observability only; enqueue failures must not affect SDK flow.
  }
}

export async function recordEvent(
  name: string,
  fields: Omit<MetricsEvent, "name" | "at"> = {},
): Promise<MetricsEvent> {
  const event = createMetricEvent(name, fields);

  await enqueueMetricEvent(event);
  state.events.push(event);
  return event;
}

export function packageMetricFields(runtimePackage: RuntimePackage): Pick<
  MetricsEvent,
  "binaryVersion" | "deploymentKey" | "packageHash" | "runningPackageHash"
> {
  return {
    packageHash: runtimePackage.packageHash,
    deploymentKey: runtimePackage.deploymentKey,
    binaryVersion: runtimePackage.binaryVersion,
    runningPackageHash: runtimePackage.packageHash,
  };
}

export function shouldEmitActive(runtimePackage: RuntimePackage): boolean {
  if (!runtimePackage.lastActiveReportedAt) {
    return true;
  }

  return (
    nowMs() - Date.parse(runtimePackage.lastActiveReportedAt) >= ACTIVE_DEDUPE_WINDOW_MS
  );
}

export async function emitActiveIfDue(runtimePackage: RuntimePackage): Promise<void> {
  if (!shouldEmitActive(runtimePackage)) {
    return;
  }

  const event = await recordEvent("Active", {
    ...packageMetricFields(runtimePackage),
  });
  runtimePackage.lastActiveReportedAt = event.at;
}

export { createMetricEvent, serializeMetricEvent };
