// Adapted from codemagic-ci-cd/codemagic-patch@b41c6f556e13346ff9b666eb82490900672f1dd9
// client/src/events.ts (Apache-2.0). Changes from upstream, documented in
// specs/UPSTREAM-DIVERGENCE.md:
// 1. `NativeCodemagicPatch.enqueueMetricEvent(json)` (bare string arg) ->
//    `CodemagicPatch.enqueueMetricEvent({ eventJson: json })` (this package's
//    object-wrapped native contract, ../nativeCodemagicPatch).
// 2. `platform: "react-native"` -> `platform: "capacitor"`.
// 3. `require("../package.json")` -> a hardcoded constant, checked against
//    package.json by a test rather than read from it at runtime — a real `require()`
//    survives rootDir-constrained emit (tsc) and Node/vitest, but has no meaning in any
//    of the shipped browser bundles (dist/plugin.js's IIFE, or dist/esm/index.js loaded
//    by a consuming app's own bundler): both hit `ReferenceError: require is not
//    defined` the moment this file's top level ran. Only dist/plugin.cjs.js's literal
//    CommonJS `require` calls happened to work — undetected until Phase 4's example app
//    actually loaded the compiled output in a real WebView. See
//    src/protocol/events.test.ts's version-sync test for what keeps this from drifting.

import CodemagicPatch from '../nativeCodemagicPatch';

import { nowIso, nowMs, state } from './runtime';
import type { MetricsEvent, RuntimePackage } from './types';

// Keep in sync with package.json's "version" — enforced by
// src/protocol/events.test.ts, not read from it at runtime (see the comment above).
const SDK_VERSION = '0.1.0';

const ACTIVE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function createMetricEvent(name: string, fields: Omit<MetricsEvent, 'name' | 'at'>): MetricsEvent {
  return {
    name,
    at: nowIso(),
    ...fields,
  };
}

function serializeMetricEvent(event: MetricsEvent): string {
  const attributes: Record<string, string> = {};
  const deploymentKey = event.deploymentKey !== undefined ? event.deploymentKey : state.deploymentKey;
  const binaryVersion = event.binaryVersion !== undefined ? event.binaryVersion : state.binaryVersion;
  const runningPackageHash =
    event.runningPackageHash !== undefined ? event.runningPackageHash : (state.runningPackage?.packageHash ?? null);

  if (event.deliveryType) attributes.delivery_type = event.deliveryType;
  if (event.status) attributes.status = event.status;
  if (event.reason) attributes.reason = event.reason;
  if (event.failureSubtype) attributes.failure_subtype = event.failureSubtype;
  // PROTOCOL.md carries the payload as a JSON *string* so `attributes` stays a
  // flat string map across every native bridge.
  if (event.payload) attributes.payload = JSON.stringify(event.payload);

  return JSON.stringify({
    event_id: `${event.name}-${event.at.replace(/[^A-Za-z0-9._-]/g, '_')}-${Math.random().toString(16).slice(2)}`,
    event_name: event.name,
    emitted_at: event.at,
    device_id: state.deviceId,
    deployment_key: deploymentKey,
    binary_version: binaryVersion,
    running_package_hash: runningPackageHash,
    target_package_hash: event.packageHash ?? null,
    platform: 'capacitor',
    sdk_version: SDK_VERSION,
    attributes,
  });
}

export async function enqueueMetricEvent(event: MetricsEvent): Promise<void> {
  try {
    await CodemagicPatch.enqueueMetricEvent({ eventJson: serializeMetricEvent(event) });
  } catch {
    // Metrics are observability only; enqueue failures must not affect SDK flow.
  }
}

export async function recordEvent(name: string, fields: Omit<MetricsEvent, 'name' | 'at'> = {}): Promise<MetricsEvent> {
  const event = createMetricEvent(name, fields);

  await enqueueMetricEvent(event);
  state.events.push(event);
  return event;
}

export function packageMetricFields(
  runtimePackage: RuntimePackage,
): Pick<MetricsEvent, 'binaryVersion' | 'deploymentKey' | 'packageHash' | 'runningPackageHash'> {
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

  return nowMs() - Date.parse(runtimePackage.lastActiveReportedAt) >= ACTIVE_DEDUPE_WINDOW_MS;
}

export async function emitActiveIfDue(runtimePackage: RuntimePackage): Promise<void> {
  if (!shouldEmitActive(runtimePackage)) {
    return;
  }

  const event = await recordEvent('Active', {
    ...packageMetricFields(runtimePackage),
  });
  runtimePackage.lastActiveReportedAt = event.at;
}

export { createMetricEvent, serializeMetricEvent };
