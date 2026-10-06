// What the dashboard knows about the framework an app is built with. The
// server stores `framework` and never branches on it, and validates its shape
// rather than its membership — a CLI for a framework that does not exist yet
// can label its apps on an older server. So an unknown value is expected here,
// not an error: it falls back to neutral guidance everywhere below.

import { SOURCE_REPO_URL } from "../branding";

export type KnownFramework = "react-native" | "capacitor";

/** What a server that predates `framework` means by omitting it. */
export const DEFAULT_FRAMEWORK: KnownFramework = "react-native";

/** Selector order; the default comes first. */
export const KNOWN_FRAMEWORKS: readonly KnownFramework[] = [
  "react-native",
  "capacitor",
];

const FRAMEWORK_LABELS: Record<KnownFramework, string> = {
  "react-native": "React Native",
  capacitor: "Capacitor",
};

// Guides live in the PUBLIC repo: `client-capacitor/` and the root README both
// sync there, and an internal-repo link 404s for everyone outside the org.
const CONNECT_GUIDE_URLS: Record<KnownFramework, string> = {
  "react-native": `${SOURCE_REPO_URL}#part-4--connect-your-react-native-app`,
  capacitor: `${SOURCE_REPO_URL}/tree/main/client-capacitor#configuration`,
};

/** Key names an SDK is configured with, as its own docs spell them. */
export interface SdkConfigKeyNames {
  apiUrl: string;
  downloadBaseUrl: string;
}

const NEUTRAL_SDK_CONFIG_KEY_NAMES: SdkConfigKeyNames = {
  apiUrl: "API URL",
  downloadBaseUrl: "Download base URL",
};

const SDK_CONFIG_KEY_NAMES: Record<KnownFramework, SdkConfigKeyNames> = {
  // Native resource names, set in the app's native project.
  "react-native": {
    apiUrl: "CodemagicPatchApiUrl",
    downloadBaseUrl: "CodemagicPatchDownloadBaseUrl",
  },
  // Keys of the platform block under `plugins.CodemagicPatch` in
  // capacitor.config.ts.
  capacitor: { apiUrl: "apiUrl", downloadBaseUrl: "downloadBaseUrl" },
};

export function isKnownFramework(
  framework: string,
): framework is KnownFramework {
  return Object.hasOwn(FRAMEWORK_LABELS, framework);
}

/** Display label, or the raw value for a framework this build predates. */
export function frameworkLabel(framework: string): string {
  return isKnownFramework(framework) ? FRAMEWORK_LABELS[framework] : framework;
}

/** Guide for wiring this framework's SDK; null when the value is unknown. */
export function connectGuideUrl(framework: string): string | null {
  return isKnownFramework(framework) ? CONNECT_GUIDE_URLS[framework] : null;
}

/**
 * Whether a release of this framework can also be uploaded from the dashboard.
 * What the dashboard uploads is a `.cmpatch`, a React Native artifact: only
 * `cmpatch bundle` builds one.
 */
export function offersBundleUpload(framework: string): boolean {
  return framework === "react-native";
}

/** Neutral names when the framework is unknown — never an invented key. */
export function sdkConfigKeyNames(framework: string): SdkConfigKeyNames {
  return isKnownFramework(framework)
    ? SDK_CONFIG_KEY_NAMES[framework]
    : NEUTRAL_SDK_CONFIG_KEY_NAMES;
}
