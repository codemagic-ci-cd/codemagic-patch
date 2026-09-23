# Protocol

This document is the source of truth for client <-> server delivery contracts that are difficult to capture in OpenAPI / Swagger alone.

Scope:

- static delivery resources consumed by the client SDK
- JSON file schemas that are not served by the control-plane API
- artifact and directory-shape contracts shared by CLI, server, and client
- opaque JSON blobs carried through the control-plane API whose per-variant schema cannot be expressed as one OpenAPI schema
- behavioral rules that must stay stable across implementations

Out of scope:

- ordinary control-plane REST endpoints that belong in API spec / Swagger
- internal worker implementation details that do not affect the client-visible contract

If this document diverges from package-owned specs, align the package docs to this file.

## Static Delivery Resource Contract

All paths below are relative to the configured download base URL. The download base URL points at the static delivery origin — typically a public object storage endpoint, optionally fronted by a CDN.

This origin is named independently on each side but must hold the same value: the client SDK's `CodemagicPatchDownloadBaseUrl` native resource equals the server's `PUBLIC_BASE_URL` (byte-equal apart from an optional trailing slash). Because it is a storage/CDN origin, the value may include a bucket or path prefix (for example `/codemagic-patch`); the client appends the paths below to it. The separate `CodemagicPatchApiUrl` resource instead points at the API server origin (the server's `SERVER_URL`): the SDK appends `/v1/...` to it, so it takes the bare origin with no path.

- Manifest (primary, OTA-active device): `/{deployment_key}/{binary_version}/{current_package_hash}/manifest.json`
- Manifest (fallback, embedded-bundle device): `/{deployment_key}/{binary_version}/manifest.json`
- Deployment metadata: `/{deployment_key}/meta.json`
- Full bundle artifact: `/{deployment_key}/{binary_version}/{target_package_hash}/bundle.tar.zst`
- Patch artifact: `/{deployment_key}/{binary_version}/{target_package_hash}/patches/{from_package_hash}.zst`

Definitions:

- `deployment_key`: deployment identifier used by the client SDK
- `binary_version`: path-safe app-store binary version token such as `1.0.0`, `1.2`, or `2024.06`; not required to be semver. Ordered by numeric-dotted precedence for the store-update hint (see `meta.json` › Version Comparison); opaque tokens are incomparable.
- `current_package_hash`: deterministic hash of the package currently active on the device
- `target_package_hash`: deterministic hash of the effective OTA target release
- `from_package_hash`: source package hash used when generating a patch artifact

The client never asks the control-plane API whether an update exists. Update checks are fully driven by static delivery through deterministic paths.

## `meta.json`

### Path Rule

- Exactly one `meta.json` exists per deployment path: `/{deployment_key}/meta.json`.
- It is deployment-scoped, not binary-version-scoped.

### Schema

```json
{
  "latest_binary_version": "2.1.0"
}
```

### Semantics

- `latest_binary_version` is the highest binary version, by the precedence rule below, across the effectively published OTA release targets in the deployment. When every target is an opaque (incomparable) token, the server selects one deterministically (lexically greatest).
- This file is informational only. It provides a store-update hint and must not change OTA applicability — the client must never infer OTA applicability from it.
- The client fetches it in parallel with `manifest.json`.

### Version Comparison

Both the client (deciding whether to surface a hint) and the server (selecting the token to publish) compare binary versions with the same precedence rule. `binary_version` tokens are path-safe and not required to be semver, so the rule orders any consistent numeric-dotted scheme (semver, `MAJOR.MINOR`, calver such as `2024.06`) and treats anything else as incomparable.

A token is **comparable** iff it matches:

```
^\d+(\.\d+)*(-<dot-separated identifiers>)?(+<dot-separated identifiers>)?$
```

where each identifier is `[0-9A-Za-z-]+` (non-empty). To compare two comparable tokens:

1. Build metadata (everything from the first `+`) is dropped — it never affects precedence.
2. The numeric release segments before the optional `-` are compared left to right; a missing trailing segment counts as `0` (so `1.2` equals `1.2.0`). Leading zeros are allowed and not significant (`2024.06` equals `2024.6`, `01.0.0` equals `1.0.0`). Numeric segments are compared by magnitude, not lexically (`1.10.0` is higher than `1.2.0`), with no width limit.
3. If the release segments are equal, semver prerelease precedence applies: a token with a prerelease is lower than one without; per identifier, all-digit identifiers compare numerically and rank below alphanumeric identifiers, which compare lexically; a longer identifier set wins when all shared identifiers are equal.

If either token is **not comparable** (a non-numeric lead such as `latest`/`v2`, an empty or malformed identifier such as `1.0.0-`, an empty string, etc.), the two are **incomparable**.

### Client Rules

- Compare `latest_binary_version` with the app's own `binary_version` using the precedence rule above.
- Surface `isStoreUpdateAvailable = true` only when `latest_binary_version` is strictly **higher**. When it is equal, lower, or incomparable, set `isStoreUpdateAvailable = false`.
- `latestBinaryVersion` reports the token the server selected whenever `meta.json` was readable — including when no hint is surfaced.
- If the fetch fails, returns `404`, or is malformed (not a JSON object with a string `latest_binary_version`):
  - set `isStoreUpdateAvailable = false`
  - set `latestBinaryVersion = null`
  - do not fail or delay the OTA flow

## `manifest.json`

### Path Rule

Two manifest path patterns are defined. The client selects one based on whether an OTA package is currently active on the device.

Primary — OTA-active device:

- `/{deployment_key}/{binary_version}/{current_package_hash}/manifest.json`
- Keyed by the device's current package hash, not by the target hash.
- The server pre-generates these manifests for known `current_package_hash` values in a given deployment/binary-version chain, enabling per-baseline patch selection.
- A 404 on this path signals "no pre-generated manifest for this specific hash" and the client retries with the fallback path.

Fallback — embedded-bundle device or primary 404:

- `/{deployment_key}/{binary_version}/manifest.json`
- Keyed only by `deployment_key` and `binary_version`; no `current_package_hash` segment.
- The embedded binary bundle is **not** hash-identified to the server. Devices running the embedded bundle (fresh install, or reverted-to-embedded) use this path directly without attempting the primary.
- Response contract: the server returns the latest healthy OTA for `{deployment_key, binary_version}` using the same selection logic as the primary path (rollout, disabled-release handling, `previous_package_info` semantics).
- **Responses on this path MUST omit `patch_url` (both on the root target and within `previous_package_info`).** The server has no baseline to diff against, so the client MUST apply a full-bundle update. Any `patch_url` present on a fallback-path response is a protocol violation and must be ignored by the client.
- A 404 on this path signals "no healthy OTA exists for this `binary_version` in this deployment" and is treated by the client as a no-op (stay on the current package).
- If no healthy OTA exists, the server may instead return `{ "target_package_hash": null }` to explicitly mark the binary bundle as authoritative — same sentinel semantics as the primary path.

### Schema

```jsonc
{
  "target_package_hash": "sha256-hex-string | null",
  "release_label": "v3",
  "patch_url": "https://downloads.example.com/.../patches/{from_package_hash}.zst",
  "patch_size": 102400,
  "full_bundle_url": "https://downloads.example.com/.../bundle.tar.zst",
  "full_bundle_size": 524288,
  "is_mandatory": false,
  "release_notes": "Bug fixes and performance improvements",
  "rollout_percentage": 100,
  "signature": "jwt-string",
  "previous_package_info": {
    "release_label": "v2",
    "package_hash": "sha256-hex-string",
    "patch_url": "https://downloads.example.com/.../patches/{from_package_hash}.zst",
    "patch_size": 81920,
    "full_bundle_url": "https://downloads.example.com/.../bundle.tar.zst",
    "full_bundle_size": 491520,
    "is_mandatory": false,
    "release_notes": "Initial release",
    "rollout_percentage": 100,
    "signature": "jwt-string"
  }
}
```

### Field Rules

- `target_package_hash` is always present.
- `target_package_hash = null` means "revert to the embedded binary bundle".
- `release_label` is present when `target_package_hash` is non-null and omitted when the target is the embedded binary.
- `patch_url` is optional and may be absent because:
  - no patch was generated for this `current_package_hash`
  - the hash is outside the configured patch window
  - the selected target is the embedded binary
- `full_bundle_url` is the fallback artifact for the selected OTA target.
- `full_bundle_size` is required whenever `full_bundle_url` is present. If
  `previous_package_info` is present, its `full_bundle_size` is required as
  well.
- `patch_size` is optional and may be omitted when no patch is advertised or
  when the server does not know the patch size yet.
- `signature` is present only when the effective target release carries a code-signing signature.
- `previous_package_info` is present only when the effective latest target has a published, non-disabled predecessor in the same deployment + binary-version chain.

### Behavioral Rules

- `previous_package_info` refers to the immediate predecessor of the latest effective release, not the predecessor of `current_package_hash`.
- If `target_package_hash == current_package_hash`, the client must treat the manifest as a no-op.
- If rollout excludes the latest target and `previous_package_info` exists, the client may use `previous_package_info` as the fallback candidate.
- `previous_package_info` mirrors the root manifest descriptor so the client can use it without making an extra request.
- `is_mandatory` is already resolved by the server. The server may convert an optional target to mandatory if any intermediate release in the upgrade chain is mandatory.
- `patch_size` is informational in MVP and must not be treated as an install blocker.

## Artifact and Directory Contract

### Hashed Payload Root

The logical OTA payload is the package root contents tree only.

- Package hash is computed from normalized file entries inside the payload tree.
- The payload tree includes the bundle file AND all OTA asset files (images, fonts, etc.).
- Transport containers such as ZIP, tar, zstd output, and manifest JSON are not part of the package hash.
- `update.json` is not part of the hashed payload.

### Package Hashing Contract (`package_hash_v1`)

The package hash is a deterministic SHA-256 digest over the payload tree contents. This contract must be implemented identically by the CLI, server, and client SDK (Android + iOS).

**Canonicalization Rules:**

1. Start from the package root `contents/`. The directory name itself is not part of the hash.
2. Include **regular files only** (no directories, symlinks).
3. Convert all path separators to `/`.
4. Reject absolute paths.
5. Reject paths containing `..` after normalization.
6. Reject duplicate normalized paths.
7. Ignore:
   - `__MACOSX/**`
   - any `.DS_Store` file

**Hash Algorithm:**

```text
For every included file:
  fileHash = sha256(file bytes)
  entry   = "<normalizedRelativePath>:<fileHash>"

entries     = sort(all entry strings, lexicographic by UTF-8 byte order)
packageHash = sha256(JSON.stringify(entries))
```

The result is a lowercase hex-encoded SHA-256 string.

**What is NOT part of the hash input:**

- ZIP / tar / zstd container bytes
- manifest JSON served from the static delivery origin
- release metadata stored on the server
- client-local metadata such as `update.json`
- signing metadata (signatures are stored outside the payload tree)

**Cross-platform conformance** is enforced with shared fixture directories and expected-hash test vectors. Each implementation (CLI, server, Android, iOS) must produce the identical hash for the same fixture payload.

### On-Device Package Layout

```text
codemagic-patch/
  packages/
    {package_hash}/
      contents/
        ...bundle files...
      update.json
  state/
    state.json
  downloads/
  tmp/
```

Rules:

- Downloaded or patched bundle content ultimately lands in `packages/{package_hash}/contents/`.
- `update.json` lives next to `contents/`, outside the hashed subtree.
- `state/state.json` is a single JSON file holding the on-device package lifecycle state; it is rewritten atomically as a whole file (write-to-temp-then-rename) on every change. Its field schema is owned by the client on-device storage spec.
- Hash verification and patch application operate on `contents/` only.

### Full Bundle Archive Contract

- `bundle.tar.zst` represents the payload tree that becomes `packages/{target_package_hash}/contents/`.
- No wrapper directory name is semantically part of the payload.
- After untar, the client verifies the deterministic package hash against the extracted `contents/` subtree only.

### Full Bundle Archive Format

`bundle.tar.zst` is a single standard **zstd frame** wrapping a **POSIX `ustar`
tar** stream. This is a deliberately narrow, load-bearing wire contract: the
server writer and the client C extractor each implement and enforce exactly the
subset below, so a producer that switches to a general-purpose tar library
(which typically emits directory entries, PAX records, or non-zero mtime) would
produce archives every client rejects. Any change to the writer must preserve
this profile or update all decoders together.

**Tar profile** (512-byte blocks, `ustar` magic at offset 257, version `00` at
offset 263):

- **Regular files only.** The type flag (offset 156) is `'0'` (`0x30`) — a NUL
  byte is also accepted as a regular file. The only other accepted type is the
  GNU long-name record (`'L'`) defined under **Long paths** below. Decoders
  **must reject** every other type, including directory (`'5'`), symlink,
  hardlink, and PAX/GNU extension records (`'x'`, `'g'`, `'K'`). There are
  **no directory entries**; parent directories are implied by file paths and
  created on extraction.
- **Zeroed metadata.** `mode` = `0644`, `uid` = `0`, `gid` = `0`, `mtime` = `0`.
  `uname`/`gname`/`devmajor`/`devminor` are left empty. This keeps the archive
  byte-identical regardless of the build host.
- **Long paths via `ustar` prefix splitting.** A path longer than 100 bytes is
  split at a `/` boundary into `name` (≤100 bytes, offset 0) and `prefix`
  (≤155 bytes, offset 345); decoders reconstruct `prefix + "/" + name`.
- **Unsplittable paths via GNU long-name records (`'L'`).** A path that cannot
  be split to fit both fields (e.g. a single path segment longer than 100
  bytes, as produced by Metro's flattened Android asset names) is encoded as a
  GNU long-name sequence, emitted **only** when prefix splitting fails so that
  archives without such paths remain byte-identical to the pre-`'L'` profile:
  1. A header block with `name` = `././@LongLink`, type flag `'L'`, the same
     zeroed metadata as regular entries, empty `prefix`, and `size` = byte
     length of the full UTF-8 path + 1 (a single trailing NUL).
  2. Data blocks containing the path bytes + one NUL, zero-padded to the next
     512-byte boundary.
  3. The entry's regular header (`'0'`), whose `name` field carries the first
     100 bytes of the path as an opaque deterministic placeholder (it may end
     mid-codepoint) and whose `prefix` is empty, followed by file data as
     usual. Decoders replace this header's path with the long-name path.

  Decoder rules: the long-name path is the data bytes before the trailing NUL;
  it must be non-empty, at most **4096 bytes**, and passes the same path
  normalization/validation as reconstructed split paths. An `'L'` record not
  immediately followed by a regular-file header (end of archive, zero block, or
  another `'L'`) is an error. Writers must reject paths longer than 4096 bytes.

  **Producer path limits.** The wire format can express paths no device can
  materialize, so the server rejects them before publishing rather than
  shipping a release that fails every install: a path segment longer than
  **255 bytes** exceeds `NAME_MAX` on Android ext4/f2fs and iOS APFS
  (`mkdir`/`open` fail with `ENAMETOOLONG`). The server additionally caps each
  relative path at **512 bytes** to reserve roughly half of iOS `PATH_MAX` for
  the absolute application container and package directories. Both limits are
  enforced at bundle ingest and again in the archive writer.

  **Compatibility:** client SDKs earlier than `0.1.4` reject `'L'` records, so
  a release whose payload contains an unsplittable path installs only on
  devices running SDK ≥ 0.1.4; the CLI warns at publish time when a bundle
  needs long-name encoding.
- **Standard checksum.** Header checksum is the unsigned sum of all 512 header
  bytes with the checksum field taken as eight spaces, written at offset 148 as
  six octal digits + NUL + space.
- **Block padding.** Each entry's data is zero-padded to the next 512-byte
  boundary; the archive ends with two 512-byte zero blocks.

**Deterministic entry order.** Entries are emitted in ascending
byte-lexicographic order of the manifest line `"{path}:{sha256_hex(file)}"`
— the same ordering used by the [Package Hashing Contract](#package-hashing-contract-package_hash_v1).
Combined with the zeroed metadata, this makes `bundle.tar.zst` byte-deterministic
for a given payload tree. Entry paths follow the same normalization as the
package hash (relative POSIX paths, no leading `/` or `..`; `.DS_Store` and
`__MACOSX/` excluded).

**zstd constraints.** The outer layer is one standard zstd frame. The encoder
**must keep the zstd window within the decoder's default limit: `windowLog ≤ 27`
(≤ 128 MiB).** The client decompresses with a default `ZSTD_DStream`, which
rejects frames whose declared window exceeds 128 MiB
(`frameParameter_windowTooLarge`); it does not raise `ZSTD_d_windowLogMax`.
Default-level zstd compression stays well under this bound, so no explicit
parameter is required today — but a future high-window encoder would break
decompression on every client.

### Patch Artifact Contract

- Patch files are self-contained HDiffPatch directory-diff containers (`hdiffz` directory diff, single-compressed-diff layout, internal zstd codec, fadler64 checksum). The container is **not** a standalone zstd frame: it begins with the HDiffPatch directory-diff magic, and the zstd-compressed diff stream lives *inside* the container. The `.zst` suffix on the patch path therefore denotes this internal codec, not an outer zstd wrapper.
- The client applies the container directly with `hpatchz` (built with the zstd decompression plugin). There is **no** separate external zstd-decompression of the artifact before patch application; the internal zstd stream is decompressed inside `hpatchz` as part of applying the patch. (Contrast: the full-bundle artifact `bundle.tar.zst` *is* a real zstd frame and is zstd-decompressed before untar.)
- Source tree: the current package `contents/` directory.
- Target tree: the target package payload tree.
- The client applies the patch into `tmp/{target_package_hash}/contents`, then verifies the resulting `contents/` subtree hash.
- On hash mismatch or patch failure, the client falls back once to the full bundle.

### Bundle Format Agnosticism

- The payload may contain plain JS bundles, Hermes bytecode, and assets.
- The server and client treat the payload as an opaque directory tree.
- Compatibility is determined by `binary_version`, fingerprint expansion, and package hash, not by bundle file extension.

## Metric Event `Failed` Payload

A `Failed` metric event names *which* failure class occurred through
`attributes.reason` (taxonomy owned by `client/specs/metrics/Spec.md`). The
reason alone is too coarse to act on: a deployment reporting 78 `network`
failures gives an operator no way to tell a CDN 403 apart from a device that
lost connectivity mid-download. `attributes.payload` carries the detail that
closes that gap.

This contract lives here rather than in OpenAPI because the payload travels as
an opaque JSON *string* inside `attributes`, which OpenAPI can describe only as
"a string"; because what its fields mean is qualified by the value of a sibling
field (`attributes.reason`); and because the server must accept payloads
produced by SDK versions older than any rule written below.

### Backward Compatibility Is Mandatory

**Once a payload shape ships, every later change to it must stay backward
compatible.** This is stricter than the usual API-evolution courtesy, because
two things make an incompatible change unrecoverable rather than merely
disruptive:

- **The old shape is already in the database.** Metric events are an
  append-only historical record: every payload a released SDK ever sent is
  sitting in `metric_event`, and it recorded what that SDK actually observed.
  Rewriting those rows to a new shape would not be a migration — it would be
  fabricating measurements nobody took.
- **The old shape keeps arriving.** A client SDK version lives on real devices
  for as long as users decline to update, so a shape that shipped once keeps
  being emitted indefinitely. There is no flag day and no way to force one.

A field's **name, type, and meaning are immutable once released.** New
semantics take a new field name; they never reuse an existing one. This is the
mechanism that replaces payload versioning — there is no version marker,
because a field that never changes meaning does not need one.

| Change | Allowed | Why |
|--------|---------|-----|
| Add an optional field | yes | Readers already treat every field as optional |
| Stop sending a field | yes | Stored rows keep it; readers must still tolerate it |
| Add a value to a field's value space | yes | Readers must already tolerate values they do not recognize |
| Rename a field | **no** | Splits one fact across two names inside a single dataset |
| Change a field's type | **no** | No query can separate the two shapes after the fact |
| Redefine what a value means | **no** | Silently merges two different measurements under one key |

The last row is the dangerous one because it fails quietly. Had `code` been
released carrying `"HTTP_403"`-style names and then redefined to hold bare HTTP
statuses, both value spaces would now live in one column with nothing marking
which SDK produced which — the breakdown would read as though a single value
space had always been in use.

Readers carry the matching obligation: **treat every payload field as optional
and every value as possibly older than the current schema.** A dashboard or
query that assumes a field is present, or that a value space is closed, breaks
the first time it meets a row an older SDK wrote.

The same reasoning governs every stored envelope field, not just `payload`.

### Encoding

- `attributes.payload` is a **JSON string**, not a nested JSON object. Every
  other `attributes` value is a string, and keeping the map homogeneous lets
  each platform's native bridge carry it without a nested-container code path.
- The string MUST decode to a **JSON object**. Arrays, scalars, and `null` are
  protocol violations.
- The encoded string MUST NOT exceed **4096 bytes** of UTF-8. Clients truncate
  their own fields before serializing rather than emitting an oversized payload.
- `payload` is optional on every event. It is meaningful only on `Failed`
  events; a `payload` present on any other `event_name` is ignored.

### Schema

**Every reason uses the same payload shape.** There is no per-reason schema and
no discriminator field: one object, three optional fields, identical for a
download failure and a crash rollback alike.

```jsonc
{
  "code": "403",
  "message": "AccessDenied: Access Denied.",
  "android_previous_process_exit": "REASON_USER_REQUESTED"
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `code` | string, optional | The failure's machine-readable discriminator, and the key every breakdown groups on. What it enumerates is per-reason; see the table below. |
| `message` | string, optional | Failure text relayed from whatever reported the failure. Never composed by the client. |
| `android_previous_process_exit` | string, optional | Why this app's previous process ended. Android only; see below. |

The uniformity is a decision about the *reader* as much as the writer. One
shape means one server column, one aggregation query, and one dashboard
drill-down (reason → `code` → detail) that reads identically whichever failure
it is pointed at. A reason that gains detail later needs no new storage, no new
endpoint, and no new screen. Per-reason shapes would have bought
tighter-fitting fields at the cost of N of each.

**Every field is optional, and a payload with nothing to put in any of them is
not sent at all**: `payload` is omitted rather than serialized as `{}`. A crash
rollback has no status and no text to relay, but does have the platform's
account of how the previous process died; a download failure on iOS has the
first two and never the third. Requiring any field would force one of those
cases to invent a placeholder, and a placeholder is worse than an absence
because nothing afterwards can tell it apart from a real value.

A payload may carry fields beyond these three; a server MUST retain unknown
fields verbatim rather than reject the event.

### Per-Reason Meaning

The shape is fixed; what `code` and `message` mean is the reason's business.
`code` must stay **enumerable and stable within a reason** because every
breakdown groups on it, so it must never become free text.

| `reason` | `code` | `message` |
|----------|--------|-----------|
| `network` | HTTP status of the failed response, or `"0"` — defined below | relayed origin or platform error text — defined below |
| every other reason | not yet populated | not yet populated |

Reasons other than `network` currently carry
`android_previous_process_exit` alone and aggregate under the no-code bucket.
When one of them gains a discriminator, it takes **this same `code` field**
under the same rules rather than a field of its own — that is what "one shape"
buys, and abandoning it for the second reason would forfeit all of it.

### `android_previous_process_exit`

Why this app's **previous process** ended, as an Android `ApplicationExitInfo`
reason constant name: `REASON_CRASH`, `REASON_CRASH_NATIVE`, `REASON_ANR`,
`REASON_LOW_MEMORY`, `REASON_SIGNALED`, `REASON_USER_REQUESTED`,
`REASON_EXIT_SELF`, and the rest of that enum. A constant a client's SDK
version does not recognize — one added by a later platform release — is
reported as its decimal number rather than folded into an existing name.
**Omitted** on iOS and on Android 10 and older, where no platform API can
answer the question.

This is a *fact lookup*, not an inference: it is the only way to tell a launch
that crashed apart from one the OS reclaimed under memory pressure. It is sent
on every reason, not only the ones it obviously bears on, because the same
distinction changes what a failure means everywhere — most sharply on
`install_fail`, where it separates a genuinely broken package from a rollback
the OS provoked.

Exactly one exit reason is reported: the most recent. Older records describe
launches the failure cannot be about.

### `network` — download failure

`code` is the **HTTP status code** of the failed response, in decimal, as a
string. `"0"` when the request produced no HTTP response at all: a connect or
read timeout, a DNS failure, a TLS handshake failure, a connection dropped
mid-transfer, no network interface, or a cancelled request. Nothing else may
appear here — the value space is the enumerable set of HTTP statuses plus
`"0"`.

`message` is failure text **relayed from whatever reported the failure**, at
most **512 bytes** (clients truncate longer text). The client never composes
it. Where it is relayed from follows `code`:

- **`code = "0"`** — the platform's raw error text, unedited:
  `"The request timed out."`, `"Unable to resolve host …"`. With no status to
  group on, this string is the only thing separating a timeout from a DNS
  failure.
- **`code` = an HTTP status** — the origin's error document. OTA artifacts are
  served by object storage or a CDN, never by the API server, and those answer
  a non-2xx with a document naming the cause. From an S3-compatible origin the
  client relays `"{Code}: {Message}"` —
  `"NoSuchKey: The specified key does not exist."` for an artifact that was
  never uploaded, `"AccessDenied: Access Denied."` for a bucket policy,
  `"SignatureDoesNotMatch: …"` for signing. That distinction is the entire
  diagnostic value of a 403 or 404, and only the origin can supply it.

  Only `Code` and `Message` may be relayed. The same document also carries
  `Key` and `Resource`, which embed the deployment key and package hash;
  relaying the body wholesale would put those into telemetry, which is a data
  hygiene question rather than an aesthetic one. Fields that merely vary per
  request — S3's `RequestId` and `HostId`, or the request id Azure appends
  inside `Message` itself — are **not** a reason to edit anything: `code` is
  the aggregation key, so a message that is unique per occurrence costs nothing
  and is often what an operator hands to the provider's support. Clients read a
  bounded prefix of the body (**4096 bytes**) — a CDN answering with its own
  HTML error page must not be held in memory to extract two tags from it.

`message` is **omitted** when nothing could be relayed: the origin returned a
body with neither tag, or none at all. That is not a protocol violation but the
honest report that the origin said nothing, and the server and dashboard treat
it as absent rather than listing it. A client must never fill the gap with text
of its own.

In no case does the client add anything of its own — no URL, no package hash,
no timestamp. That follows from relaying rather than composing, not from any
concern about how many distinct messages result. Text the platform or origin
itself produced is relayed as it stands, hostnames and request ids and all.

The exact wording is not part of this contract; breakdowns list the distinct
messages under each `code` rather than matching on them.

**Known gap.** Every transport-level failure shares `code = "0"`, so a timeout
is not distinguishable from a DNS failure by the aggregation key alone — only
the free-text `message` separates them today. A dedicated
transport-classification field alongside `code` is deferred.

### Server Rules

The payload is best-effort observability and must never cost the server a
`Failed` event:

- The server parses `attributes.payload` and stores the decoded object in its
  own column, so breakdowns aggregate on `payload -> 'code'` without re-parsing
  text per row.
- If `payload` is absent, is not a string, exceeds the byte cap, fails to
  parse, or does not decode to a JSON object, the server stores **no** decoded
  payload and **still persists the event**. A malformed detail blob must never
  turn into a dropped `Failed` event — the count matters more than the detail.
- `attributes` is persisted verbatim, including the raw `payload` string, so a
  payload the server could not decode stays recoverable for debugging.
- The server does not validate a payload against the reason that carried it. It
  stores what decoded and lets the breakdown surface whatever `code` arrived,
  so a reason starting to populate `code` never requires a server release
  first.
- Events whose decoded payload has no `code`, and events with no payload at
  all, aggregate under the **same** no-code bucket. They are indistinguishable
  by `code` alone and are not meant to be: both report a failure that named no
  discriminator.

## Protocol Rules Not Well Represented by Swagger

- The update-check protocol is static-delivery-first. OpenAPI cannot adequately express that the client builds deterministic download paths and resolves update availability by hash comparison.
- `404` on `manifest.json` means "no manifest exists for this current hash". It is a no-op and is not equivalent to `target_package_hash = null`.
- `target_package_hash = null` is an explicit binary-fallback instruction, not an absence of manifest.
- The client must never construct an alternative manifest path after a manifest fetch failure.
- Rollout stickiness uses `md5(installation_id + "-" + release_label) % 100 < rollout_percentage`. The `% 100` operand is computed by a fixed digest→integer reduction that every implementation must match: take the lowercase hex MD5 digest, read its first 8 hex characters (the first 4 digest bytes, big-endian) as an unsigned 32-bit integer, then apply `% 100` to obtain a bucket in `[0, 99]`. A device is eligible when its bucket is `< rollout_percentage`. A naive reading that takes the full 128-bit digest modulo 100 produces a different bucket and must not be used.
- The client does not perform a second rollout evaluation on `previous_package_info` in MVP.
- `meta.json` is fire-and-forget and must not block or retry-gate the manifest path.

## Metric Lifecycle Names

New SDK emission and ingestion use `Downloaded`, `Ready`, `Applied`, `Failed`,
and `Active`. `Downloaded` is unchanged. `Ready` means the artifact is unpacked
and SDK state is prepared for the next session according to the activation
policy. `Applied` means the new update runs successfully, confirmed by
`notifyAppReady()`; it remains once per device and package.

Historical `Installed` and `Success` rows are read only as
compatibility aliases for `Ready` and `Applied`. Do not rename or backfill stored
events. Existing failure supersession still applies: either historical `Success`
or new `Applied` prevents late failures from counting against an already
confirmed device/package.

SDK releases before the rename (`@codemagic/react-native-patch` 0.4.x and
earlier) still emit `Installed` and `Success`. Ingestion accepts those two names
transitionally and stores them as `Ready` and `Applied`, with the same
`delivery_type` and supersession rules, so upgrading the server does not drop
metrics from apps already in the field. 

Metrics response keys `installed` and `success` remain stable for existing API
consumers; they count Ready and Applied respectively, including historical
aliases. Display labels use Ready and Applied. The application success rate
remains `success / (success + failed)`, not Applied divided by Ready.
The SDK retains `success_reported_at` on disk (and `successReportedAt` in its
metadata model) so SDK upgrades preserve the once-per-package reporting marker.

