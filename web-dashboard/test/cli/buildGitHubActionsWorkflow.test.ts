import { describe, expect, it } from "vitest";

import {
  buildGitHubActionsWorkflow,
  DEFAULT_GITHUB_ACTIONS_WORKFLOW_OPTIONS,
} from "../../src/cli/buildGitHubActionsWorkflow";

describe("buildGitHubActionsWorkflow", () => {
  it("includes dispatch platform input and secrets by default", () => {
    const yaml = buildGitHubActionsWorkflow({
      appName: "demo-app",
      deploymentName: "staging",
      serverUrl: "https://updates.example.com",
      ...DEFAULT_GITHUB_ACTIONS_WORKFLOW_OPTIONS,
    });

    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("platform:");
    expect(yaml).toContain('PATCH_APP: "demo-app"');
    expect(yaml).toContain("CODEMAGIC_PATCH_TOKEN");
    expect(yaml).toContain("npx @codemagic/patch-cli@latest release-react");
  });

  it("generates matrix workflow for both platforms", () => {
    const yaml = buildGitHubActionsWorkflow({
      appName: "demo-app",
      deploymentName: "staging",
      platformMode: "matrix-both",
      serverUrl: "https://updates.example.com",
    });

    expect(yaml).toContain("matrix:");
    expect(yaml).toContain("platform: [ios, android]");
    expect(yaml).not.toContain("type: choice");
  });

  it("adds signing key step when required", () => {
    const yaml = buildGitHubActionsWorkflow({
      appName: "demo-app",
      codeSigningRequired: true,
      deploymentName: "staging",
      serverUrl: "https://updates.example.com",
    });

    expect(yaml).toContain("CODEMAGIC_PATCH_SIGNING_KEY");
    expect(yaml).toContain("--private-key-path ./cmpatch-private.pem");
  });
});
