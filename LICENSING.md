# Licensing

Codemagic Patch is distributed under **two licenses**, split by component. The
client-facing pieces (the React Native SDK and the CLI) are permissively
licensed under **Apache License 2.0**, while the server and its supporting
components are licensed under the **Codemagic Server License** (a
[Functional Source License 1.1](https://fsl.software/) variant that converts to
Apache 2.0).

This file is a human-readable summary. The authoritative terms are the `LICENSE`
file in the repository root and the per-directory `LICENSE` files listed below.

## What is licensed how

| Path | Component | License |
| --- | --- | --- |
| `client/` | React Native client SDK (the "Mobile SDK") | Apache-2.0 |
| `cli/` | `codemagic-patch` / `cmpatch` CLI | Apache-2.0 |
| `shared/` | Shared protocol types and schemas (bundled into the CLI) | Apache-2.0 |
| `examples/` | Integration example apps | Apache-2.0 |
| `benchmarks/` | Benchmark app | Apache-2.0 |
| `server/` | Update-delivery server | Codemagic Server License |
| `web-dashboard/` | Management dashboard | Codemagic Server License |
| `infra/` | Deployment infrastructure (Pulumi) | Codemagic Server License |
| `deploy/` | Deployment configuration | Codemagic Server License |
| *(repository root and everything else)* | — | Codemagic Server License |

The root `LICENSE` (Codemagic Server License) is the default for the repository.
A directory that carries its own `LICENSE` file is governed by that file
instead.

`shared/` is Apache-2.0 because its source is compiled into the published,
Apache-licensed CLI bundle. The Codemagic Server License explicitly permits
including Apache-2.0 code (§5), so the FSL-licensed server can depend on it
freely.

## Codemagic Server License — key terms (summary, not legal text)

- **Free use** up to **1,000,000 Monthly Active Users** (unique devices that
  request an update in a calendar month). Above that threshold you need a
  separate commercial license.
- **No Competing Use**: you may not offer the software as a commercial product
  or service that substitutes for, or provides substantially similar
  functionality to, Codemagic Patch.
- **Permitted purposes** include internal use, non-commercial education and
  research, and professional services for a licensee.
- **Converts to Apache 2.0** two (2) years after each version is published (the
  "Change Date").
- Per §13, the Mobile SDK (the `client/` package) is **not** covered by the
  Server License and is provided under Apache-2.0.

For a commercial license above the Monthly Active Users threshold, contact
Codemagic (Nevercode Ltd) — <https://codemagic.io>.

## License identifiers

In `package.json`:

- Apache components: `"license": "Apache-2.0"` (a listed SPDX identifier).
- Server components: `"license": "SEE LICENSE IN LICENSE"`. This is npm's required
  form for licenses that are not on the SPDX License List; npm's validator rejects
  a `LicenseRef-...` value in this field. All server packages are `private` and are
  not published.

For SBOM / SPDX / REUSE tooling (not `package.json`), the server license is
referenced as `LicenseRef-Codemagic-FSL-1.1-Apache-2.0`.
