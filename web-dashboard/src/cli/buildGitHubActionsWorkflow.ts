// Generates a GitHub Actions workflow YAML for cmpatch release-react.
// Mirrors options from CliCommandBuilder where applicable.

export type GitHubActionsPlatformMode =
  | "dispatch-input"
  | "android-only"
  | "ios-only"
  | "matrix-both";

export type GitHubActionsRunner = "ubuntu-latest" | "macos-latest";

export type GitHubActionsBundler = "auto" | "metro" | "expo";

export interface GitHubActionsDispatchInputs {
  mandatory: boolean;
  releaseNotes: boolean;
  rolloutPercentage: boolean;
  targetBinaryVersion: boolean;
}

export interface BuildGitHubActionsWorkflowInput {
  appName: string;
  bundler?: GitHubActionsBundler;
  codeSigningRequired?: boolean;
  deploymentName: string;
  dispatchInputs?: Partial<GitHubActionsDispatchInputs>;
  monorepoRoot?: string;
  platformMode?: GitHubActionsPlatformMode;
  runner?: GitHubActionsRunner;
  serverUrl: string;
  workflowFilename?: string;
}

const DEFAULT_DISPATCH_INPUTS: GitHubActionsDispatchInputs = {
  mandatory: true,
  releaseNotes: true,
  rolloutPercentage: false,
  targetBinaryVersion: true,
};

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildWorkflowDispatchInputs(
  platformMode: GitHubActionsPlatformMode,
  dispatchInputs: GitHubActionsDispatchInputs,
): string[] {
  if (platformMode !== "dispatch-input" && platformMode !== "matrix-both") {
    return [];
  }

  const lines: string[] = ["    inputs:"];

  if (platformMode === "dispatch-input") {
    lines.push("      platform:");
    lines.push("        type: choice");
    lines.push("        required: true");
    lines.push("        options:");
    lines.push("          - ios");
    lines.push("          - android");
  }

  if (dispatchInputs.releaseNotes) {
    lines.push("      release_notes:");
    lines.push("        type: string");
    lines.push("        required: false");
  }

  if (dispatchInputs.targetBinaryVersion) {
    lines.push("      target_binary_version:");
    lines.push("        type: string");
    lines.push("        required: false");
  }

  if (dispatchInputs.rolloutPercentage) {
    lines.push("      rollout_percentage:");
    lines.push("        type: string");
    lines.push("        default: \"100\"");
  }

  if (dispatchInputs.mandatory) {
    lines.push("      mandatory:");
    lines.push("        type: boolean");
    lines.push("        default: false");
  }

  return lines;
}

function platformExpression(
  platformMode: GitHubActionsPlatformMode,
): string {
  switch (platformMode) {
    case "android-only":
      return "android";
    case "ios-only":
      return "ios";
    case "matrix-both":
      return "${{ matrix.platform }}";
    case "dispatch-input":
    default:
      return "${{ inputs.platform }}";
  }
}

function buildReleaseCommand(options: {
  bundler: GitHubActionsBundler;
  codeSigningRequired: boolean;
  dispatchInputs: GitHubActionsDispatchInputs;
  platformExpr: string;
  platformMode: GitHubActionsPlatformMode;
}): string[] {
  const lines = [
    "          ARGS=(--app \"$PATCH_APP\" --deployment \"$PATCH_DEPLOYMENT\" --platform \"" +
      options.platformExpr +
      "\" --yes --non-interactive)",
  ];

  if (options.bundler !== "auto") {
    lines.push(
      `          ARGS+=(--bundler ${options.bundler})`,
    );
  }

  if (options.dispatchInputs.releaseNotes) {
    lines.push(
      '          if [ -n "${{ inputs.release_notes }}" ]; then ARGS+=(--release-notes "${{ inputs.release_notes }}"); fi',
    );
  }

  if (options.dispatchInputs.targetBinaryVersion) {
    lines.push(
      '          if [ -n "${{ inputs.target_binary_version }}" ]; then ARGS+=(--target-binary-version "${{ inputs.target_binary_version }}"); fi',
    );
  }

  if (options.dispatchInputs.rolloutPercentage) {
    lines.push(
      '          if [ -n "${{ inputs.rollout_percentage }}" ] && [ "${{ inputs.rollout_percentage }}" != "100" ]; then ARGS+=(--rollout-percentage "${{ inputs.rollout_percentage }}"); fi',
    );
  }

  if (options.dispatchInputs.mandatory) {
    lines.push(
      '          if [ "${{ inputs.mandatory }}" = "true" ]; then ARGS+=(--mandatory); fi',
    );
  }

  if (options.codeSigningRequired) {
    lines.push("          ARGS+=(--private-key-path ./cmpatch-private.pem)");
  }

  lines.push('          npx @codemagic/patch-cli@latest release-react "${ARGS[@]}"');

  return lines;
}

