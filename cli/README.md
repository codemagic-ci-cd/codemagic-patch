# @codemagic/patch-cli

Command-line interface for releasing and managing over-the-air (OTA) React Native updates with [Codemagic Patch](https://github.com/codemagic-ci-cd/codemagic-patch). Provides the `cmpatch` command.

## Requirements

- Node.js `20.19+` or `22.12+`

## Install

```sh
npm install -g @codemagic/patch-cli
```

## Quick start

From your React Native project root, let the CLI connect the project to a Patch
server and create or select the platform apps and deployment:

```sh
cmpatch init

# Preview, then publish an OTA release
cmpatch release-react --deployment Staging --dry-run
cmpatch release-react --deployment Staging
```

`cmpatch init` guides you to install a server or enter an existing server URL,
sign in when needed, and writes the selected context to
`codemagic-patch.config.json`.

### Try the full service locally

To evaluate Patch before provisioning a server, start the full stack on your
machine:

```sh
cmpatch selfhost local-eval
```

This checks Docker (and offers to install or start it), keeps its own checkout
of Codemagic Patch, and starts the server, worker, Postgres, MinIO, and dashboard
on localhost. It requires `git`, `curl`, and Docker with Compose v2, and runs on
macOS, Linux, or WSL 2. Use `cmpatch selfhost local-eval status` to see the
services, checkout, and sample publish command; stop it with
`cmpatch selfhost local-eval down`.

## Commands

| Group | Description |
| --- | --- |
| `release` | Publish, inspect, patch, promote, and roll back OTA releases. |
| `management` | Manage apps, deployments, and deployment history. |
| `auth` | Authenticate, manage tokens, and manage team members. |
| `diagnostics` | Diagnose local setup and OTA readiness (`cmpatch doctor`). |
| `config` | Store defaults and inspect the effective local context. |
| `fingerprint` | Compute fingerprints and inspect device update logs. |
| `selfhost` | Run the local evaluation stack or install and maintain a self-hosted server. |

Use `cmpatch help <group>` for the commands in a group, `cmpatch help <command>` for per-command usage and examples, and `cmpatch --version` to print the CLI version.

## Output formats

Most commands accept `--format json|table`. When stdout is a terminal, output defaults to a human-readable table; when piped, it defaults to JSON, so the CLI is directly scriptable:

```sh
cmpatch app list --format json | jq '.apps[].name'
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Server or runtime error (not found, conflict, rate limited, …) |
| 2 | Authentication required or usage error |
| 3 | Validation error |
| 4 | Account disabled |
| 130 | Interactive prompt aborted (Ctrl-C) |

## Configuration

- **User config:** `~/.codemagic-patch/config.json` — CLI-wide defaults such as `serverUrl`. Credentials are stored per server in `~/.codemagic-patch/credentials.json`. Set the `CODEMAGIC_PATCH_HOME` environment variable to relocate this directory.
- **Project config:** `codemagic-patch.config.json` at your project root (or a `codemagicPatch` key in `package.json`) — per-project defaults such as `app`, `deployment`, and platform-specific overrides. Created by `cmpatch init`.

Explicit flags always take precedence over configured defaults. Run `cmpatch context` to inspect the effective configuration, and `cmpatch doctor` to diagnose setup issues.

## License

[Apache-2.0](./LICENSE)
