# Codemagic Patch Documentation

Guides for running, operating, and integrating Codemagic Patch. New here? Start with
the [root README](../README.md) for the product overview and the ngrok quickstart; the
end-to-end setup lives on the [documentation site](https://patch.codemagic.io/docs/).

- [Quickstart: try it locally](local-evaluation.md) — run the local evaluation stack
  (server, release worker, PostgreSQL, Silo, dashboard, one-click login) on your
  machine and connect a React Native or Capacitor app to it.
- [Migrate from CodePush](migrate-from-codepush.md) — swap `react-native-code-push`
  for `@codemagic/react-native-patch` and map your CLI workflow to `cmpatch`.
- [Migrate from Appflow Live Updates](migrate-from-appflow.md) — swap
  `@capacitor/live-updates` for `@codemagic/capacitor-patch` and map
  Appflow channels and dashboard actions to deployments and the `cmpatch-capacitor` CLI.
- [Self-hosting with Docker Compose](self-hosting-compose.md) — the on-server
  reference for the self-host stack (one Docker host, Caddy for HTTPS, bundled or
  external PostgreSQL and storage): the installer scripts, their flags, and setups
  the `cmpatch selfhost install` wizard does not cover. For a guided install, start
  with the [Install guide](https://patch.codemagic.io/docs/install).
- [Custom deployment](custom-deployment.md) — reference for operators bringing their
  own platform (not a supported path in the initial open-source release).
- [UI-managed releases](ui-managed-releases.md) — build a `.cmpatch` artifact and
  ship it from the web dashboard or the CLI.

The client ↔ server delivery contract is specified in
[`PROTOCOL.md`](../PROTOCOL.md).