function buildJobBody(input: {
  bundler: GitHubActionsBundler;
  codeSigningRequired: boolean;
  dispatchInputs: GitHubActionsDispatchInputs;
  monorepoRoot?: string;
  platformMode: GitHubActionsPlatformMode;
  runner: GitHubActionsRunner;
}): string[] {
  const platformExpr = platformExpression(input.platformMode);
  const workingDirectory =
    input.monorepoRoot !== undefined && input.monorepoRoot.trim().length > 0
      ? input.monorepoRoot.trim()
      : undefined;

  const lines: string[] = [
    `    runs-on: ${input.runner}`,
  ];

  if (workingDirectory !== undefined) {
    lines.push("    defaults:");
    lines.push("      run:");
    lines.push(`        working-directory: ${yamlString(workingDirectory)}`);
  }

  if (input.platformMode === "matrix-both") {
    lines.push("    strategy:");
    lines.push("      matrix:");
    lines.push("        platform: [ios, android]");
  }

  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("      - uses: actions/setup-node@v4");
  lines.push("        with:");
  lines.push("          node-version: \"20\"");

  if (input.codeSigningRequired) {
    lines.push("      - name: Write code signing key");
    lines.push("        run: printf '%s' \"$CODEMAGIC_PATCH_SIGNING_KEY\" > cmpatch-private.pem");
    lines.push("        env:");
    lines.push("          CODEMAGIC_PATCH_SIGNING_KEY: ${{ secrets.CODEMAGIC_PATCH_SIGNING_KEY }}");
  }

  lines.push("      - name: Publish to Codemagic Patch");
  lines.push("        env:");
  lines.push("          CODEMAGIC_PATCH_TOKEN: ${{ secrets.CODEMAGIC_PATCH_TOKEN }}");
  lines.push("          CODEMAGIC_PATCH_SERVER_URL: ${{ secrets.CODEMAGIC_PATCH_SERVER_URL }}");
  lines.push("        run: |");

  for (const line of buildReleaseCommand({
    bundler: input.bundler,
    codeSigningRequired: input.codeSigningRequired,
    dispatchInputs: input.dispatchInputs,
    platformExpr,
    platformMode: input.platformMode,
  })) {
    lines.push(line);
  }

  if (workingDirectory !== undefined) {
    lines.push(
      `          # Monorepo: project root is ${workingDirectory} via defaults.run.working-directory`,
    );
  }

  return lines;
}

export function buildGitHubActionsWorkflow(
  input: BuildGitHubActionsWorkflowInput,
): string {
  const platformMode = input.platformMode ?? "dispatch-input";
  const runner = input.runner ?? "ubuntu-latest";
  const bundler = input.bundler ?? "auto";
  const workflowFilename =
    input.workflowFilename?.trim() || "codemagic-patch-release.yml";
  const dispatchInputs: GitHubActionsDispatchInputs = {
    ...DEFAULT_DISPATCH_INPUTS,
    ...input.dispatchInputs,
  };

  const header = [
    `# Save as .github/workflows/${workflowFilename}`,
    "#",
    "# Required GitHub secrets:",
    "#   CODEMAGIC_PATCH_TOKEN — API token from the Patch dashboard",
    `#   CODEMAGIC_PATCH_SERVER_URL — ${input.serverUrl}`,
    ...(input.codeSigningRequired
      ? ["#   CODEMAGIC_PATCH_SIGNING_KEY — PEM private key for signed releases"]
      : []),
    "#",
    `# App: ${input.appName} · Deployment: ${input.deploymentName}`,
    ...(platformMode === "ios-only" && runner === "ubuntu-latest"
      ? [
          "# Note: iOS bundle builds may need macos-latest for native project access.",
        ]
      : []),
    "",
    "name: Codemagic Patch release",
    "on:",
    "  workflow_dispatch:",
    ...buildWorkflowDispatchInputs(platformMode, dispatchInputs),
    "",
    "env:",
    `  PATCH_APP: ${yamlString(input.appName)}`,
    `  PATCH_DEPLOYMENT: ${yamlString(input.deploymentName)}`,
    "",
    "jobs:",
    "  release:",
    ...buildJobBody({
      bundler,
      codeSigningRequired: input.codeSigningRequired === true,
      dispatchInputs,
      monorepoRoot: input.monorepoRoot,
      platformMode,
      runner,
    }),
    "",
  ];

  return header.join("\n");
}

export const DEFAULT_GITHUB_ACTIONS_WORKFLOW_OPTIONS: Required<
  Pick<
    BuildGitHubActionsWorkflowInput,
    | "platformMode"
    | "runner"
    | "bundler"
    | "workflowFilename"
    | "dispatchInputs"
  >
> = {
  bundler: "auto",
  dispatchInputs: DEFAULT_DISPATCH_INPUTS,
  platformMode: "dispatch-input",
  runner: "ubuntu-latest",
  workflowFilename: "codemagic-patch-release.yml",
};
