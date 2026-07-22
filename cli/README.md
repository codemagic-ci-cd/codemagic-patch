# @codemagic/patch-cli

Command-line interface for releasing and managing over-the-air (OTA) React Native updates with [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch). Provides the `cmpatch` command.

## Requirements

- Node.js >= 20

## Install

```sh
npm install -g @codemagic/patch-cli
```

## Quick start

```sh
# 1. Authenticate against your Codemagic Patch server
#    (opens the dashboard sign-in in your browser; add --no-browser to just
#     print the URL, or --token <cm_pat_...> for headless machines)
cmpatch login --server-url https://updates.example.com

# 2. Set up project defaults
cmpatch init

# 3. Publish a React Native bundle as an OTA release
cmpatch release-react --deployment Staging --dry-run   # preview first
cmpatch release-react --deployment Staging
```

## Commands

| Group | Description |
| --- | --- |
| `release` | Publish, inspect, patch, promote, and roll back OTA releases. |
| `management` | Manage teams, apps, deployments, and deployment history. |
| `iam` | Authenticate, manage tokens, and manage team members. |
| `diagnostics` | Diagnose local setup and OTA readiness (`cmpatch doctor`). |
| `config` | Store defaults and inspect the effective local context. |
| `fingerprint` | Compute fingerprints and inspect device update logs. |

Use `cmpatch help <group>` for the commands in a group, `cmpatch help <command>` for per-command usage and examples, and `cmpatch --version` to print the CLI version.

## Output formats

Most commands accept `--format json|table`. When stdout is a terminal, output defaults to a human-readable table; when piped, it defaults to JSON, so the CLI is directly scriptable:

```sh
cmpatch app list --format json | jq '.[].name'
```

## Configuration

- **User config:** `~/.codemagic-patch/config.json` — CLI-wide defaults such as `serverUrl` and `team`. Credentials are stored per server in `~/.codemagic-patch/credentials.json`. Set the `CODEMAGIC_PATCH_HOME` environment variable to relocate this directory.
- **Project config:** `codemagic-patch.config.json` at your project root (or a `cmpatch` key in `package.json`) — per-project defaults such as `app`, `deployment`, and platform-specific overrides. Created by `cmpatch init`.

Explicit flags always take precedence over configured defaults. Run `cmpatch context` to inspect the effective configuration, and `cmpatch doctor` to diagnose setup issues.

## License

[Apache-2.0](./LICENSE)
