# Codemagic Patch Documentation

Guides for running, operating, and integrating Codemagic Patch. New here? Start with
the [root README](../README.md) — product overview, quickstart, and end-to-end setup.

- [Migrate from CodePush](migrate-from-codepush.md) — swap `react-native-code-push`
  for `@codemagic/react-native-patch` and map your CLI workflow to `cmpatch`.
- [Self-hosting with Docker Compose](self-hosting-compose.md) — the supported
  production deployment path: one Docker host, bundled PostgreSQL and MinIO, Caddy
  for HTTPS.
- [Custom deployment](custom-deployment.md) — reference for operators bringing their
  own platform (not a supported path in the initial open-source release).
- [UI-managed releases](ui-managed-releases.md) — build a `.cmpatch` artifact and
  ship it from the web dashboard or the CLI.

The client ↔ server delivery contract is specified in
[`PROTOCOL.md`](../PROTOCOL.md).
