// `release create` — also reachable as a bare `release`, which is how this command
// was spelled before the CLI had any other release subcommand. The behaviour is in
// ../release.ts.

import {
  CONNECTION_FLAGS,
  DEPLOYMENT_SELECTOR_FLAGS,
  DEPLOYMENT_USAGE,
  FORMAT_FLAG,
  readBoolean,
  readDeploymentSelector,
  readFormat,
  readInteger,
  readString,
  requireString,
  YES_FLAG,
  type CommandDefinition,
} from "../command";
import { executeRelease } from "../release";

export const releaseCreate: CommandDefinition = {
  flags: [
    {
      help: "Built web assets: the webDir of capacitor.config (for example www/ or dist/) with index.html at its root, or a ZIP of that directory's contents",
      name: "bundle-path",
      type: "string",
      value: "dir|zip",
    },
    {
      help: "Exact native app version the release is for, e.g. 1.4.0. Only installs of that version receive it",
      name: "target-binary-version",
      type: "string",
      value: "version",
    },
    ...DEPLOYMENT_SELECTOR_FLAGS,
    {
      help: "Share of devices offered the release (default: 100)",
      name: "rollout-percentage",
      type: "string",
      value: "1-100",
    },
    { help: "Mark the release as mandatory", name: "mandatory", type: "boolean" },
    { help: "Upload the release without making it available", name: "disabled", type: "boolean" },
    { help: "Notes stored with the release", name: "release-notes", type: "string", value: "text" },
    {
      help: "RSA private key (PEM) to sign the release with; required by apps that enforce code signing",
      name: "private-key-path",
      type: "string",
      value: "path",
    },
    {
      help: "Accept a bundle identical to the latest release",
      name: "no-duplicate-release-error",
      type: "boolean",
    },
    { help: "Validate, archive and hash the bundle without uploading", name: "dry-run", type: "boolean" },
    YES_FLAG,
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
  ],
  notes: [
    "Build the app first (ionic build, ng build, vite build, ...): this command ships the",
    "result and never runs the build itself. `release` on its own means `release create`.",
    "",
    "This CLI does not compute a native fingerprint: the binary version a release names",
    "is all that scopes it. Bump the native app version whenever the native side changes",
    "(a plugin added or upgraded, native code or configuration edited).",
  ],
  path: ["release", "create"],
  run: async (values, deps) => {
    // Required flags first, so their absence is reported before anything else.
    const bundlePath = requireString(values, "bundle-path");
    const targetBinaryVersion = requireString(values, "target-binary-version");
    const privateKeyPath = readString(values, "private-key-path");
    const serverUrl = readString(values, "server-url");
    const token = readString(values, "token");

    return executeRelease(
      {
        bundlePath,
        deployment: readDeploymentSelector(values),
        disabled: readBoolean(values, "disabled"),
        dryRun: readBoolean(values, "dry-run"),
        format: readFormat(values),
        mandatory: readBoolean(values, "mandatory"),
        noDuplicateReleaseError: readBoolean(values, "no-duplicate-release-error"),
        ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
        ...(typeof values["release-notes"] === "string"
          ? { releaseNotes: values["release-notes"] }
          : {}),
        rolloutPercentage:
          readInteger(values, "rollout-percentage", { max: 100, min: 1 }) ?? 100,
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        targetBinaryVersion,
        ...(token !== undefined ? { token } : {}),
        yes: readBoolean(values, "yes"),
      },
      deps,
    );
  },
  summary: "Upload built web assets as a new release of one deployment",
  usage: `--bundle-path <dir|zip> --target-binary-version <version> ${DEPLOYMENT_USAGE} [flags]`,
};
